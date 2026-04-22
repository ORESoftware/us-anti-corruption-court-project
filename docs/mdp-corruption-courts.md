# MDP / Queuing-Control Model — Anti-Corruption Courts

**Created:** 2026-04-18
**Status:** Draft

This document specifies how the Anti-Corruption Court (see
[anti-corruption-court-plan.md](./anti-corruption-court-plan.md)) is modeled as a
**networked queuing system controlled by a Markov Decision Process**, and how that model
maps to (a) a 1:1 discrete-event **simulation** for design and stress-testing, and (b) the
**real-world software system** that enforces the rules, assigns work, captures votes, and
scores judge performance.

It follows the same MDP convention as the other decisioning surfaces in this codebase
([mdp-for-notifs-and-more.md](./mdp-for-notifs-and-more.md),
[mdp-email-outreach.md](./mdp-email-outreach.md),
[mdp-scraping-escalation.md](./mdp-scraping-escalation.md)): decisions are persisted to a
shared log, rewards are reconstructed from downstream outcomes, and policies are trained
against those logs. The domain here is different (legal case flow rather than message
sends), but the skeleton is the same.

---

## 1. Why model it this way

A court is a **multi-stage service network**. Cases enter at filing, move through
intake / investigation / motions / trial / verdict / (optional) appeal, and exit with a
resolution. Judges are the **servers**. Cases are the **jobs**. Both are heterogeneous —
cases vary in signature tier, evidence complexity, defendant count, and public-interest
weight; judges vary in credibility, caseload, and conflict-of-interest history.

Two properties make this a natural fit for MDP-controlled queuing:

1. **Decisions at every stage boundary have long-horizon consequences.** Expediting a case
   now trades verdict speed against panel quality later. Drafting more judges relieves
   pressure this month but dilutes the stipend pool and the prestige signal over the year.
   A policy that is myopic per-stage will underperform a policy that optimizes the whole
   trajectory.
2. **The state is observable.** Queue lengths, judge availability, credibility
   distributions, case ages, appeal outcomes, and bias-audit results are all measurable.
   Classical queuing theory with routing + admission control + server-pool sizing covers
   most of the dynamics; the MDP layer is for the **sequential control decisions** that
   can't be solved in closed form (priority, expedite, scale-out, reassignment under
   conflict).

The model is a **Jackson-network-style queuing system with a controller** — where the
controller is the MDP.

---

## 2. Queuing network topology

### 2.1 Stages (nodes)

Every filing, once admitted, traverses some subset of the stages below. Each stage is its
own queue with its own server pool drawn from the main 1,000+ judge pool (subject to the
per-stage rotation rule in §4 of the court plan).

| #  | Stage                       | Served by                              | Typical duration | Skippable?         |
| -- | --------------------------- | -------------------------------------- | ---------------- | ------------------ |
| 0  | Intake / KYC / signature    | Software + intake reviewers (non-judge)| hours–days       | never              |
| 1  | Complaint screening         | 1 judge (written recommendation)       | 1–2 weeks        | only on auto-reject|
| 2  | Collision review            | 3-judge panel (re-litigation check)    | days             | skipped if no hit  |
| 3  | Preliminary investigation   | 1 judge + investigator staff           | 2–8 weeks        | Screen-tier exits  |
| 4  | Pretrial motions            | 1 judge                                | 2–6 weeks        | skipped on default |
| 5  | Trial                       | 15-juror panel                         | 1–4 weeks        | never if reached   |
| 6  | Deliberation & verdict      | same 15-juror panel                    | 1–14 days        | never              |
| 7  | Appeal (optional)           | fresh 5-judge panel                    | 4–12 weeks       | only if requested  |
| 8  | Disbursement & publication  | Software + escrow custodian            | days             | never              |

Stages 1, 2, 3, 4, 5+6, 7 each draw from the judge pool independently, with a **rotation
constraint**: no judge who served at stage *k* on a case is eligible for stage *k'≠k* on
the same case. This is the Lava-Jato defense from §4 of the court plan, and it is a hard
constraint on the MDP's action space, not a soft penalty.

### 2.2 Arrivals

- **Arrival process:** filings arrive as a **non-homogeneous Poisson process** with rate
  that depends on news cycle, seasonality, and political events. For simulation purposes
  this is fitted from historical complaint volumes at adjacent institutions (SEC OIG,
  state ethics boards, bar disciplinary bodies) plus an elasticity term on media signal.
- **Case classes:** each filing carries its tier (Screen / Inquiry / Trial-*n*), its
  defendant count, an evidence-complexity score derived from intake, and a conduct
  archetype (from the case-study catalog in §0 of the court plan). These are the
  **features** the MDP controller reads.

### 2.3 Service

- **Service-time distribution** per stage is modeled per-judge, not globally — a judge's
  throughput at a given stage is a distribution learned from their history once they've
  served enough cases. Until then, they're assigned a pool prior.
- **Abandonment** happens when signer/sponsors withdraw pledges during the signing window, or
  when a case is dismissed at screening. These are absorbing states.

---

## 3. MDP formulation

Same shape as [mdp-types.ts](../src/server/subroutines/mdp/mdp-types.ts): `(state, action,
reward, next_state)` tuples persisted to `mdp_decisions` with a new `surface =
'court_flow'` value, and matching outcome rows in a new `court_flow_outcomes` table.

### 3.1 State

`CourtFlowState` is built per **decision point**, not per tick. A decision point is any
moment the controller must choose: a case arrives, a case finishes a stage, a judge
finishes their shift, a monthly staffing review fires, or a credibility-score refresh
completes. States are computed by a `buildCourtFlowState({ now, triggerKind, … })`
subroutine analogous to `buildUserState` in the notif code.

System-level features:

- `queueLengths[stage]` — current backlog at each stage.
- `meanWaitByStage[stage]` — rolling 30-day average wait time.
- `judgePoolSize` — total judges currently in good standing.
- `activeJudgesByStage[stage]` — judges currently seated on a case at that stage.
- `conflictStrikeRate` — fraction of random draws rejected for COI in the last 30 days
  (a leading indicator that the pool is too small or too entangled).
- `appealOverturnRate_30d` — rolling overturn rate; a proxy for trial-panel quality.
- `biasAuditScore` — a composite from the oversight board's recent audits (see §7).

Per-case features (for per-case decisions):

- `tier`, `sponsorCount`, `escrowBalance`.
- `conductArchetype` (one-hot over the catalog).
- `defendantCount`, `evidenceComplexity`.
- `age` — hours since filing accepted.
- `stage` — current stage.
- `publicSalience` — a normalized media/signer/sponsor-growth metric.
- `priorExpedite` — has this case already been fast-tracked?

Per-judge features (for assignment decisions):

- `credibilityScore` — see §7. Live scalar, updated after every case they serve on.
- `caseloadNow` — concurrent cases at any stage.
- `stageFitVector` — one-hot over stages the judge has been pre-certified to handle.
- `tenureYears` — time since commission.
- `conflictVector` — computed per candidate case on demand (defendant, firm,
  beneficial-owner overlap).

---

### 3.2 Actions (the controls)

Actions are grouped by **who the decision is about**. The controller is not a single
monolith — it's a set of policies that share features and a shared reward signal, just
like the per-send / per-source split in [mdp-email-outreach.md](./mdp-email-outreach.md).

#### A. Admission & routing (per incoming filing)

| Action                     | Effect                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `admit_standard`           | Normal queue; all stages                                          |
| `admit_expedited`          | Flag for priority; shortened stage SLAs (see §4)                  |
| `admit_consolidated`       | Merge with an existing open case on same (defendant, conduct)     |
| `admit_screening_only`     | Screen tier — never reaches trial regardless of signer/sponsor growth     |
| `hold_for_signature_ramp`  | Pause the timer; collect more signatures to graduate tier         |
| `reject_frivolous`         | Auto-dismiss with refund (low-confidence cases only; appealable)  |

#### B. Case priority (per case, re-evaluated at each stage exit)

| Action                | Effect                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `priority_normal`     | FIFO                                                                  |
| `priority_expedite`   | Move to head of stage queue; trigger (A) shortened SLAs going forward |
| `priority_standard_plus`| Between normal and expedite; used when salience rises mid-case      |
| `defer_to_reserve`    | Move to slow queue (rarely — only when case is blocked on evidence)   |

Expedited cases can skip the Pretrial-motions stage when there are no motions pending,
and can compress Preliminary investigation from an 8-week ceiling to a 3-week ceiling.
The MDP learns when expediting is worth the panel-quality risk.

#### C. Server-pool control (system-wide, runs on monthly cadence + emergency trigger)

| Action                    | Effect                                                                |
| ------------------------- | --------------------------------------------------------------------- |
| `pool_hold`               | No hiring, no attrition action                                        |
| `pool_draft_external_n`   | Draft *n* new judges from the credentialed waitlist                   |
| `pool_activate_reserve_n` | Move *n* reserve-status judges (part-time) to active                  |
| `pool_furlough_n`         | Pause *n* active judges (opt-in; for capacity smoothing, not discipline)|
| `pool_terminate_bottom_10pct` | End of 3-year tenure review — only fires for judges past the cliff|
| `stage_reassign_judge`    | Certify an existing judge for an additional stage (training cost)     |

Drafting external judges is the "more servers" lever from M/M/c queuing. The MDP learns
when wait times justify the dilution cost — every new judge reduces the per-judge
case count (good for fatigue, good for capacity) but also reduces the per-case stipend
share if the budget is fixed (bad for prestige signal).

#### D. Assignment (per stage entry, per case)

| Action                        | Effect                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `assign_random_from_eligible` | Default; commit-reveal lottery from conflict-cleared judges     |
| `assign_weighted_by_cred`     | Bias draw toward higher credibility (reserved for high-tier)    |
| `assign_reserved_for_archetype`| Restrict draw to judges certified on this conduct archetype    |
| `reassign_due_to_conflict`    | Same as above, but after a COI strike mid-case                  |

Assignment is the single most sensitive surface. Anything non-random must be **auditable
and pre-registered** — the policy is published before it runs, and every draw's eligible
pool + RNG seed is recorded on a public ledger (commit-reveal; same mechanism as the
15-juror lottery). The MDP never gets to "pick a judge" — it picks a **rule**, and the
rule draws randomly within its filter.

#### E. Jurors (per trial)

| Action                 | Effect                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| `panel_size_15`        | Default 15 jurors, 12-of-15 supermajority                             |
| `panel_size_21_high_tier`| 21 jurors for Trial-5+ tier cases; 17-of-21 threshold               |
| `seq_partial`          | Jurors sequestered only for deliberation                              |
| `seq_full`             | Full-trial sequester (rare; used for threatened-defendant cases)      |

Larger panels for higher-signal cases make the verdict more robust to outlier jurors but
cost more stipends and reduce parallel-case capacity. This is a direct throughput-vs-
legitimacy tradeoff the MDP learns.

---

### 3.3 Reward

The reward is **reconstructed from outcomes** — no reward at decision time, same as the
notif and outreach MDPs. Outcomes trickle in over months; training batches wait for
cases to close plus an additional appeal window before computing returns.

Per-case return (negated costs, positive credits):

- `+V_verdict_confidence` — a calibrated measure of how certain the verdict looks in
  retrospect, derived from: appeal outcome, bar-referral acceptance, absence of later
  exonerating evidence, and post-verdict peer review (§7.4). A reversed verdict on appeal
  is `-V`.
- `-C_wall_clock_age` — linear in days from filing accepted → verdict posted. Tunable
  coefficient per tier (higher tiers get more weight on speed).
- `-C_stipend_spend` — actual stipend + operating cost on this case.
- `-C_appeal_spend` — if appealed, the cost of the appeal panel.
- `-C_recusals_mid_case` — each mid-case reassignment is a red flag (bad draw).
- `+B_precedent_value` — set non-zero only for cases flagged by editors as establishing a
  new archetype, calibrated through peer survey.
- `-P_bias_incidents` — if a post-hoc audit flags a juror or assignment pattern on this
  case, a heavy negative reward.

System-level return (computed monthly, attributed back to pool-control actions):

- `-E[wait_time]` — mean and tail (p95) wait at each stage.
- `+throughput` — cases/month reaching verdict.
- `-attrition_irregular` — judges leaving the pool for reasons other than term expiry,
  especially if clustered (a signal that something in the system is pushing them out).
- `-capture_risk_index` — a composite that spikes when any of: appeal-overturn clusters
  on one judge's cases, suspicious correlation between vote patterns and defendant
  identity, or unusual COI patterns.

The return weights are a governance decision, not an ML decision — they're set by the
oversight board and versioned. The MDP learns a policy **given the weights**; the weights
themselves are not tuned on past verdicts, to prevent the system from learning to prefer
whatever the historical majority already preferred.

---

## 4. Expedite mechanism (detail)

The user asked specifically about expedited/fast-track as a control, so it's worth
spelling out. Expedite isn't "jump the queue" — it's a **bundle of shortened SLAs**
selected by the MDP when a case's salience × evidence-completeness × public-interest
product crosses a threshold.

Components of an expedited track:

- **Intake SLA:** 48h instead of up to 2 weeks.
- **Screening SLA:** 5 days instead of up to 2 weeks.
- **Investigation ceiling:** 3 weeks instead of 8.
- **Motions window:** compressed; a single motions judge instead of sequential filings.
- **Panel seating:** prioritized in the monthly lottery batch.
- **Appeal reserve:** higher fraction of escrow pre-committed (so expedite doesn't
  sacrifice appeal quality).

What expedite does **not** change: the 15-juror panel, the 12-of-15 supermajority, the
rotation rule, the conflict disclosure requirements, the public docket. Those are
structural guarantees the MDP is forbidden from touching.

The MDP's action is binary (`admit_expedited` y/n at filing; `priority_expedite` y/n at
each later decision point). The SLA bundle is a fixed side-effect of that choice so that
plaintiffs and defendants can read the policy rather than having a different compressed
schedule per case. Predictability is part of the legitimacy story.

---

## 5. Dynamic staffing (detail)

Same goal as autoscaling a server pool — but with multi-year lead time on "new servers,"
because onboarding a new judge involves credentialing, CLE, conflict mapping, and public
announcement.

The controller runs two loops:

1. **Monthly pool-sizing review.** Given the state (backlog trend, wait-time p95,
   arrival forecast over the next 6 months), choose one of the `pool_*` actions. Drafting
   and reserve-activation have ~8-week onboarding lag; furlough is immediate. The MDP
   learns the **lead-time-aware** policy — you draft before you need them, because by the
   time the queue is visibly bad it's already 8 weeks too late.

2. **3-year tenure review (the "cliff").** On each judge's 3-year commission anniversary,
   the system evaluates their credibility score distribution against the population of
   peers who served over the same window (controls for cohort effects and case-mix
   heterogeneity). Judges in the **bottom 10%** of the peer cohort are not renewed. This
   is a hard rule baked into the commission terms — the MDP doesn't decide *whether* to
   drop them, it only decides *when to draft replacements* and *how many* given the
   upcoming attrition. Judges dropped at the cliff retain alumni status; they just don't
   sit on new cases.

   Two guardrails on the cliff rule:
   - **Appealable.** A dropped judge can request a peer-panel review of their score
     components. The review can reinstate them if their score was dragged down by
     structural factors (e.g., disproportionate assignment to bench trials on a
     particularly contentious archetype).
   - **Floor on the floor.** If the bottom 10% of the cohort is still scoring above a
     published absolute threshold, none are dropped that year — the cliff is relative
     *and* absolute. Otherwise the rule punishes judges for being in a cohort of
     high performers.

Dynamic staffing + the cliff together produce a pool that **stays at target
throughput while slowly raising average quality**. The MDP learns to counter-cycle: draft
during low-attrition months so the cliff's annual drop doesn't cause a capacity shock.

---

## 6. Judge compensation

Compensation is a **governance-set schedule**, not an MDP-controlled action. The MDP is
the vehicle for **evaluating** candidate schedules in simulation — given a proposed
retainer + per-case + multiplier structure, what do throughput, wait times, attrition,
and quality look like? — but the schedule itself is a policy lever held by the
oversight board under the transparency rules in §12. Judges see the schedule they
signed up for; it does not change mid-term without a governance action.

The figures below are placeholders. Governance sets the numbers at commissioning and
revisits on the sunset cadence in §12.4.

### 6.1 This is not a GS scale

The instinct for a "government-ish judicial role" is to reach for the General Schedule.
That's wrong for this court, and the wrongness is informative — it tells you what the
court's compensation structure is actually modeled on.

- **Federal Article III judges** (district, circuit, SCOTUS) are on a statutory pay
  schedule set by Congress, with constitutional protection against diminution.
  District ~$250k, circuit ~$265k, SCOTUS associates ~$290k. **Not GS.**
- **Federal Administrative Law Judges** are on the **AL pay schedule** (AL-3 through
  AL-1), set by OPM — specialized, closer to GS in form but structurally separate.
- **Federal magistrate and bankruptcy judges** are on their own schedule pegged to
  district-judge pay.
- **Federal court staff** (clerks, probation officers) are on the **JSP** (Judicial
  Salary Plan). Also not GS.
- **State judges** vary — most states set pay constitutionally or statutorily; a few
  peg to federal judicial pay. Practically no state judges are on GS.
- **GS itself** covers executive-branch (and some legislative-branch) federal civil
  servants. It is a career-employment schedule for permanent civil servants, not a
  professional-service schedule for commissioned judges.

The anti-corruption court's judges are **none of the above**. They're commissioned for
a fixed term to a citizen-funded non-governmental institution (see §1–2 of the court
plan), which means the court runs its own compensation schedule, benchmarked against
but structurally distinct from existing scales:

- **Upper reference** — federal district-judge salary (~$250k). A ceiling for
  Master-tier retainer + heavy case year, not an average target.
- **Lower reference** — ALJ AL-3 step 1 (~$170k). A reference for Senior judges who
  treat the appointment as a primary role; most judges sit well below this because the
  court is designed as a prestige appointment **compatible with an ongoing practice**,
  not as primary employment.
- **Per-case reference** — AAA/JAMS senior-neutral day rates, discounted for public
  service.

This is compensation for public service alongside private practice, not full-time
civil-service employment.

### 6.2 Pool sizing

Steady-state target: **800–1,200 active commissioned judges**, set by:

- Throughput requirements (cases × stages × service-time distribution).
- Rotation-feasibility floor (birthday-problem odds on the per-stage rotation rule;
  see §4 of the court plan — 1,000 is comfortable, 800 is the floor).
- Prestige ceiling (above ~1,200 the individual-appointment signal dilutes).
- Budget envelope (more judges = more total comp, though much of the increase flows
  through the case-scaling per-case component).

The MDP's pool-sizing action (§3.2 C) operates **within** this band. Drafting above
1,200 or furloughing below 800 requires an explicit governance action, not a policy
decision.

### 6.3 Components

Four components combined per judge per year.

#### 6.3.1 Annual retainer

Fixed component paid to every active commissioned judge regardless of caseload.
Analogous to a commissioner's stipend or a bar-council honorarium. Paid monthly.

Covers: availability for draws, CLE compliance, conflict-disclosure maintenance, on-call
oversight duty, minimum-participation floor.

Placeholder: **$15,000–$30,000/year**, tiered by seniority band (§6.3.3).

Purpose: make the appointment real enough that a mid-career practitioner can accept it
without needing to accumulate case stipends to justify participating.

#### 6.3.2 Per-case stipend

Variable component paid per case served on, scaled by **stage** and **case tier**.
Placeholder schedule:

| Stage                          | Screen tier | Inquiry tier | Trial tier |
| ------------------------------ | ----------- | ------------ | ---------- |
| Complaint screening            | $500        | $750         | $1,000     |
| Collision review (3-panel)     | $300        | $300         | $500       |
| Preliminary investigation      | $1,500      | $3,000       | $5,000     |
| Pretrial motions               | $1,000      | $2,000       | $3,500     |
| Trial + deliberation (juror)   | —           | —            | $3,000     |
| Appeal panel member            | —           | $1,500       | $4,000     |

Roughly **$3k for a trial-tier juror** (matching the figure the design started with)
and $5k for a lead preliminary-investigation judge on a trial-tier case. Larger stages
on higher-tier cases earn more because they are more work and higher stakes.

Critical invariants — these are design constants, not governance knobs:

- **No verdict-dependency.** Same stipend regardless of how the judge votes or how the
  case resolves (the stipend-neutrality rule from §5 of the court plan).
- **Paid on case close, not on vote timing.** No incentive to vote faster or slower.
- **Tier-dependent, not defendant-dependent.** Same stipend regardless of who the
  defendant is, who the plaintiff is, or how the case plays in the press.

#### 6.3.3 Seniority tier

Judges sit on a **two-axis band**: years of commissioned service × the coarsened
credibility-score band from §7.

| Band    | Years | Credibility band   | Retainer | Per-case multiplier |
| ------- | ----- | ------------------ | -------- | ------------------- |
| Junior  | 0–2   | any                | $15,000  | 1.00×               |
| Mid     | 2–5   | mid or above       | $20,000  | 1.15×               |
| Senior  | 5–10  | mid or above       | $25,000  | 1.30×               |
| Master  | 10+   | top band only      | $30,000  | 1.50×               |

Band movement:

- **Years** accumulate automatically with good-standing service (no gaming surface).
- **Credibility band** is the coarsened bucket from §7.2 — four buckets, not the raw
  score, so small score shifts don't translate into comp volatility. Refreshed
  annually.
- **Down-movement.** A Master who falls out of the top band moves to Senior on the
  next annual refresh, with a 1-year grace before it takes effect. Single-case
  panic does not move bands.
- **Cliff interaction.** Non-renewal at the 3-year cliff (§5) terminates seniority
  tracking entirely; alumni status only. A mid-term band downgrade does not by
  itself trigger non-renewal — cliff is its own track.

Seniority is **not outcome-tied**. It is tenure + cred-band. Cred-band reflects
appeal calibration, procedural rigor, and peer-review ratings — not verdict
direction (§7.3).

#### 6.3.4 Role multipliers

Additional compensation for specific in-case roles:

- **Presiding juror** (elected by the trial panel at outset): 1.25× juror stipend
  for that case.
- **Opinion author** on a panel publishing a named precedent-setting opinion: flat
  $2,000 premium.
- **Peer reviewer** on a post-verdict review panel (§7.4): $500 per case reviewed.
- **Oversight board member**: additional $40,000/year retainer on top of ordinary
  judge comp; board service is capacity-bounded (reduced caseload), so a board member's
  total comp is roughly flat against a Master tier without board duty.

### 6.4 Worked examples

A **Senior-tier judge** (5–10 years, mid+ credibility) serving ~10 cases/year:

- Retainer: $25,000
- Per-case base: 4 screenings × $1,000 + 2 preliminary investigations × $5,000 +
  3 trial-jury services × $3,000 + 1 appeal × $4,000 = $27,000
- Tier multiplier (1.3×): $27,000 → $35,100
- Presiding-juror once: +$750
- **Total: ~$60,850/year**

A **Junior-tier judge** (0–2 years) serving ~6 cases/year, mostly on screenings and
collision reviews:

- Retainer: $15,000
- Per-case: 5 screenings × $500 + 1 collision review × $300 = $2,800
- Tier multiplier (1.0×): $2,800
- **Total: ~$17,800/year**

A **Master-tier judge** (10+ years, top band) heavily case-loaded at ~15 cases/year
with trial-tier emphasis:

- Retainer: $30,000
- Per-case base: ~$50,000 (heavy trial + appeal mix)
- Tier multiplier (1.5×): ~$75,000
- Opinion-author once: +$2,000
- **Total: ~$107,000/year**

Range across the pool is roughly **$15k–$150k/year**, deliberately compatible with
continued practice at every tier.

### 6.5 Total pool budget

At mid-estimates, **1,000 judges × average ~$40k total comp ≈ $40M/year** in judicial
compensation, plus:

- Oversight-board premiums, peer-review stipends, opinion-author premiums: roughly
  $3–5M.
- One-time draft/credentialing costs per pool-draft action: variable.

Judicial compensation is the primary line item in the court's operating budget. It is
deliberately sized to be **covered at steady-state by the signer/sponsor-pledge escrow
system** — per-case stipends scale with case volume, which scales with signer/sponsor pledges.
The **retainer is the load-bearing fixed cost**, which must be funded from non-case
sources (operator endowment, recoveries, public-findings enforcement fees); see §2 of
the court plan for 501(c) treatment and §12.1 for funding-diversification caps (no
single funder > 5% of operating budget in a rolling 12-month window).

### 6.6 Decision points

| Decision                                | Decider                             | Cadence                                    |
| --------------------------------------- | ----------------------------------- | ------------------------------------------ |
| Retainer amount per seniority band      | Oversight board (2/3 supermajority) | Sunset-bound (5y) + COLA annual            |
| Per-case stipend schedule               | Oversight board                     | Sunset-bound + COLA annual                 |
| Seniority-band thresholds               | Oversight board                     | Sunset-bound                               |
| Role-multiplier values                  | Oversight board                     | Sunset-bound                               |
| Credibility-band cutoffs (coarsening)   | Oversight board                     | Sunset-bound                               |
| Pool size within [800, 1200]            | MDP pool-sizing (§3.2 C)            | Monthly                                    |
| Pool size outside [800, 1200]           | Governance action                   | Explicit                                   |
| Individual seniority advancement        | Deterministic (tenure + cred-band)  | Annual refresh                             |
| Oversight-board member premium          | Governance charter                  | Charter-set; amended by supermajority       |

The MDP does **not** set compensation levels. Its job is to evaluate candidate
schedules in simulation and report forecasts to the oversight board ahead of scheduled
revisions. Governance picks the schedule; the controller optimizes given it — same
separation as the reward-weight setting in §11.1.

### 6.7 Incentive hygiene

Compensation is a prime capture surface. Relevant guards from §12:

- **No outcome-dependency.** Same stipend win or lose, written into the published
  schedule.
- **No discretionary case bonuses.** Opinion-author premium is structural, triggered
  by publication-of-named-opinion, not by case-political discretion.
- **Fully published schedule.** Every dollar a judge can earn in each band is
  publicly readable; defendants, plaintiffs, and signer/sponsors can verify.
- **Outside-compensation disclosure.** Speaking fees, consulting to affected
  industries, expert-witness work — all disclosed; may trigger COI strikes on related
  cases.
- **Post-service cooling-off.** The non-solicit in §12.1 prevents compensation deferred
  into a post-service job offer from the defendant class.
- **No individual-judge rate negotiation.** The schedule is uniform within bands;
  no judge can negotiate a custom rate for themselves or a specific case.

---

## 7. Judge credibility score

A live scalar per judge, updated after every case they serve on, used for:

- **Prestige signal.** Score tier appears on the public docket next to each case
  (coarsened into bands, not raw values, to protect against narrow comparisons).
- **Assignment filtering** for high-tier cases via `assign_weighted_by_cred`.
- **The 3-year cliff** as described in §5.
- **Peer-review eligibility** — only judges in the top tier can sit on review panels for
  dropped judges' appeals, for appeal panels on high-tier cases, and for the oversight
  board.

### 7.1 Inputs (per-case updates)

Each case the judge participates in contributes a signed update to their score. Inputs
are weighted by the judge's role on that case (panel juror, sole screener, appeal
reviewer, etc.).

| Input                                          | Sign | Rationale                                          |
| ---------------------------------------------- | ---- | -------------------------------------------------- |
| Appeal affirmed (they were on trial panel)     | +    | Verdict held up                                    |
| Appeal reversed                                | −    | Verdict didn't hold up                             |
| Vote aligned with eventual supermajority       | +    | Calibration with peers                             |
| Vote was a holdout that later peer-reviewed as sound | +| Rewarding legitimate dissent on close cases        |
| Vote was a holdout that later peer-reviewed as poorly reasoned | − | Punishing noise               |
| Case closed on time (no stage was the bottleneck) | +  | Throughput                                         |
| Case had a mid-stage COI strike involving this judge | − | Missed a conflict at disclosure                 |
| Clerk / opposing counsel procedural-rigor rating | +/− | Peer-observable behavior in chambers              |
| Bias-audit flag on this case attributable to this judge | − | Governance signal                            |

### 7.2 Mechanics

- **Exponential moving average** (per role) with a half-life tuned so that ~2 years of
  behavior dominates the score but single-case shocks don't dominate.
- **Normalized per cohort** so that a judge seated in a year of only hard cases isn't
  punished relative to a judge seated in a year of easy screenings.
- **Floor and ceiling** to prevent runaway — even a perfect streak tops out; even a bad
  streak has a visible floor before triggering non-renewal.
- **Opacity to the judge mid-case.** The judge sees their score on a monthly refresh,
  not in real time during a trial, so they can't juke votes to match the expected
  supermajority.

### 7.3 What credibility is deliberately NOT used for

- Not used to weight votes on a live panel — 12-of-15 counts every vote equally.
- Not used to decide admission / rejection of a filing.
- Not visible to plaintiffs or defendants picking or striking jurors (there is no
  striking for credibility — only for conflict).
- Not used by the MDP to bias random draws in any way except for the pre-registered
  `assign_weighted_by_cred` filter on specific high-tier actions.

### 7.4 Post-verdict peer review

Every closed case is randomly sampled (~10% of cases, plus all cases with a dissent, plus
all appealed cases) for **peer review by a separate panel of 3 high-credibility judges**
who did not serve on the case. They rate: panel reasoning quality, procedural rigor, and
whether any assignment or conflict issue is visible from the record. Their ratings feed
the credibility updates and the bias-audit score. Peer reviewers themselves earn a
(smaller) credibility contribution for participating.

---

## 8. 1:1 discrete-event simulation

The simulation is **agent-based at the individual entity level**. Not "arrivals/day
follow this distribution, service times follow that distribution, compute mean queue
length." Instead:

- Each **case** is an object with its own features, history of stages, escrow record,
  signer/sponsor list.
- Each **judge** is an object with their own service-time distribution (learned or
  prior), credibility score, conflict history, caseload, tenure clock.
- Each **signer/sponsor** is an object with their own pledge, verification state, follow-on
  behavior (re-pledge at graduation, withdrawal, etc.).
- Each **defendant** is an object with their own history of filings, prior panel
  compositions, and network of associates used to compute COI at random draws.

Why 1:1 and not aggregated:

1. **Network effects dominate.** Assignment constraints (rotation + COI) depend on who
   has served on related cases — you can't capture that with Poisson arrivals on a
   Jackson network. The birthday-problem risk on a pool of 1,000 is only meaningful when
   you simulate the individuals.
2. **The cliff and credibility system are per-individual.** Cohort-relative ranking
   requires individual scores.
3. **Public legitimacy modeling needs individual defendants.** One high-profile
   defendant's case shapes arrival rates for adjacent archetypes. Aggregated models erase
   that signal.
4. **Policy auditability.** A stakeholder asking "show me the judge who was reassigned
   three times in Q2 and why" gets a real answer instead of a summary statistic.

### 8.1 Simulation engine

Discrete-event simulation with a priority queue over scheduled events. Event types:

- `case.filed`, `case.signature_ramped`, `case.accepted`, `case.rejected`
- `stage.entered`, `stage.exited`, `stage.blocked`, `stage.expedited`
- `judge.assigned`, `judge.struck_for_conflict`, `judge.reassigned`
- `vote.cast`, `verdict.rendered`, `verdict.appealed`, `verdict.final`
- `credibility.updated`, `pool.draft`, `pool.cliff_review`, `judge.non_renewed`
- `oversight.audit`, `oversight.flag`

Time resolution: 1 hour (fine enough for intake, coarse enough that months of
wall-clock simulate fast). Calendar effects (weekends, holidays, court recess) are
modeled — judges don't serve on Thanksgiving weekend, and that affects measured wait
times the MDP optimizes against.

Run configurations:

- **Shadow mode:** historical arrivals replayed; policy chooses actions; rewards
  compared against the logged baseline.
- **Counterfactual:** same arrivals, different policy, compare outcomes.
- **Stress:** arrival rate × *k*, evidence complexity × *k*, pool size × *k*, see where
  each policy breaks.
- **Attack:** inject adversarial patterns — coordinated defendant groups, captured
  judges, signer/sponsor astroturfing — and measure how quickly the audit / credibility system
  detects them.

Outputs flow into the same `mdp_decisions` + outcomes tables as the other surfaces, so
the trainer infrastructure from [mdp-for-notifs-and-more.md](./mdp-for-notifs-and-more.md)
can be reused with a new `surface = 'court_flow'` partition.

---

## 9. Real-life software system

In production the same controller runs live. It is **not** a recommender that a human
court administrator approves case-by-case — it's the authoritative system of record
that enforces the rules, because every action the controller can take is one that has
been pre-registered and audited. Humans enter the loop at the governance layer (setting
reward weights, approving policy updates, running audits), not at the per-case layer.

### 9.1 Subsystems

1. **Intake & signature ledger.** Web filing form, KYC, signature collection window,
   escrow hold, conduct-fingerprint computation, collision search against the prior
   docket. Off-the-shelf Stripe Treasury / bank-partner integration per the escrow
   section of the court plan.
2. **Assignment engine.** Commit-reveal lottery per stage per case. Inputs: eligible
   pool filter (rotation rule + COI check + credibility filter if applicable), public
   RNG seed (committed before the draw, revealed after). Outputs: assignment record
   published to public ledger.
3. **Stage workflow engine.** Drives cases through stages per their SLA bundle
   (standard or expedited). Triggers deadlines, escalates blocks to the
   oversight board.
4. **Voting system.** Captures per-juror votes with cryptographic commitments (so
   individual votes stay sealed for the cooling-off period but the tally is verifiable).
5. **Credibility scoring pipeline.** Runs nightly. Consumes case-close events, peer
   reviews, appeal outcomes, audit flags. Writes to the `judge_credibility` table with
   a full audit trail.
6. **Policy controller (the MDP).** Runs on a schedule per action class:
   - Per-filing (admission, priority): on arrival.
   - Per-stage-transition (priority re-eval, assignment-rule choice): as each stage exits.
   - Monthly (pool-sizing): scheduled.
   - Per-judge-anniversary (cliff review): scheduled.
7. **Oversight dashboard & audit tooling.** Public and internal views over queue
   depths, wait-time distributions, assignment-ledger searches, appeal patterns, and
   credibility distributions. Audits run on a cadence and on ad-hoc query.
8. **Governance interface.** Controlled write access (quorum-gated) for updating reward
   weights, onboarding/offboarding the pool, policy version rollouts, and the published
   case-study catalog.

### 9.2 Determinism & auditability

Every action the software takes is either:

- **Deterministic, given the current state + public rules** — anyone with the rules and
  the state can reproduce the action, or
- **Random with a published commit-reveal seed** — anyone can verify the action was drawn
  fairly.

The MDP policy itself is a file with a version hash, pinned to every decision it makes.
A new policy can be shadow-evaluated against logged decisions before it's allowed to
write. Policy rollouts require governance-board sign-off; the rollout itself is staged
(shadow → canary cases → full) using the same pattern as `mdp-notif-executor.ts` in this
codebase.

### 9.3 What the software explicitly does NOT do

- Does **not** pick who wins. It routes cases and assigns judges randomly within
  pre-registered filters; juries vote; the supermajority rule is computed on those votes.
- Does **not** rate the quality of evidence. Humans do that, at the screening and
  trial stages.
- Does **not** adjust reward weights on its own. Governance does, with a paper trail.
- Does **not** act on credibility scores in ways not enumerated in §7.3.

This boundary matters for the court's legitimacy story: an AI does not decide corruption
cases. An AI runs the **logistics** of corruption cases, and every piece of logistics it
runs is verifiable after the fact.

---

## 10. Training & evaluation

Mirrors the pattern in [mdp-for-notifs-and-more.md](./mdp-for-notifs-and-more.md):

- **Behavior cloning** from the current hand-tuned baseline as a cold start (same
  approach as the notif MVP's linear scorer).
- **Offline policy evaluation** (OPE) against logged decisions: importance-weighted
  returns, doubly-robust estimators. Standard batch RL plumbing.
- **Shadow deployment** on live traffic before any writes.
- **Canary cases** — a small fraction of low-tier screening decisions — before full
  rollout, with per-outcome monitoring and auto-rollback on regressions.
- **Governance gate.** No policy reaches live without an approval record and a
  published diff against the previous policy.

Training avoids two specific pitfalls:

1. **Don't train on verdict outcomes as the primary reward.** That teaches the policy to
   route cases toward whichever judge-composition most often convicts (or most often
   acquits), which is exactly the capture failure mode this court is designed to
   resist. Instead, reward `verdict_confidence` — calibrated by appeal + peer review —
   which is agnostic to which direction the verdict went.
2. **Don't over-reward speed.** Wall-clock is a cost, but trading panel quality for speed
   destroys legitimacy. The tier-weighted coefficient on `C_wall_clock_age` is small at
   trial tiers and larger at screening, matching the relative cost of delay at each
   stage.

---

## 11. Learning loop & policy evolution

The system has to get **better** over time, not just run. Better means: shorter wait
times without losing verdict confidence, lower capture-risk index, fewer mid-case
reassignments, better-calibrated expedite decisions, better-tuned pool sizing. That's a
reinforcement-learning problem, but it is an RL problem with unusually severe
constraints — real cases are at stake, outcomes take months to arrive, and the cost of a
bad policy going live is enormous. The loop below is designed around those constraints.

### 11.1 What gets learned vs. what stays fixed

Learned from data:

- Action-value estimates `Q(s, a)` for every action class in §3.2 — admission, priority,
  pool sizing, assignment filter, panel size.
- Feature weights / representations — which state features actually predict good
  outcomes, given evolving arrival patterns and new archetypes.
- Service-time distributions per judge per stage — updated as each judge accumulates
  history, replacing the pool prior.
- Expedite threshold — the salience × completeness × public-interest cutoff for
  recommending `admit_expedited`.

**Hard-coded, never learned:**

- The rotation rule, the 12-of-15 supermajority, the commit-reveal lottery, the
  (defendant, conduct, time-window) scoping rule, the escrow disbursement rules. These
  are structural guarantees.
- The reward **weights**. Those are a governance decision; the policy optimizes given
  weights, it does not tune weights to past verdicts.
- The list of admissible actions. New actions require a governance-board action, not a
  training-run inference.

This split is load-bearing: it is what lets the system learn aggressively on logistics
without learning anything that could be framed as "the AI shaped outcomes."

### 11.2 Algorithm stack

The court's MDP is discrete-action, partially observable, long-horizon, with reward
signals that take weeks to months to arrive. That argues for **offline / batch RL** as
the workhorse, with targeted online updates on short-horizon decisions.

| Decision surface          | Algorithm                                                           | Why                                                |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| Admission & routing       | Conservative Q-Learning (CQL) on logged `mdp_decisions`             | Pessimistic wrt. out-of-distribution actions — safe|
| Case priority re-eval     | Fitted Q-Iteration with a boosted-tree Q-head                       | Small action set, features tabular-friendly       |
| Pool sizing (monthly)     | Model-based RL on the sim (policy gradient over simulator rollouts) | Action is infrequent; sim is cheap vs. real trials |
| Assignment-rule selection | Contextual bandit (rule-level, not judge-level)                     | Rules, not individuals — no credit assignment over time |
| Panel size                | Contextual bandit with fairness constraint                          | Single decision per case, long-delayed reward      |

A single **shared feature encoder** feeds all heads (same pattern as the shared
featurizer in [mdp-email-outreach.md](./mdp-email-outreach.md)). The encoder is the
thing that benefits most from growing data volume — more cases means better
representations of archetypes, judges, and defendants. The heads themselves are
intentionally small and interpretable.

Q-learning specifically is applied to the sequential surfaces (admission, priority,
pool). For each, a candidate policy is produced by a training run, then fed through the
evaluation pipeline in §11.3 before it's allowed anywhere near live traffic.

### 11.3 Evaluation pipeline — sim before real

A new policy does not touch live cases until it has cleared every gate below. Each gate
writes a signed artifact; no gate can be skipped without a governance-board override on
the record.

1. **Offline policy evaluation (OPE) on logged decisions.**
   Doubly-robust and weighted importance-sampling estimators against the existing
   `mdp_decisions` log. A candidate policy that does not OPE-beat the current policy on
   the headline reward — with a confidence interval, not a point estimate — is
   discarded. Standard batch-RL hygiene.

2. **Simulator evaluation — matched historical replay.**
   Replay the last *N* months of logged arrivals through the 1:1 simulator with the
   candidate policy in charge. Compare: mean and p95 wait by stage, verdict-confidence
   distribution, appeal-overturn rate, capture-risk index, judge attrition. The
   candidate must win on the headline metric without losing ground on any
   legitimacy-critical metric.

3. **Simulator evaluation — synthetic stress.**
   Same as above but with arrival rate × 2, evidence complexity × 2, pool size × 0.7,
   and a handful of scripted shocks (news-cycle spike, captured-judge implant,
   coordinated defendant network). A good policy on average history can still fail on
   tail conditions; tail conditions are what the policy actually needs to survive.

4. **Adversarial / attack suite.**
   Red-team policies — adversaries try to game the policy: astroturfed signer/sponsors, strategic
   filing timing, defendant network manipulation. The policy's capture-risk index must
   stay below threshold; if an adversary can reliably get a case routed to a specific
   judge, the policy fails.

5. **Fairness & disparate-treatment audit.**
   For every defendant archetype (from the catalog), wait times, expedite rates,
   assignment pool sizes, and outcome distributions must be within published bounds of
   each other. A policy that speeds up average wait by 30% but does it by systematically
   deprioritizing one archetype is not a better policy.

6. **Shadow deployment on live traffic.**
   Policy runs in parallel with the current policy on real cases, writes its proposed
   actions to the decision log **without executing them**. A minimum shadow period
   (weeks) plus a minimum case-count floor before the next gate.

7. **Canary — low-stakes cases only.**
   The candidate is allowed to execute on `admit_screening_only` tier actions and on
   pool-sizing decisions with a small `n`. Not on Trial-tier assignments, not on panel
   composition, not on expedite decisions. Monitoring dashboard with pre-defined
   regression triggers and automatic rollback.

8. **Staged rollout.**
   Expand the action classes the new policy controls one at a time, each with its own
   canary window. Trial-tier expedite and assignment-rule selection are the last
   classes to get promoted, because those are the ones with the highest legitimacy
   exposure.

9. **Governance approval.**
   Final approval from the oversight board, with the full evaluation artifact pack,
   before the policy replaces the incumbent. Every transition is recorded with policy
   version hash, author, evaluation bundle hash, and sign-off signatures. Rollback is a
   single pointer flip.

### 11.4 Online learning vs. batch learning

Two cadences run in parallel:

- **Batch (primary).** Nightly/weekly training runs over the full `mdp_decisions` +
  outcomes log produce candidate policies. These are the candidates that go through the
  full §11.3 pipeline. This is how structural improvements ship.
- **Online calibration (secondary).** Small, tightly-bounded online updates for narrow
  parameters — e.g., the expedite threshold as a function of recent
  p95-wait, or per-judge service-time estimates as new cases close. These are
  **parameter updates** to a pre-approved policy, not new policies. They're bounded in
  magnitude per update and auto-reverted if any regression trigger fires. The set of
  parameters eligible for online update is explicit and small.

No per-decision online gradient updates. No "the system gets smarter during this trial."
Live trials run with a frozen policy.

### 11.5 Non-stationarity & catastrophic forgetting

Arrival distributions drift (new archetypes emerge, news cycles shift, statutes change
what conduct is reachable elsewhere), and a policy trained on last year's distribution
can silently degrade. Defenses:

- **Recency weighting** in training — older log entries decay, but never to zero; some
  hard-won lessons (e.g., how to recognize coordinated signer/sponsor astroturfing) are worth
  keeping even when the phenomenon is currently rare.
- **Archetype-conditioned evaluation.** A policy's reward is broken out per archetype;
  a policy that improves aggregate reward by over-fitting to the dominant archetype
  fails evaluation on the less-dominant ones.
- **Simulator drift detection.** If the real distribution diverges from what the
  simulator models, stress-test the current policy on the new distribution before
  trusting it.
- **Re-evaluation schedule.** Every policy re-runs through §11.3 on a fixed cadence (e.g.,
  quarterly) regardless of whether a new candidate exists, to catch degradation early.

### 11.6 Credit assignment across months-long horizons

The hardest RL problem here: a decision made at filing intake (`admit_expedited` vs.
`admit_standard`) influences a reward that arrives after the trial and appeal, possibly
18 months later. Standard approaches:

- **Reward decomposition.** The per-case return in §3.3 is a sum of terms that arrive at
  different times (cost-of-wait daily, stipend-spend per-stage, verdict-confidence at
  appeal close). Each term is credited to the decisions that were live when it
  accrued, which gives the learner earlier signal than waiting for the full terminal
  reward.
- **Surrogate rewards for early learning.** Proxy metrics that correlate with terminal
  reward but land sooner — e.g., mid-case reassignment rate as a proxy for assignment
  quality. Used carefully; heavy reliance on surrogates risks optimizing the proxy.
- **Simulator-based bootstrapping.** New policies start with most of their training
  signal from the simulator (which can provide terminal rewards in simulated time), and
  shift weight toward the real log as enough real outcomes accumulate.

### 11.7 Learning guardrails

- **No policy writes to live without governance sign-off.** Period. The training
  pipeline produces candidates; it does not deploy.
- **Per-policy version hash pinned to every decision.** Every row in `mdp_decisions`
  names the policy that produced it; rollbacks are verifiable.
- **Auto-rollback on regression triggers.** Pre-registered thresholds on wait times,
  capture-risk index, appeal-overturn rate, and fairness metrics. Trip any one and the
  deployment reverts to the previous version. Rollback takes effect before the next
  decision.
- **Immutable audit log.** Every policy deployment, every training-run artifact, every
  evaluation report is written to an append-only store so future audits can reconstruct
  exactly which policy was in effect for any historical case.
- **Public policy descriptions.** The high-level behavior of the live policy — what
  action classes it controls, what features it uses, what its measured performance
  profile is — is published. Plaintiffs, defendants, and the press can read it. The
  trained weights are not required to be published (they're neither secret nor useful
  on their own), but the behavior is.

The upshot: the system can learn indefinitely, and the rate of learning accelerates as
case volume grows, but every improvement lands through the same gated pipeline.
Capability grows; risk surface does not.

---

## 12. Incentives & checks and balances

An anti-corruption court with captured incentives is worse than no court — it launders
corruption under an official seal. This section is the most important one in the
document, and it's placed late only because it depends on the mechanisms defined above.

The design principle is **offsetting incentives across multiple bodies, none of which is
individually sufficient to decide outcomes, all of which operate in public**. No heroic
person is load-bearing. Capturing any single role breaks one thing; capturing the system
requires capturing several bodies whose members, terms, and selection methods are
structurally incompatible.

### 12.1 Actor-by-actor incentive design

#### Judges

**What they're paid for:** fixed per-case stipend (same regardless of verdict direction);
prestige signal on their résumé; credibility contribution from peer review.

**What they're punished for:** appeal overturns attributable to their panel vote when
peer-reviewed as poorly reasoned; missed COI disclosures; bias-audit flags; non-renewal
at the 3-year cliff if bottom 10% of cohort.

**Perverse incentives to watch:**
- *Majority-chasing to protect credibility.* Fix: the credibility score in §7 rewards
  **calibrated** dissent. A holdout whose reasoning is validated on peer review gains
  score; a holdout whose reasoning is noise loses score. Both votes with the majority
  and dissents are scored on reasoning quality, not on which way they went.
- *Avoiding hard cases.* Fix: random draw from eligible pool — judges cannot decline a
  case except for pre-registered COI or genuine incapacity. Repeated declines
  themselves feed the credibility score.
- *Seeking high-profile cases.* Fix: random draw; nobody campaigns onto a specific case.
- *Capture via future employment.* Fix: post-service non-solicit on the defendant class
  they adjudicated (e.g., 2-year cooling-off before working for any entity named in a
  case they sat on), published and enforceable through bar referral.

#### Plaintiffs (initial filers)

**What they're paid for:** pro-rata share of damages on conviction; public-interest
credit; named plaintiff on precedent-setting filings.

**What they're at risk for:** escrow loss on acquittal (partial refund only);
frivolous-filing dismissal with signer/sponsor disclosure; reputational cost of losing.

**Perverse incentives to watch:**
- *Vexatious/retaliation filings.* Fix: filing fee (their own skin in the game);
  screening tier as a low-cost rejection path; frivolous-filing finding is itself
  published and attaches to the plaintiff's filing history.
- *Strategic timing for political benefit.* Fix: the court does not accelerate or
  decelerate based on election calendars; expedite is driven by salience × evidence
  × public-interest, not by the plaintiff's preferred date.

#### Signer/Sponsors

**What they're paid for:** partial pro-rata share of damages; legitimacy signal for
their preferred case.

**What they're at risk for:** pledge captured on acceptance, only partially refunded on
acquittal; signing counts against their annual giving for deductibility (501(c)(3)
treatment).

**Perverse incentives to watch:**
- *Astroturfing via fake signer/sponsors.* Fix: KYC-light verification at signing; one
  signature per verified natural person per filing; duplicate-detection before escrow
  hold.
- *Paid signer/sponsor coordination.* Fix: pledge-at-risk means paying someone to sign requires
  paying the pledge and accepting the loss exposure. Combined with published donor
  networks (§12.3), coordinated paid signing is detectable.

#### Defendants

**What they're owed:** due process, full discovery, representation of their choosing,
right of appeal, bounded exposure to the (defendant, conduct, time-window) triple, the
right to counterclaim for frivolous filings.

**Perverse incentives to watch:**
- *Running out the escrow via motion practice.* Fix: pretrial motion windows are SLA-
  bounded; running the clock is itself reviewable and can trigger sanctions.
- *Out-of-band influence on judges.* Fix: per-stage rotation, commit-reveal assignment,
  public docket of the eligible pool at each draw, whistleblower channel for judges
  approached improperly. Any judge reporting a contact gets a credibility bonus and
  mandatory reassignment.

#### Peer reviewers

**What they're paid for:** small stipend; smaller credibility contribution for
participating; the status of serving on the oversight tier.

**Perverse incentives to watch:**
- *Collegial leniency.* Fix: reviewers are drawn randomly from the high-credibility
  pool, must not have served on any stage of the reviewed case, cannot have co-served
  with the reviewed judge more than *k* times in the last 2 years. The reviewer's own
  score partially depends on later audit agreement with their review.

#### Oversight board

**Composition:** 9 seats, 3-year staggered terms, 2-term limit:
- 4 seats drawn from top-credibility active-judge alumni (rotating)
- 3 external civic seats: bar association appointee, retired federal judge, academic
  ethicist (or equivalent)
- 2 publicly-elected signer/sponsor-representative seats (elected by the verified signer/sponsor
  population; rotation, not recall)

**Powers:** approve reward-weight changes (2/3 supermajority); approve policy
deployments; authorize bias audits; receive whistleblower reports; publish annual
state-of-the-court report.

**Anti-capture:**
- Staggered terms ensure a full board turnover takes 6 years even under unanimous
  replacement attempts.
- 2/3 supermajority to act means a simple 5-4 capture cannot move weights.
- External seats cannot be majority-aligned with internal seats by design.
- All board votes are public; minority dissents are published with rationale.

#### Policy / software team

The humans who write the MDP, maintain the simulator, deploy policy versions, and run
the infrastructure.

**Separation of duties enforced in code:**
- No individual can deploy a policy — deployment requires two signatures (policy lead
  + independent evaluator), neither of whom can be the governance-board member who
  signed off.
- The evaluator function is held by a separate team with its own reporting line to the
  oversight board, not to the policy lead.
- Every policy artifact and every evaluation artifact is signed and written to the
  immutable audit log before deployment.
- **No direct database access** to `mdp_decisions`, credibility tables, or assignment
  records in production. All changes go through versioned code paths with full
  review. Emergency overrides require two signatures and post-hoc governance review.

**Perverse incentives to watch:**
- *Policy author captured by a stakeholder.* Fix: 4-eye rule above plus public policy
  descriptions (§11.7) — if the policy does something unusual, the diff is readable.
- *Evaluator collusion with author.* Fix: evaluator rotation; random sample of past
  evaluations independently re-run by the oversight board.

#### Court operator (the 501(c)(3)/(c)(4))

**Funding diversification rules** written into the operating charter:
- No single funder (individual, foundation, or corporate) contributes more than **5%**
  of operating budget in any rolling 12-month window. Excess is accepted into a
  restricted reserve, not spent.
- Published donor list at or above a disclosure threshold; no anonymous large donors.
- Escrow revenue — the signer/sponsor pledges — is the intended primary revenue line at
  steady-state. The design target is that operating cost is mostly paid by the cases
  themselves, minimizing dependency on external funders.

**Governance of the operator:** independent board, fiduciary duties published,
separate from the oversight board (which governs the court's rules) and from the policy
team (which runs the software). Three distinct bodies, three distinct memberships.

### 12.2 Structural checks (separation of powers)

Mapped loosely onto a branches-of-government model:

| Branch      | Body                          | Role                                                                    |
| ----------- | ----------------------------- | ----------------------------------------------------------------------- |
| Legislative | Oversight board               | Sets reward weights, admissible actions, eligibility rules              |
| Executive   | Court operator + policy team  | Runs day-to-day; enforces rules; cannot change them                     |
| Judicial    | Trial panels + appeal panels  | Decide cases; random draw from pool; per-stage rotation                 |
| Audit       | Independent auditor (rotating)| Annual external audit of operations, code, and governance               |
| Public      | Docket, press, academics      | Informal check; powered by full public-docket transparency              |

Four formal bodies, one informal. **Capturing any one of the four formal bodies does
not capture the court.** A captured oversight board cannot make panels vote a certain
way. A captured policy team cannot change reward weights. A captured appellate panel on
one case cannot set precedent across the system. A captured auditor's findings are
verifiable against the immutable audit log by any successor auditor.

### 12.3 Transparency as a check

Every category of information that doesn't have a specific reason to be sealed is
published by default:

- Full docket of all filings, stages, assignments (pool + seed + draw), votes (after
  cooling-off), verdicts, appeals, and disbursements.
- Policy version hash on every decision, plus published behavior descriptions.
- Evaluation artifacts (§11.3) for every deployed policy.
- Credibility-score bands (coarsened, not raw) for active judges.
- Oversight-board minutes, votes, and dissent rationales.
- Donor list above disclosure threshold.
- Annual external audit report, including a section on "what the auditor was not given
  access to" if any.

Publishing operations is not the primary check — the structural checks above are — but
it is what makes the structural checks **enforceable** by outside observers. A board
vote nobody sees cannot be criticized in time to matter.

### 12.4 Specific governance mechanisms

- **Reward-weight changes:** 2/3 oversight-board supermajority + 30-day public comment
  period + published rationale. Weights can be changed, but not quickly, and not quietly.
- **Admissible-action changes:** same bar as reward weights. Adding or removing an
  action class is a policy-level change and requires the full procedure.
- **Policy deployment:** two signatures (policy lead + independent evaluator), full
  §11.3 artifact pack, staged rollout with auto-rollback.
- **Cliff-rule appeals:** peer panel drawn fresh, no prior co-service with appellant,
  reinstatement possible for structural-factor scores.
- **Conflict disclosures:** required at every stage; false or omitted disclosure
  triggers automatic removal from the case and a credibility penalty; repeat offenses
  trigger non-renewal.
- **Whistleblower channel:** routed to an independent ombuds (not inside the policy or
  operator teams), with legal protections and a standing retainer for whistleblowers'
  counsel.
- **Sunset clauses:** every major rule (tier schedule, reward weights, action classes,
  credibility formula) expires on a fixed cadence (e.g., 5 years) unless affirmatively
  renewed by a supermajority. Forces periodic re-examination instead of accumulating
  cruft.
- **External audit rotation:** no external auditor serves more than 3 consecutive
  years. Incoming auditor is given read access to the previous auditor's working
  papers.

### 12.5 Perverse-incentive checklist

A running list for the design's threat model — each entry pairs an incentive pathology
with the mechanism that blunts it. New entries added as new patterns emerge.

| Pathology                                  | Mechanism that blunts it                                                |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Judge votes with majority to protect score | Credibility rewards calibrated dissent, not alignment                   |
| Judge accepts future employment from defendant class | Post-service cooling-off period, bar-referral enforcement         |
| Plaintiff files for harassment             | Escrow at risk, frivolous-filing finding attaches to plaintiff history  |
| Signer/Sponsor astroturfing                        | KYC verification, one-per-person, pledge-at-risk, donor-list publication|
| Defendant runs the motion clock            | SLA-bounded pretrial windows, sanctions for abuse                       |
| Defendant approaches a judge directly      | Whistleblower channel with credibility bonus, mandatory reassignment    |
| Peer reviewer is collegial                 | Random draw, co-service limits, reviewer's own score audited later      |
| Oversight board captured by one coalition  | Staggered terms, 2/3 supermajority, external seats, signer/sponsor-elected seats|
| Policy team writes biased policy           | 4-eye rule, independent evaluator, published behavior description       |
| Evaluator colludes with author             | Evaluator rotation, oversight-board spot-checks                         |
| Funder tries to influence via large gift   | 5% cap on any single funder, restricted reserve for overage             |
| Single auditor captured                    | 3-year rotation, successor reviews working papers                       |
| Policy drifts to maximize a proxy metric   | Multi-metric evaluation, archetype-conditioned audit, fairness bounds   |
| Reward weights shifted to favor an agenda  | 2/3 supermajority + 30-day comment + published rationale                |

### 12.6 The meta-question: who guards the guards?

The honest answer is that no institutional design eliminates the question — it only
distributes it. This design distributes it across four formal bodies plus the public
docket, so that corrupting the court requires coordinated capture of bodies with
structurally incompatible memberships, term schedules, selection processes, and
accountability chains.

The ultimate check is **citizen funding itself**. If the court loses legitimacy,
signer/sponsors stop pledging, filings dry up, the operator runs out of runway. Money flows
from perceived legitimacy. That means every incentive design above is ultimately under
the discipline of whether a watching public continues to believe the system works. The
transparency defaults in §12.3 are what make that discipline actionable instead of
theoretical.

This is also why the MDP is explicitly not in the business of picking outcomes (§9.3).
The more outcome-shaping the software does, the thinner the legitimacy argument gets.
The software's role is logistics — routing, assignment, scheduling, scoring — each of
which is individually auditable. Humans, drawn randomly from a vetted pool, vote the
verdicts. That division is the single most important structural check in the whole
design.

---

## 13. Sentencing, enforcement, deterrence, and recidivism

Verdicts without enforcement produce no signal. A conviction that doesn't change the
defendant's behavior, and doesn't discourage adjacent actors from offending in the first
place, is not actually a success even if it is the "correct" verdict on the record. This
section specifies what sentences the court imposes, how they get enforced given the
court's non-governmental status, how sentence severity plus subsequent recidivism feed
back into the MDP's reward signal, and how **general deterrence** — the reduction in
would-be corrupt conduct across the broader population — is measured and optimized for.

The short version: the court's purpose is to **reduce corruption**, not to produce
verdicts. Verdicts are the mechanism, not the goal. Everything in this section is about
closing the loop from "correct verdict" back to "less corruption."

### 13.1 Sentence structure: jail + personal financial

The court's sentencing output is a **combination of custodial time and personal
financial penalties**, plus supporting non-custodial components. The two load-bearing
parts are custodial sentences and personal financial liability; everything else is a
supplement.

| Component                   | Scale                                                                       | Who it lands on                                                  |
| --------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Custodial (jail time)**   | Months to years                                                             | The natural persons in the decision chain                        |
| **Personal financial**      | Fraction of personal net worth + disgorgement of personal gain              | The natural person, **not the corporate entity**                 |
| **Clawback**                | Retrospective recovery of bonuses, equity vesting, performance comp tied to the conduct window | The natural person (requires cooperation or a consent-to-clawback clause) |
| **Professional**            | Bar referral, license suspension/revocation, industry-body blacklist        | The natural person's profession                                  |
| **Injunctive / compliance** | Compliance monitor, reporting obligations, time-bound conduct restrictions  | Mixed — can attach to person or entity                           |
| **Corporate fine**          | Used sparingly — only when the conduct is genuinely institutional           | The corporate entity                                             |
| **Disclosure**              | Named finding in public registry; cross-registry notification               | Individuals; corporate entity also where relevant                |
| **Referral**                | Criminal referral to DOJ / state AG; regulator referral (SEC, IRS, FinCEN) | Both individuals and entities as applicable                      |

### 13.2 Why financial penalties are personal, not corporate

This is a deliberate inversion of the usual "big corporate fine" pattern, and the
inversion is load-bearing.

- **Corporate fines are absorbed.** A $100M fine on a public company with $10B in
  revenue is a cost of doing business, not a consequence. It shows up in a press
  release, gets expensed, and the stock recovers within a quarter.
- **Corporate fines land on shareholders, who are usually not the perpetrators.**
  Pension funds, index investors, and employees' 401(k)s hold most shares. Punishing
  them punishes bystanders.
- **The people who made the decisions walk away rich.** Bonuses already paid; equity
  already vested. The executive who authorized the corruption keeps their compensation;
  shareholders pay the fine; the executive leaves for a new role.
- **Personal penalties plus jail change behavior.** An executive facing personal asset
  seizure, clawback of past compensation, and a custodial sentence has a real decision
  to make before they authorize corruption. That is the behavior the sentencing regime
  is designed to change.

Corporate fines are therefore the exception, not the rule. A corporate fine is
appropriate when:

- The conduct is genuinely institutional (diffuse decision chain, no identifiable
  decision-maker), OR
- A specific institutional reform is what's being bought (e.g., a compliance monitor), OR
- The corporate entity received benefit that exceeds what can be disgorged from
  individuals, AND
- It is **additional to** personal penalties, not a substitute.

A corporate fine that replaces personal accountability is a failure mode the sentencing
policy is designed to reject. The MDP's sentencing-recommendation model is trained with
a penalty term on all-corporate-no-individual sentence combinations in archetypes where
decision-chain attribution was feasible.

### 13.3 Sentence severity index

Every sentence gets a scalar `sev ∈ [0, 1]` computed from a published rubric. It is the
feature the learning loop consumes.

Components (each normalized 0–1, combined with published weights):

- `sev_custody` — log-scaled custodial duration (no jail = 0; life = 1.0).
- `sev_financial_personal` — personal financial liability as a fraction of the
  defendant's pre-conduct net worth (10% = meaningful; 50%+ = severe; capped where
  disgorgement is genuinely proportional).
- `sev_clawback` — fraction of conduct-window compensation clawed back.
- `sev_professional` — public censure < single-year suspension < multi-year <
  permanent industry ban < disbarment.
- `sev_injunctive` — compliance-monitor-years × scope of restriction.
- `sev_corporate` — corporate fine / corporate annual revenue (included with low
  weight so it doesn't dominate; see §13.2).
- `sev_disclosure` — disclosure breadth (local only → national registry →
  cross-registry broadcast).
- `sev_referral` — strongest referral issued (none < civil regulator < criminal state <
  criminal federal < multi-jurisdiction).

The composite `sev` is used for:

- Cross-case calibration (is this judge's sentencing in distribution for similar facts?).
- Learning features (which severity patterns correlate with reduced recidivism and
  reduced general corruption?).
- Public docket display (coarsened into bands: Low / Moderate / Heavy / Severe).
- Fairness audit (is sentence severity distribution even across defendant archetypes,
  controlling for conduct?).

Rubric weights are governance-set, not learned (§11.1 separation). The MDP learns which
*patterns* of severity components are most effective given the weights; it does not
retune the weights to justify past sentencing patterns.

### 13.4 Panel decides; controller recommends a range

Sentencing is a panel decision, not a controller action. The software must not pick the
sentence. But the MDP can **recommend a sentencing range** to the panel, analogous to
federal sentencing guidelines but with a different anchoring corpus.

- **Range input:** case features + verdict (including any facts the panel found beyond
  the verdict itself) → recommended `sev` range and a suggested decomposition across
  components.
- **Panel behavior:** the panel may sentence within, below, or above the range.
  Departures require a written reasoning statement published with the sentence.
- **Departure tracking:** departure frequency and direction are themselves monitored as
  a fairness signal. A panel that consistently departs *downward* for one defendant
  archetype is a red flag; a single reasoned departure is not.

The recommendation model is trained on closed-case outcomes including recidivism
(§13.7) and deterrence (§13.9); it is recalibrated on the same cadence as the main
policy. It is never a hard ceiling or floor — the panel is sovereign on the individual
case.

### 13.5 Enforcement pathways

The court is a citizen-funded non-governmental institution. That limits what enforcement
it can do directly and requires explicit pathways for what it can't.

**Direct (court has standing jurisdiction):**

- Escrow disbursement of damages/disgorgement from the defendant's pre-posted bond,
  where one exists.
- Personal asset attachment via civil-judgment recognition in jurisdictions that
  recognize the court's findings (compact, contract, or statutory presumption).
- Clawback enforcement where the defendant's employment agreement included a
  forum-selection or clawback clause naming the court.
- Publication to the public registry — fully under the court's control.

**Indirect (court refers, another body enforces):**

- Custodial sentencing: the court issues findings + recommended sentence; prosecutors
  (DOJ, state AGs) act on the referral. Criminal jail time is enforced only by a
  cooperating criminal system.
- Professional consequences: bar referral, licensing complaints, industry-body
  blacklist. The bodies act independently; the court's finding is persuasive, not
  binding.
- Regulator penalties: SEC, IRS, FinCEN, FTC — each has its own adjudication; the
  court's finding is input.

**Three enforcement-model stages, by institutional maturity:**

1. **Referral model (MVP).** Court issues findings; referrals go out. Willing
   prosecutors act on them. Depends entirely on prosecutor cooperation. Early-stage.
2. **Compact model.** Prosecutors, regulators, and professional bodies adopt the
   court's findings as statutory/contractual input — e.g., a state AG that treats a
   court finding as a presumption in charging decisions. Middle-stage, achievable with
   advocacy.
3. **Statutory authority model.** Legislative grant of direct sentencing authority, at
   least for defined categories (most likely: civil monetary + professional, with
   custodial still requiring referral). Long-term; hardest to achieve.

The MDP's sentencing-recommendation model is trained with **realized-enforcement** as
part of its outcome vector — a sentence not enforced is a sentence that produced no
deterrence. The model learns which sentence patterns actually get executed, not just
which get pronounced. This avoids the failure mode of recommending aggressive sentences
that sit unenforced in referral queues while corruption proceeds.

### 13.6 Piercing corporate form for personal liability

The "personal not corporate" rule requires an enforcement technique: the court must be
able to reach the individual's assets and compensation despite the defendant structuring
their affairs to hide behind corporate form.

Standing tools:

- **Beneficial-ownership disclosure.** Intake and discovery require disclosure of
  beneficial ownership of any entity the defendant controls — the same graph used for
  COI screening (§3.1 `conflictVector`).
- **Clawback clauses.** Where the employer cooperates, conduct-window compensation is
  subject to clawback — personal bank accounts, brokerage accounts, restricted stock,
  deferred compensation.
- **Personal-guarantee bonds at filing.** For defendants in roles with material
  fiduciary exposure, some version of a personal bond (similar to a bail bond) posted
  at filing is a recurring design option under discussion (open question — see §14).
- **Alter-ego findings.** Where the defendant used a shell entity to hold compensation
  or assets, an alter-ego finding attaches those assets to the individual. Standard
  civil-procedure doctrine, applied through the court's discovery and findings.
- **Fraudulent-transfer findings.** Post-filing transfers of assets to family members
  or trusts are clawable under fraudulent-conveyance law; the court's finding of
  fraudulent transfer triggers downstream enforcement in civil courts of general
  jurisdiction.

The objective is that a defendant with $50M in net worth and an $8M conviction cannot
make the $8M vanish by moving it to a spouse's LLC three months before the verdict.
Every one of the tools above is a public-law technique that already exists; the court's
job is to use them aggressively and coherently.

### 13.7 Recidivism tracking (specific deterrence)

Recidivism is the **specific-deterrence** signal: did this defendant, or their network,
re-offend after being sentenced?

**Recidivism is identity-resolved, not string-matched.** The tracking graph covers:

- **Natural person identity** — the defendant themselves, resolved across name variants,
  affiliations, and roles.
- **Controlled-entity identity** — entities the defendant controlled at the conduct
  window, tracked forward across renames, restructures, and subsidiary migrations.
- **Network identity** — close associates, co-defendants, and common counterparties
  used to detect group-level recidivism.
- **Archetype match** — a recurrence of the same conduct pattern by a substantially
  similar actor, even if personally distinct.

**Recidivism metrics:**

- `days_to_next_accepted_case` — time from sentence-final to next filing accepted
  against the same person/entity.
- `severity_trajectory` — `sev` of the next case minus `sev` of the current case (does
  the conduct escalate or de-escalate?).
- `network_recidivism_rate` — fraction of close associates filed against within
  T months.
- `archetype_continuation` — probability the next case is in the same archetype.

**Confound controls.** Recidivism cannot be interpreted without controls:

- **Baseline arrival rate** for that archetype and defendant class.
- **Detection intensity.** A defendant under a consent decree is *more* likely to be
  re-filed against not because they re-offend more, but because they are watched more.
  This has to be accounted for or severity will appear to *increase* recidivism.
- **Survival.** Longer follow-up produces more apparent recidivism; the metric is
  hazard-rate, not raw count.
- **Selection.** The counterfactual is not "no sentence" — it's "typical sentence for
  similar facts." Comparison is within archetype and severity band.

### 13.8 Recidivism as long-horizon reward

A new term in the per-case return (extending §3.3):

- `−R_recidivism(t, net)` — negative reward if the defendant **or their close network**
  produces a new accepted filing within T months after sentence-final, weighted by
  severity of the new case and discounted by hazard-rate baseline. Magnitudes are large
  (relative to the rest of the reward) because recidivism is the ultimate signal of
  whether the court produced any change in this defendant's behavior.
- `+R_no_recidivism_extended(t)` — small positive reward accrued over time for sentence
  events that land in an extended quiet period without re-filings, to avoid a
  pure-penalty framing that over-weights the rare positive event.

This reward is credited to:

- **The sentencing decision** (the panel's sentence choice, and by extension the MDP's
  sentence-range recommendation model that anchored the panel).
- **Partially to the verdict decision** — a correct verdict is necessary for a correct
  sentence.
- **Not to the assignment decision.** Assignment is upstream; its reward is mediated
  through verdict confidence, not through recidivism directly.

Time-lag handling uses the same delayed-reward plumbing as appeal-affirmed (§3.3):
recidivism events are attributed back to the sentencing decision that preceded them;
the policy trainer does not wait for the full horizon before producing a candidate, but
the OPE pipeline (§11.3) requires a minimum follow-up window before crediting
recidivism into the headline reward.

**Care with the signal.** A lenient sentence that leads to no recidivism is not
necessarily a better sentence — it may have been the correct sentence on thin evidence,
the defendant may have been deterred by the verdict rather than the sentence, or the
follow-up window may have been too short. Recidivism reward is combined with `sev` and
the matched-archetype baseline; it is never used as a pure target. A policy that
systematically over-sentences to reduce recidivism fails the fairness gate (§11.3) even
if it scores well on the headline reward.

### 13.9 System-level deterrence (general deterrence)

Recidivism measures whether *this* defendant re-offends. The bigger question is whether
the broader population of potential offenders in the same archetype reduces their
corrupt conduct because they saw the sentence happen to someone else. That is **general
deterrence**, and it is the mechanism by which corruption in a system actually shrinks.
Recidivism reduces corruption by one defendant; deterrence reduces corruption by
everyone who was thinking about it.

This subsection is the single most important one in this section, because the court's
ultimate purpose is reducing corruption in the systems it monitors, not winning cases
in isolation.

#### 13.9.1 The certainty / swiftness / severity triad

Classical deterrence theory and 50+ years of empirical criminology converge on three
factors that determine deterrent effect, in roughly this order of importance:

1. **Certainty** — the perceived probability that corruption gets detected and
   sentenced. Empirically the dominant factor by a wide margin. Doubling the
   probability of being caught deters substantially more than doubling the sentence
   length. A system that catches 50% of offenders with moderate sentences deters more
   than a system that catches 5% of offenders with draconian sentences.
2. **Swiftness** — time from conduct to sentence. Delayed consequences discount heavily
   in the offender's decision function. A 10-year sentence delivered 8 years after the
   conduct deters less than a 3-year sentence delivered within 12 months.
3. **Severity** — magnitude of the sentence itself. Matters, but with sharply
   diminishing returns beyond a threshold. Doubling severity past that threshold buys
   very little marginal deterrence; the headlines are the same and the offender's
   risk calculation has already priced in "meaningful sentence."

A system with heavy but rare and slow sentencing deters less than a system with
moderate but certain and fast sentencing. This ordering drives the MDP's optimization
targets: the policy is structured to improve certainty and swiftness first, severity
only where the triad analysis supports it.

#### 13.9.2 Measuring general deterrence

Deterred behavior is the absence of an action, which means it cannot be observed
directly. The court relies on a battery of proxies and natural experiments, each of
which is noisy on its own but collectively give a signal:

- **Archetype filing rate.** After high-visibility sentencing on a specific archetype,
  does the filing rate for that archetype decline over a 6–24 month window? Requires a
  matched control archetype (one where no high-visibility sentencing occurred) to
  separate deterrence from broader trend.
- **Compliance-program spend.** Publicly-traded companies in the sentenced defendant's
  industry report compliance-program spend in their 10-Ks. Increases in the affected
  industry cohort vs. matched controls are a leading indicator that firms perceive
  heightened risk.
- **Voluntary disclosure rate.** Self-reports to regulators or to this court directly.
  A deterrence effect often shows up as increased voluntary disclosure, because
  defendants now believe they will eventually be caught and are racing to self-report
  under whatever leniency program is available.
- **Whistleblower-tip volume.** Tips to the court's whistleblower channel (see §12.4),
  weighted by substantiated-tip quality. Rising tip volume in an archetype indicates
  insider participants perceive the regime as credible enough to act on their reports.
- **Corruption-perception surveys.** Among the relevant professional populations
  (general counsels, compliance officers, board directors, procurement officers).
  Conducted by an **independent academic partner**, not by the court itself, to
  prevent scoring games.
- **Press-coverage depth.** Published findings that receive substantive coverage (not
  just passing mentions) have measurably higher deterrent value. Tracked as an
  intermediary signal — more coverage today predicts more measured deterrence later.
- **Structural adjacency shifts.** Policy changes at non-sentenced firms — new board
  committees, new audit-trail requirements, new outside-counsel reviews — visible in
  proxy statements and 8-Ks. These are voluntary compliance uplifts caused by the
  perceived risk.

#### 13.9.3 Attribution methodology

Because deterrence is a population-level phenomenon, it cannot be attributed per-case.
Attribution is done at the **archetype × rolling-window** level:

- Group sentencing events by archetype and rolling window (e.g., 6-month windows per
  archetype).
- For each window, compute a **sentencing-regime vector**: mean `sev`, mean
  time-to-sentence, enforcement-realization fraction, certainty estimate (accepted
  cases / estimated true-corruption-volume), number of high-publicity sentences, and
  number of named-individual sentences.
- For each window, compute a **deterrence-outcome vector** from the proxies in
  §13.9.2.
- Back out the causal deterrence effect using **difference-in-differences** or
  **synthetic-control** estimators (standard causal-inference plumbing) with matched
  archetypes as controls.

The causal-inference methods here are where most of the implementation work lives.
Naive correlation — "we sentenced harder and then filings fell" — is uninformative on
its own because of confounding with press cycles, economic conditions, and enforcement
shifts elsewhere. The evaluation pipeline treats deterrence estimates with wide
confidence intervals and never acts on a point estimate alone.

#### 13.9.4 Deterrence as reward

Extending the per-case and system-level returns from §3.3 and §13.8:

- `+R_deterrence_cohort(window, archetype)` — system-level positive reward, attributed
  back to the sentencing decisions that fell in the window. Attribution is proportional
  to `sev × publicity_weight` — severe, public, named-defendant sentences get credited
  more than minor uncontested ones.
- `+R_certainty` — a separate term rewarding **high-probability detection**, measured
  by the ratio of accepted cases to estimated true-corruption volume per archetype
  (using the detection-intensity controls from §13.7). The policy is incentivized to
  make corruption more likely to be caught, not just more likely to be severely
  sentenced — this is the primary lever in the triad.
- `+R_swiftness` — positive for reductions in time-to-sentence at the archetype level,
  separately from the per-case wall-clock cost in §3.3. Adds a general-deterrence
  framing on top of the per-case SLA framing.

These three terms together operationalize the certainty / swiftness / severity triad
as a system-level reward. Their **relative magnitudes** encode the "certainty first,
swiftness second, severity third" empirical ordering — certainty gets the largest
weight, severity the smallest. Those magnitudes are governance-set (§13.11 Fixed) and
are the single most important lever in the entire reward function.

#### 13.9.5 Deterrence feeds admission and priority upstream

Once general deterrence is measured per archetype, it becomes a feature the MDP can
use upstream:

- **Archetype deterrence-value feature.** Archetypes where the evidence base suggests
  sentencing generates strong deterrent spillover get a modest boost on admission and
  priority decisions. This is the policy way of saying "cases in this archetype matter
  more than their per-case damage would suggest, because every sentence also deters
  ten future would-be cases."
- **Publicity multiplier in `admit_expedited`.** Cases whose sentencing would be
  publicly visible (named individual defendant, documented archetype, live news cycle)
  score higher in the expedite decision — not because speed favors the plaintiff
  legally but because the deterrent value of a swift visible sentence on an individual
  is measurable and attributable.
- **Certainty-driven capacity allocation.** If an archetype's certainty estimate
  (§13.9.3) is low — the court is catching only a small fraction of true cases —
  pool-sizing (§3.2 C) and priority (§3.2 B) can shift to raise certainty in that
  archetype before shifting to others. Low certainty is the single biggest leak in
  the deterrence triad and the policy explicitly targets it.

#### 13.9.6 What deterrence is NOT used for

Three important guards, because operationalizing "reduce corruption" carries real risk
of pressure toward outcome-shaping:

- **Not a verdict input.** Deterrence value does not influence the panel's vote.
  Panels see the facts and the law; they do not see "this archetype needs harder
  sentences for deterrent reasons." That channel is managed only through the
  sentencing-range recommendation model (§13.4), which is itself calibrated on closed
  cases — but the individual panel is not optimizing for general deterrence when they
  vote guilty or not.
- **Not a basis for over-sentencing an individual.** A sentence severe enough to deter
  a population but disproportionate to the individual case fails the fairness gate
  (§11.3) and the proportionality audit in §13.10. Individual-level proportionality
  constrains aggregate-level optimization.
- **Not a reason to prosecute cases with thin evidence.** Admission and screening
  require evidence sufficiency; deterrence value only weights among cases that have
  already passed the evidence bar.

#### 13.9.7 The intended feedback loop

A well-calibrated court produces, in steady-state:

*swift, certain, named-individual sentencing on detected corruption*
→ *rising compliance spend and perceived risk in affected archetypes*
→ *falling filing rate as the underlying corruption rate drops*
→ *increased court capacity freed up for new or adjacent archetypes*
→ *broader coverage, broader deterrence, further falling corruption*.

The MDP's pool-sizing action (§3.2 C) interacts with this loop directly: if general
deterrence is working in one archetype, capacity shifts to a new archetype rather than
being over-supplied on a shrinking caseload. A policy that only measures per-case
reward and ignores archetype-cohort deterrence will over-provision capacity on
successfully-deterred archetypes and under-invest on emerging ones — the exact opposite
of what a deterrence-optimizing court should do.

The ultimate success metric for the court is **corruption prevalence falls across
monitored archetypes faster than in matched unmonitored archetypes**. Verdicts,
convictions, and sentences are the mechanism; falling corruption is the goal. Every
reward term in this section is a proxy for that goal.

### 13.10 Sentencing fairness audit

Sentencing is the single most scrutinized surface for disparate treatment. The §11.3
fairness gate has an explicit sentencing branch:

- **Severity distribution by defendant archetype**, controlling for verified case facts.
- **Severity distribution by defendant demographic**, controlling for archetype.
- **Departure-from-recommendation frequency and direction by panel composition.**
- **Proportionality audit.** Each sentence is scored against a proportionality
  reference (conduct harm × mitigating/aggravating factors → expected `sev`).
  Systematic upward departure in a specific archetype triggers review, even if
  deterrence metrics favor the heavier sentences. This is the guard that prevents
  deterrence optimization from pushing individual sentences out of proportion.
- **Recidivism-by-severity curves by archetype.** If one archetype has a systematically
  different deterrence curve, the sentencing recommendation model must be
  archetype-conditioned rather than globally applied.

Any sentencing policy version that makes the severity-by-demographic variance worse
than the incumbent fails the audit, even if it improves aggregate recidivism or
deterrence.

### 13.11 What's learned vs. fixed

**Learned:**

- The sentencing-range recommendation model (features → recommended `sev` range and
  decomposition suggestion).
- Recidivism predictors per archetype — which severity components actually reduce
  recidivism in which contexts.
- Deterrence-effect estimators per archetype (difference-in-differences and
  synthetic-control models from §13.9.3).
- Enforcement-realization estimates — given a recommended sentence and current
  enforcement-pathway state, what is the probability each component is enforced?
  Feeds back into sentencing to prefer recommendations that actually land.
- Archetype deterrence-value feature used in upstream admission/priority decisions
  (§13.9.5).

**Fixed (governance):**

- The available sentence components (§13.1 table). Adding a new component is a
  governance action.
- The severity-rubric weights (§13.3). Changing them follows §12.4 procedure.
- The **certainty / swiftness / severity ordering** — certainty gets the largest
  reward weight, then swiftness, then severity. This is a structural commitment to the
  empirical deterrence literature; it is not a parameter the MDP can retune.
- The recidivism-reward magnitude (§13.8) and the three deterrence-reward magnitudes
  (§13.9.4) — all governance-set reward weights.
- The "personal not corporate" constraint (§13.2). Structural rule, not a policy knob.
- The fairness audit thresholds (§13.10). Relaxing them requires governance action
  and a published rationale.

### 13.12 Decision points

| Decision                                                     | Decider                                    | Cadence                   |
| ------------------------------------------------------------ | ------------------------------------------ | ------------------------- |
| Sentence on an individual case                               | Trial/appeal panel                         | Per verdict               |
| Sentencing-range recommendation model                        | MDP (learned); governance approves version | Per policy rollout        |
| Sentence components available in the system                  | Governance (oversight board)               | Sunset-bound              |
| Severity rubric weights                                      | Governance (oversight board)               | Sunset-bound              |
| Certainty/swiftness/severity reward-weight ordering          | Governance (structural)                    | Charter-level; amended rarely |
| Recidivism-reward weight                                     | Governance (oversight board)               | Sunset-bound              |
| Deterrence-reward weights (cohort, certainty, swiftness)     | Governance (oversight board)               | Sunset-bound              |
| Deterrence measurement methodology                           | Independent academic partner + court analytics | Rolling 6-month windows |
| Archetype deterrence-value feature in upstream decisions     | MDP (learned); governance approves         | Per policy rollout        |
| Enforcement-pathway upgrades (referral → compact → statutory) | Governance + outside advocacy             | Institutional maturity    |
| Personal-bond / guarantee requirement at filing              | Open question; governance                  | TBD (§14)                 |

---

## 14. Open questions

- **Evidence-complexity scoring.** Who scores it at intake, and how is that score audited
  against downstream actual complexity? Candidate: a lightweight classifier trained on
  closed cases, recalibrated monthly.
- **Peer-review panel supply.** Is the 10% sample rate + all-dissent + all-appeal volume
  sustainable at steady-state caseload? If not, sample rate and criteria need retuning.
- **Defendant network model.** How exhaustive is the COI graph? Bar registration +
  professional history + public directorships + known family ties. Ownership-opaque
  vehicles are the hard edge case.
- **Cross-jurisdiction cases.** If a filing names defendants in multiple
  courts/jurisdictions, does each court run its own MDP and sync, or does one court host
  the case? Governance design decision.
- **Reward-weight governance.** Who exactly sets them, on what cadence, with what
  appeals mechanism? This is the most politically sensitive part of the whole design
  and needs its own doc.
- **Personal-bond / guarantee requirement at filing** (§13.6). Should defendants in
  roles with material fiduciary exposure post a bail-analogous personal bond at case
  filing to preserve asset-attachability through verdict? Strong for
  piercing-corporate-form enforcement; uncertain under due-process challenges and
  likely requires statutory footing. Governance design decision.
- **Certainty-estimate denominator.** Estimated true-corruption volume per archetype
  is the denominator of `+R_certainty` (§13.9.4). It is itself an estimate, and a
  bad one distorts the whole deterrence reward. Methodology (survey-based,
  whistleblower-volume-based, or composite) needs to be set by the independent
  academic partner in §13.9.2 with governance sign-off.
- **Deterrence measurement latency.** DiD and synthetic-control estimators need a
  6–24 month follow-up window (§13.9.2) before they produce a credible estimate.
  How much of the deterrence reward should be allowed to feed into online policy
  updates vs. held back for periodic batch recalibration? Affects both reward lag
  and the online-learning guardrails in §11.5.

---

## 15. Next steps

1. Fit arrival-rate and service-time priors from adjacent-institution data (SEC OIG,
   state ethics boards, bar disciplinary dockets).
2. Build the 1:1 simulation engine; replay historical arrivals under the hand-tuned
   baseline; publish the baseline metrics.
3. Define the `mdp_decisions` extension and `court_flow_outcomes` table, following the
   pattern from [mdp-email-outreach.md](./mdp-email-outreach.md).
4. Prototype the credibility pipeline against synthetic judge histories; stress-test
   the cliff rule for cohort-effect robustness.
5. Governance charter draft for reward-weight setting and policy-rollout approval.
