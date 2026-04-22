# Corruption Court — Software Platform & Accelerated Simulation

**Created:** 2026-04-18
**Status:** Draft

This document specifies (a) the **software platform** that runs the anti-corruption
court in real life — auth, case management, voting, escrow, assignment, notifications,
public docket — and (b) the **accelerated simulation harness** that exercises the same
platform binary against synthetic human users before anything ships to production. The
hard problem it solves is that the court's flows are heavily driven by email/SMS round
trips, and a realistic simulation has to fake those round trips well enough that the
platform behaves as it would in the real world — without sending a single real email.

It builds on:

- [anti-corruption-court-plan.md](./anti-corruption-court-plan.md) — the court's
  structural design, tiers, escrow, panel composition.
- [mdp-corruption-courts.md](./mdp-corruption-courts.md) — the MDP/queuing model, the
  1:1 agent-based simulation principle (§8 there), the incentive/checks structure
  (§12 there), and the learning loop (§11 there).

Everything below is about making those two docs **runnable**.

---

## 1. Guiding principles

1. **One codebase, two modes.** The same platform binary runs in `live` and `sim`
   modes. Every external-effect service (email, SMS, payments, KYC, storage) is behind
   an adapter interface; the adapter picked at boot is determined by mode. No
   `if (isSimulation)` sprinkled through business logic — only at adapter boundaries.

2. **1:1 entity modeling everywhere.** Every human actor — judge, plaintiff, signer/sponsor,
   defendant, clerk, oversight board member, peer reviewer, ombuds, auditor — has a
   real account on the platform, in both modes. The simulation is populated with
   synthetic accounts that go through the same signup, KYC, and login flows the
   real people will. No aggregation, no mocked tables.

3. **Email/SMS response is an action, not a mystery.** Outbound messages are
   structured artifacts that carry a machine-readable **action list** alongside the
   human prose. Simulated agents execute those actions through the same API endpoints
   a real user's browser or phone would hit. No LLM-parsing emails at runtime.

4. **Determinism is a feature.** Given a seed, an initial state, and an input
   schedule, a simulation run is bit-for-bit reproducible. This is what makes the
   simulation useful for debugging, for MDP training, for regression suites, and for
   adversarial evaluation.

5. **Safety in depth.** Multiple independent mechanisms prevent a sim binary from
   sending real emails or a prod binary from loading sim data. Any single layer
   catching a mistake is sufficient; no single layer is load-bearing.

6. **Robustness over fidelity-at-cost.** Where a choice exists between a faster and
   simpler sim mechanism vs. a slower higher-fidelity one, prefer the simpler one
   unless the fidelity loss invalidates a decision the MDP or governance would make
   on the sim output. Examples: direct-API "clicks" beat headless-browser clicks as
   the default; pre-computed CTA metadata beats HTML parsing.

---

## 2. Actor taxonomy — who gets an account

Every human and every institutional role has an account. The platform's permission
system is role-based, and roles are attached to accounts rather than being separate
account types.

| Actor                    | Signup path                      | KYC level                  | Primary permissions                                                   |
| ------------------------ | -------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| Plaintiff (initiator)    | Public signup + case-open flow   | KYC-medium + sworn affidavit| File, edit own filings, withdraw, invite signer/sponsors, view own escrow     |
| Signer/Sponsor           | Public signup + pledge flow      | KYC-light for view; KYC-medium + payment auth for pledging | Login, pledge/sign a filing (pledge requires putting money down — no free signatures), fund campaigns, cast **dollar-weighted priority votes** across open cases, post + update sponsor testimony, track progress on sponsored cases, receive disbursements, withdraw before capture subject to terms |
| Defendant (represented)  | Invitation only; counsel onboarding | KYC-medium + bar verify | View filings against defendant, file responses, request discovery     |
| Commissioned judge       | Invitation only; bar + commission| KYC-high + commission oath | Accept/decline draws, view case materials, cast votes, file opinions  |
| Clerk / court staff      | Invitation only; employment auth | KYC-high + NDA             | Intake review, docket ops, escrow ops, scheduling                     |
| Investigator             | Invitation only                  | KYC-high + credential      | Investigation stage work, evidence handling, witness interviews       |
| Peer reviewer            | Existing top-band judge (§7 of MDP doc) | inherits from judge | Post-verdict review panels, rating submission                         |
| Oversight board member   | Elected / appointed; charter-defined | KYC-high + public disclosure | Policy approval, weight-setting votes, audit authorization       |
| External auditor         | Vendor onboarding; rotates every 3y | corporate + personnel KYC | Read-only across ops/code/governance; working-paper submission         |
| Ombuds                   | Standing officer                 | KYC-high + NDA             | Whistleblower intake, independent investigation, board reporting      |
| Press / academic / public| Public signup (optional)         | none                       | Read-only on public docket; annotated views                           |
| Anonymous public reader  | No account                       | none                       | Read-only public docket                                               |

Roles compose. A commissioned judge can also sit as a peer reviewer and, if elected,
on the oversight board — each role adds a permission set and its own UI surface; the
account is the same.

**The 1:1 rule.** In the simulation, every one of these actors is represented by a
real account with a real login, not by a mocked database row. The simulation harness
drives these accounts through a synthetic-agent layer (§5).

---

## 3. Platform architecture

### 3.1 Service map

| Service                 | Role                                                                                   | Notes                                         |
| ----------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Auth                    | Login, session, MFA                                                                    | Clerk (existing in codebase); Supabase for session backup |
| Identity / KYC          | Name/DOB/address verification, bar-license verification, payment-method verification   | Pluggable provider adapter                    |
| Case service            | Filings, stages, docket, conduct-fingerprint, collision detection                      | Single source of truth for case state         |
| Evidence vault          | Document upload, redaction tooling, chain-of-custody hashes                            | Object storage + signed manifests             |
| Assignment service      | Eligible-pool filtering, commit-reveal lottery, conflict strikes                       | Public ledger for seeds + draws               |
| Voting service          | Per-juror commitments, cooling-off-period sealing, final tally                         | Cryptographic commitments; audited tally      |
| Escrow service          | Signer/Sponsor pledges, capture on acceptance, disbursement on resolution                      | Stripe Treasury adapter + custodial bank      |
| Notification service    | Email, SMS, in-app, webhook-out                                                        | Adapter interface — §4                        |
| Policy controller       | MDP that decides admission, priority, pool sizing, assignment rule, panel size         | Separate process; reads state, writes decisions to `mdp_decisions` |
| Credibility pipeline    | Nightly score updates from case closes, peer review, appeal outcomes, audit flags       | Batch job + live read API                     |
| Oversight dashboard     | Internal views over queues, assignments, audits, policy versions                       | Gated by role                                 |
| Public docket           | Filings, stages, assignments (post-reveal), verdicts (post-cooling-off), policy hashes | Read-only, full-text search                   |
| Audit log (immutable)   | Every decision, deployment, governance action                                          | Append-only store; external verifiability     |

### 3.2 Core invariants

- **Every state change is an event, written to the immutable audit log** before
  anything downstream reacts. The audit log is the ledger; other services project
  from it. This is what makes the §9 software claims in the MDP doc enforceable —
  any action is reconstructible from the log.
- **Every external-effect call goes through an adapter.** Mail, SMS, payment, KYC,
  storage, clock. The adapter interface is the point at which live/sim diverges.
- **Every endpoint is role-checked server-side.** Client-side hiding of UI is a
  convenience, not a security boundary.
- **Every randomness source is seeded and logged.** Random draws (assignment
  lottery, sampling for peer review, etc.) use a seeded RNG; the seed is published
  under commit-reveal for drawable events and logged for internal events.

### 3.3 Why "every actor has an account" matters

It is tempting to model defendants and the public as "external to the system." Don't.
Defendants need standing, notifications, response surfaces, and appeal rights — all of
which require authenticated interaction. The public needs signup for tracking filings
they care about. Clerks and investigators need accounts to actually do their work. The
only fully-unauthenticated surface is the public docket read path.

This also means the **simulation has to simulate all of them**. A platform where only
judges and signer/sponsors have accounts can't test the defendant response flow, the clerk
intake SLA, the investigator evidence flow, or the public-docket search load.

---

## 4. Notifications — the hard part

The court's workflows are driven by email and SMS round trips. A filing acceptance
emails the plaintiff and all signer/sponsors. A draw emails the drawn judges with an accept/
decline deadline. A motion filing texts opposing counsel. A verdict emails everyone
involved. Cooling-off-period vote-reveal emails the docket subscribers.

If the simulation can't fake these round trips well, the simulation is useless — it
will show a platform that handles happy paths instantly and ignores the messy reality
that people respond late, miss emails, click the wrong link, or never read the text.

This section is the load-bearing one.

### 4.1 Structured actions in every outbound message

Every message the platform sends carries a **structured action manifest**, in addition
to the human-readable body. The manifest is the contract between the platform and the
simulated agent.

Mail abstraction:

```
sendMail({
  to: accountId,           // always an account, never a raw email address
  templateId: string,      // pre-registered template
  payload: {...},          // variables
  actions: [               // machine-readable action list
    {
      id: "accept-draw-abc123",
      kind: "link" | "code" | "reply",
      intent: "accept" | "decline" | "confirm" | "verify" | "respond" | ...,
      url?: string,        // for link actions — the exact URL the button clicks
      token?: string,      // for code actions — the code the user would type
      label: string,       // the human-visible label (for logs)
      expiresAt?: timestamp,
    }
  ]
})
```

In **live mode**, the mail adapter renders the template, embeds the `url` or `token`
into the HTML, and sends via the real provider (SES / Resend / existing infra).

In **sim mode**, the mail adapter writes the full action manifest to the recipient's
`sim_inbox` table. No prose rendering required — the agent reads the manifest, not the
body. (The adapter can still render the body for logs and visual debugging.)

**Why this design:** it is the single most important decision in this doc. If agents
parse email HTML at runtime, the simulation becomes fragile — small template changes
break the simulation, LLM parsing is non-deterministic, and the sim diverges from the
live behavior in ways that don't surface until production. Structured actions are
deterministic, template-change-robust, and trivially auditable.

**In live mode**, the action manifest can also be embedded in the email as
`data-action-*` attributes on the rendered HTML — useful for browser-extension
automation, accessibility tooling, and post-hoc analytics. But the simulation does
not depend on HTML parsing.

### 4.2 SMS follows the same pattern

`sendSms({ to, templateId, payload, actions })`. Actions include short-code replies
(`"Reply Y to confirm"`) and tinyURL links. Same live/sim split.

### 4.3 The sim inbox / outbox tables

```
sim_emails (
  id, account_id, template_id, rendered_body, actions (jsonb),
  issued_at (virtual time), state (pending | read | acted | ignored | expired),
  acted_at, action_taken_id
)

sim_sms (...)

sim_inbound (
  id, account_id, kind (email | sms | webhook), payload (jsonb),
  submitted_at (virtual time), processed_at
)
```

Each account has exactly one subscribed agent (§5). The agent tails `sim_emails` /
`sim_sms` for its account and decides what to do with each message.

### 4.4 Agents execute actions through the real API

When an agent decides to "click the link" on an email action, it does **not** open a
headless browser. It calls the exact URL in the action as an authenticated HTTP
request, using a session cookie previously minted for the agent's account.

That works because the link is the same link a real browser would hit. The endpoint
doesn't know whether the request came from a real browser, a mobile app, or a sim
agent — it just validates the token, checks the session, and processes the action.
Live and sim take the same code path server-side, which is the whole point.

For flows that require client-side interaction (a multi-step form with
JavaScript-heavy validation), the agent falls back to **Playwright** in a headless
Chromium, driven against the same page a real user would see. This is slower and
needed only for the flows that aren't amenable to direct API calls.

Default is direct API. Playwright is the escape hatch, not the default.

### 4.5 Inbound replies

Real inbound email/SMS arrives via webhook (SendGrid inbound parse, Twilio webhook).
In sim mode, the agent calls those webhook handlers directly with a synthesized
payload. The handler doesn't care — it processes the payload the same way.

Result: the platform sees "a real reply came in" whether the sender was a real human
or a simulated one.

### 4.6 Failure modes the agent must simulate

Real humans do not respond instantly and correctly to every email. The simulation
must reproduce the full distribution of bad/late/missing responses, or else the
platform will pass every sim test and fall over in production.

Profiled failure modes:

- `pr(never_read)` — email filtered to spam; user never sees it.
- `pr(read_but_no_action)` — user reads and forgets.
- `pr(late_action)` — user acts after the SLA expires.
- `pr(wrong_action)` — user clicks "decline" instead of "accept."
- `pr(expired_token)` — user clicks the link after the token expired.
- `pr(stale_session)` — user clicks after their session expired; forces re-login.
- `pr(email_bounced)` — inbox full / address invalid.
- `pr(typo_in_reply)` — for free-form inbound, the reply is malformed.
- `pr(wrong_channel)` — user tries to reply via email to an SMS prompt or vice versa.

These are per-profile; a "conscientious_judge" profile has near-zero on most of these;
a "lazy_sponsor" has non-trivial `pr(never_read)` and `pr(late_action)`. Profiles in
§5.

---

## 5. Simulated human agents

### 5.1 One agent per account

For every sim account, a single background worker ("agent") runs continuously during
the sim. The agent tails its account's inbox (email + SMS + in-app notifications),
checks for pending platform tasks (judge-draw decisions, vote deadlines, motion
responses), and executes behaviors according to its profile.

Agents are **stateless between events**: everything they need to decide comes from
their profile, the account's current state on the platform, and their pending queue.
This keeps agent code simple and makes it trivial to replay a run by rehydrating from
the event log.

### 5.2 Behavior profiles

A profile is a bundle of parameters + a decision function. A seed library of profiles
covers the range the court will see in production.

```
profile {
  id: "conscientious_judge_mid_career"
  response_delay: { mean_hours: 6, p95_hours: 24, distribution: "lognormal" }
  pr_act_when_asked: 0.98
  pr_accept_draw: 0.85
  pr_decline_for_coi: 0.10
  pr_never_read: 0.001
  pr_wrong_action: 0.005
  weekend_available: false
  typing_style: "formal_legal"
  vote_model: { uses_evidence_embedding: true, calibration_noise: 0.05 }
  ...
}
```

Seed profiles:

**Judges:** `conscientious_mid_career`, `senior_traditionalist`, `busy_partner`,
`retired_federal`, `academic_careful`, `first_term_enthusiast`,
`burned_out_approaching_cliff`.

**Plaintiffs:** `civic_minded_first_time`, `repeat_filer`, `journalist_documenting`,
`disgruntled_insider`.

**Signer/Sponsors:** `highly_engaged`, `one_click_then_ghost`, `active_on_issue`,
`astroturf` (for adversarial runs).

**Defendants:** `retains_counsel_immediately`, `delays_then_responds`,
`defaults`, `fights_every_motion`.

**Staff / investigators:** `diligent_clerk`, `overworked_clerk`, `thorough_investigator`.

Profiles are **parameters of the sim run, not hard-coded**. A run can oversample a
profile to stress-test that pattern (e.g., 40% burned-out judges approaching the
cliff, to see whether the pool's throughput collapses).

### 5.3 Vote models

For judges, the most important decision is how they vote. The vote model is its own
sub-component of the profile:

- **Evidence-driven baseline.** The judge has access to the case record (evidence,
  motions, trial transcript-analog). An embedding of the record is produced at
  trial-close; the judge's vote probability is a function of an embedded "direction"
  feature.
- **Calibration noise.** A per-judge random-walk drift on top of the baseline, so
  even two "identical" profiles disagree sometimes. This is what makes the 12-of-15
  threshold meaningful in sim — everybody agreeing immediately is an unrealistic
  test.
- **Bias injectables.** For adversarial runs, a profile can have a bias term
  attached to a defendant feature (e.g., "this profile is 10% more likely to convict
  defendants of archetype X"). The system's audit infrastructure (§12 of the MDP
  doc) must detect this bias when present.
- **Deliberation interaction.** Jurors can be configured to be swayed by other
  jurors' arguments during deliberation — a second-pass vote that depends on the
  first pass. Or not. Both settings test useful properties of the threshold rule.

### 5.4 Deterministic action selection

Given the seed, the profile, and the current state, the agent's choice is a pure
function. The sim's top-level seed is split into per-agent seeds, so adding or
removing an unrelated agent doesn't change the behavior of the others — this is
critical for counterfactual runs (same population minus one actor, what happens?).

### 5.5 Agent lifecycle

- **Spawn** when the account is created.
- **Tick** whenever a relevant event lands in the agent's inbox (new email, SMS,
  in-app notification, platform-side deadline approaching).
- **Sleep** between events; the virtual clock is event-driven, so an idle agent
  costs zero wall time.
- **Retire** when the account is closed (e.g., a judge hits the cliff and exits).

---

## 6. Virtual clock & time acceleration

### 6.1 The clock is an adapter

All platform code reads time through a `Clock` adapter: `clock.now()`, `clock.sleep()`,
`clock.scheduleAt()`. In live mode the adapter is the wall clock. In sim mode it is a
virtual clock.

The codebase already has a pattern for this (see `src/lib/` subroutines that take
injectable clocks); the platform extends it to every service, including jobs, cron,
session expiry, and token TTL.

### 6.2 Event-driven advance

The virtual clock does not tick at wall-1-second intervals. It advances to the next
scheduled event:

- Next agent wake-up
- Next scheduled platform job (SLA deadline, token expiry, batch cron)
- Next external event injection (new filing arriving, public-salience spike)

Implementation: a min-heap of `(virtual_time, callback)` pairs. The runner pops the
earliest, advances the clock to its time, runs the callback, and repeats. A 6-month
simulation with sparse events runs in minutes of wall clock because the clock skips
over empty intervals.

### 6.3 Time-dependent features

- SLA deadlines are all expressed relative to `clock.now()`.
- Token expiry uses `clock.now()`.
- Rate limiters use `clock.now()`.
- Email "sent at" / "received at" use `clock.now()`.

This means live-mode rate limiting is real-seconds and sim-mode rate limiting is
virtual-seconds — both correct. The agent's response delay is drawn from its
profile's distribution and scheduled against `clock.now()`.

### 6.4 Real-time checkpoints during long sims

For very long sims (simulated years), periodic checkpoints dump the full event log
and a state snapshot to disk. A run can be paused, inspected, modified (e.g.,
profile tweaks), and resumed. This is what makes iterating on design possible.

---

## 7. Data isolation & safety

### 7.1 Layered kill-switches against real sends

Multiple independent layers, any one sufficient:

1. **Mode env var.** `RUN_MODE=sim` is required for sim; the live mail adapter
   refuses to load unless `RUN_MODE=live`.
2. **Adapter wiring at boot.** The mail module exports `createMailAdapter(cfg)`
   which returns either the live adapter or the sim adapter based on `cfg.mode`.
   There is no way for the platform to get a live adapter in sim mode without
   explicit override.
3. **Sim-only DB connection strings.** The sim schema/database has a name prefix
   (`court_sim_*`); the live adapter asserts on boot that the DB it connects to
   does not have that prefix, and vice versa. Wrong pairing fails fast with a
   non-recoverable error.
4. **Recipient domain whitelist.** In sim, outbound messages must have a recipient
   address in a `sim.local` domain. The sim mail adapter rejects anything else.
5. **Credential separation.** Real mail provider API keys are not available in the
   sim environment — the sim container does not have network access to the real
   mail provider.
6. **Pre-send smoke check.** Before sending its first message after boot, the live
   adapter sends a test message to an internal canary address and waits for
   confirmation. If the destination looks wrong (sim domain, test domain), it
   aborts.

Any of these catching a misconfiguration is sufficient. All six failing at once is
the scenario operators should never accept.

### 7.2 Separate environments

| Env              | Mode | Purpose                                                      |
| ---------------- | ---- | ------------------------------------------------------------ |
| `dev-local`      | sim  | Developer laptop; fast iteration                              |
| `sim-cloud`      | sim  | Cloud-hosted sim for full-scale runs, MDP training           |
| `staging-canary` | live | Real integrations, small whitelist of real users (team)       |
| `prod-pilot`     | live | Pilot deployment under oversight-board supervision            |
| `prod`           | live | Full public deployment                                        |

Sim runs never touch live envs. Live envs never load sim data. Environment is a
first-class config input, surfaced in every log line and audit record.

### 7.3 Seed databases

A sim run starts from a **seed database**: a set of accounts, a pool of judges with
profiles and credibility histories, an existing case backlog, a configured
oversight board. Seeds are versioned; changing the seed is a recorded event.

Common seeds:

- `v1-smoketest` — 100 judges, 50 cases, 500 signer/sponsors, minimal diversity
- `v1-steady` — 1,000 judges, target case volume, full profile diversity
- `v1-stress` — arrival × 2, complexity × 2, pool × 0.7
- `v1-adversarial` — embedded captured-judge cell, coordinated astroturfing signer/sponsors,
  pattern-filing defendant
- `v1-migration` — state frozen from a `staging-canary` export, so the policy can be
  pre-evaluated against near-real conditions before pilot launch

### 7.4 Audit log separation

Sim audit logs are in a separate storage tier with different retention and access
controls. A sim audit log can never be written to a live audit store and vice versa.

---

## 8. Observability & debugging

### 8.1 Run console

Every sim run has a web-UI console showing:

- Virtual clock + wall-time speedup ratio
- Queue depths per stage
- Active agents, per-profile counts, per-stage distribution
- Recent events (filterable)
- Policy decisions (with state + chosen action)
- Bias and fairness metrics rolling
- Escrow ledger totals

### 8.2 Time travel

Because runs are deterministic + event-logged, a user can:

- **Pause** a run at virtual time T.
- **Inspect** any agent's state, any case's state, any pending event.
- **Step** forward one event at a time.
- **Branch** from T with a modified parameter (e.g., different expedite threshold)
  and compare trajectories.

### 8.3 Replay

A failed test run can be exactly reproduced from `(seed, config, policy_hash)`.
This is a hard requirement — bugs that only reproduce "sometimes" are not acceptable
in court infrastructure.

### 8.4 Correlating sim to live

When the pilot is running, a parallel sim can run on the same arrival process (real
filings replayed into a sim instance at the same virtual time). Divergence between
sim and pilot on any metric is itself a signal — either the sim profiles need
updating or the live environment has a behavior the sim doesn't model.

---

## 9. Parallel DES engine (validation & prediction)

Alongside the platform-sim mode from §4–§8, the system ships a **second simulator** —
a standalone discrete-event simulator (DES) engine that models the court as abstract
entities and events, with **no platform code running**. No DB, no HTTP, no auth, no
mail, no browser. Pure simulation math.

The DES is not a replacement for the platform-sim. They solve different problems and
together they catch different classes of failure.

### 9.1 Why two simulators

The platform-sim is **full-fidelity**: it runs the real platform binary end-to-end
against synthetic agents that hit real endpoints. That's what catches real code bugs,
auth edge cases, template errors, and performance regressions. But it is too expensive
per simulated year for:

- **Policy sweeps** — varying a parameter (expedite threshold, pool size, reward
  weight) across 10–100 values, each evaluated on 100+ trajectories, to find an
  optimum.
- **Long-horizon dynamics** — the 3-year cliff rule only produces steady-state
  effects over 10+ virtual years; a pool-turnover study needs that horizon.
- **Ensemble stress-testing** — Monte Carlo over arrival shocks, adversarial
  scenarios, and profile mixes, at volumes where a single platform-sim run is already
  minutes.
- **RL training** — millions of trajectories for offline RL is plausible on a DES,
  implausible on a full-stack sim.

The DES is where those volumes happen. It's meant to run orders of magnitude faster
than the platform-sim — thousands of simulated years per wall-hour, not one simulated
year per wall-hour.

### 9.2 Two-simulator cross-validation

The platform-sim and the DES simulate the same court at two levels of fidelity. When
they **agree** on the core metrics (throughput, wait distribution, verdict rates,
capture-risk index), both are probably correct. When they **disagree**, that
divergence is itself a signal — one of them has a bug or a modeling gap:

- Platform-sim runs slower than DES projections? Look for inefficient code paths —
  the DES is predicting what "correct" code should achieve.
- Platform-sim wait times higher than DES? Maybe real queueing contention the DES
  abstracted away — lift the mechanism into the DES model.
- Platform-sim verdict distribution differs from DES? Agent profile miscalibration,
  or a vote-handling bug.
- DES predicts an adversarial attack succeeds but platform-sim shows the attack
  failing? Probably the DES is missing a platform-level defense (e.g., a rate limit
  that absorbed the attack). Either lift the defense into the DES model or confirm
  it's a real prod defense.

This dual-engine strategy is how you validate both the software and the model without
a live deployment. Either one alone is under-determined — the platform-sim can't
distinguish between "policy is good" and "policy + platform bugs balance out"; the
DES can't catch real code bugs.

### 9.3 DES architecture

Pure-function event-driven simulation:

- **State** — typed dictionaries: `cases`, `judges`, `sponsors`, `defendants`,
  `pool_config`, `policy_config`, counters. Immutable snapshots; mutations produce
  new state.
- **Event queue** — min-heap of `(virtual_time, event_type, payload)`.
- **Event handlers** — pure functions `(state, event) → (state', emitted_events[])`.
- **Runner** — pops the earliest event, applies its handler, schedules any emitted
  events, loops until terminal condition.
- **Policy adapter** — at decision points, calls the same MDP policy interface the
  platform uses. No policy code is duplicated.
- **No I/O except** — read: seed, config, policy, profile library. Write: event log,
  metric snapshots, ensemble output.

Implementation language: **TypeScript** (matches the codebase, lets us share types
with the platform — §9.8). A Rust rewrite is an option for speed-critical ensembles
later; the TypeScript implementation is the reference.

Deployment: standalone process, invoked via CLI for single runs and via a batch
orchestrator for ensembles. No web server, no DB connection (except optional
read-only access to logged real arrivals for replay studies).

### 9.4 Event taxonomy

Same as §8.1 of [mdp-corruption-courts.md](./mdp-corruption-courts.md). Authoritative
list:

- **Case lifecycle** — `case.filed`, `case.signature_ramped`, `case.accepted`,
  `case.rejected`, `stage.entered`, `stage.exited`, `stage.blocked`,
  `stage.expedited`, `verdict.rendered`, `verdict.appealed`, `verdict.final`,
  `disbursement.settled`.
- **Judge lifecycle** — `judge.drafted`, `judge.commissioned`, `judge.assigned`,
  `judge.struck_for_conflict`, `judge.reassigned`, `judge.vote_cast`,
  `judge.cliff_reviewed`, `judge.non_renewed`, `judge.retired`.
- **Signer/Sponsor lifecycle** — `sponsor.pledged`, `sponsor.captured`, `sponsor.withdrawn`,
  `sponsor.refunded`.
- **Defendant lifecycle** — `defendant.served`, `defendant.appeared`,
  `defendant.defaulted`, `defendant.appealed`.
- **System** — `policy.deployed`, `weights.changed`, `oversight.audit`,
  `oversight.flag`, `pool.drafted`, `pool.furloughed`, `cohort.reviewed`.

The event type names are **shared** between the DES and the platform's audit log.
When a platform-sim run emits `case.accepted`, the DES can ingest that event into
its model and continue; when the DES emits a trajectory of events, it is a valid
audit-log fragment. This is what makes cross-validation concrete.

### 9.5 Speed targets

Order-of-magnitude targets on commodity hardware (single machine, 16-core):

| Scale                        | Virtual duration | Target wall time       |
| ---------------------------- | ---------------- | ---------------------- |
| Smoke — 100 judges × 50 cases| 3 months         | < 1 second             |
| Steady — 1k judges × 2k cases| 5 years          | ~2–5 minutes           |
| Ensemble — 1k trajectories of steady | 5 years × 1k | ~1 hour (parallel) |
| Stress — 10× steady, ensemble| 5 years          | overnight              |
| RL-training — 1M trajectories| policy iter      | 8–24 hours             |

Platform-sim can't touch these at steady-scale — a single platform-sim run of 5
virtual years takes ~1 wall-hour minimum because it's moving real bytes through real
services. The DES moves integers through a priority queue.

### 9.6 Parallelization

Across independent runs: **embarrassingly parallel**. Different seeds → different
trajectories → no coordination needed during execution. A worker pool runs N
trajectories in parallel; a coordinator aggregates metrics on completion. Scales
linearly with cores.

Within a single run: DES is intrinsically serial (events must be applied in causal
order). But subsystems with no cross-entity interaction during a virtual-time
interval can be batch-applied — e.g., credibility-score nightly batch updates touch
many judges but don't interact, so they fold into a single state transition.

For very large single runs (e.g., 10,000-judge, 20-year horizons), the engine can
**spatially partition** by non-interacting case subsets and run the partitions in
parallel between rendezvous points (pool-sizing decisions, governance actions). This
is advanced and not needed at the target scales.

### 9.7 Outputs

Per single run:

- **Full event log**, compressed, replayable. Any analysis can be re-derived from
  it.
- **Stage metrics** — arrival rate, service rate, queue depth, wait p50/p95/p99,
  per stage and rolling.
- **Per-actor metrics** — per-judge throughput, per-judge credibility trajectory,
  per-signer/sponsor pledge/refund history, per-defendant case count.
- **Fairness slices** — per conduct-archetype wait, expedite rate, assignment pool
  size, outcome distribution.
- **Capture-risk index** — rolling composite.
- **Policy trace** — every decision the policy made, state snapshot at decision, and
  downstream reward.

Per ensemble:

- **Metric distribution** — mean, median, p95, p99, stddev, across trajectories.
- **Confidence intervals** on policy returns.
- **Failure-rate** — fraction of trajectories breaching a hard threshold (e.g.,
  p95 wait > SLA, or capture-risk > ceiling).
- **Counterfactual deltas** — when comparing two policies on matched seeds, the
  per-trajectory reward delta and its distribution.

### 9.8 Shared specification with the platform

The DES and the platform **must agree** on:

- **Event taxonomy** — same type names, same payload shapes, same semantics.
- **Metric definitions** — how wait time is measured, what counts as a completed
  stage, how capture-risk is composited.
- **State shape** — conceptually; the DES doesn't need DB rows, but its state
  types mirror the platform's.
- **Policy interface** — the MDP's `decide(state, actionSpace) → action` contract.

Implementation: a shared TypeScript package (`@court/shared-types`) imported by both
engines. Type drift is a build error in CI, not a runtime surprise. The audit log
format is defined once and consumed by both.

### 9.9 Calibration against platform-sim

Standing pre-flight test, run on every main-branch commit:

1. Pick a reference scenario (e.g., smoke seed + fixed policy).
2. Run platform-sim. Record aggregate metrics.
3. Run DES on the same seed. Record aggregate metrics.
4. Compare. Divergence > threshold (e.g., 5% on throughput, 10% on p95 wait) fails
   CI.

When CI fails, one of four things: platform bug, DES model gap, agent-profile drift,
or an intentional change nobody remembered to propagate to both. Whichever it is,
catching it at commit time is cheaper than catching it after a policy has been
trained on bad data.

### 9.10 Use cases specific to the DES

Things the DES does that the platform-sim can't do at practical scale:

- **Policy sweeps.** Expedite threshold from 0 → 1 in 50 steps × 100 trajectories
  each = 5,000 runs. Pick the best. Impossible via platform-sim.
- **Pool-sizing sensitivity.** Throughput at 800, 900, 1000, 1100, 1200 judges.
  Ensemble per size. Produces the curve governance needs to defend its pool-size
  choice.
- **Arrival-shock analysis.** Worst-case response to a 10× filing spike from a
  political event. Monte Carlo over shock timings relative to pool state.
- **Long-horizon cliff dynamics.** 10-year runs to study steady-state pool quality
  under the 3-year cliff. Reveals whether the cliff rule actually raises quality or
  just churns.
- **Counterfactuals on structural rules.** "What if we didn't have per-stage
  rotation?" Run ensembles of both and compare capture-risk distributions — the
  strongest possible evidence for keeping the rule.
- **Reward-weight sensitivity.** How much does the optimal policy change if the
  wait-time weight moves from 0.3 to 0.5? Matters for governance's weight-setting
  discussions.
- **Adversarial simulation at scale.** 1,000 runs each with different adversary
  configurations (captured cell size, astroturf scale, coordinated filing
  patterns) to characterize when defenses hold vs. break.

### 9.11 Integration with the MDP trainer

The DES is the workhorse training environment for offline RL and model-based RL:

- Trajectory generation is fast enough that millions of samples are accessible.
- Perfect observability — every state feature and reward component is
  readable without DB queries.
- Configurable stress — training on ensemble distributions that cover tail
  scenarios produces policies robust to them.
- Reproducible seeds — the same training data can be regenerated for ablations.

Pipeline (extending §11.3 of the MDP doc):

1. **DES ensemble eval first.** A candidate policy must win on DES ensemble metrics
   against the incumbent — headline reward, fairness slices, stress tails — before
   any further step.
2. **Platform-sim eval second.** Winners on DES go to platform-sim for full-stack
   verification. Mostly a sanity check that the model-to-code translation holds.
3. **Shadow / canary / staged** proceeds as in the MDP doc.

The DES gate is cheap (minutes) and filters out most bad candidates; the platform-sim
gate is expensive (hours) but definitive for fidelity. Ordering matters.

### 9.12 Limits of the DES (why platform-sim is still required)

Things the DES cannot catch — and why the platform-sim stays in the pipeline:

- **Real code bugs.** DB race conditions, auth edge cases, API 500s, N+1 queries,
  timezone errors, token-entropy bugs, session fixation. The DES doesn't run that
  code, so it can't observe those failures.
- **Template and rendering bugs.** Email missing a CTA, broken HTML, wrong
  language, wrong placeholder substitution.
- **Client-side bugs.** React form state, router edge cases, optimistic UI drift.
- **Performance regressions.** A slow query at 100 req/s might be fine; at 10,000
  req/s it's a p99 disaster. Only platform-sim exercises real infra.
- **UX issues.** A correct system that confuses users is still a broken system in
  practice.
- **Adversarial patterns that exploit implementation details** — a well-crafted
  attack on a specific framework version, not on the abstract model.

**Rule of thumb.** The DES validates the model; the platform-sim validates the
software. Both must pass before a change ships.

---

## 10. Integration with the MDP controller

The policy controller from [mdp-corruption-courts.md](./mdp-corruption-courts.md) runs
inside the sim the same way it runs in live:

- Reads state from platform DB via the same subroutines.
- Writes decisions to `mdp_decisions` via the same writer.
- Executes actions via the same platform API endpoints.

The difference is only the clock and the adapters. A policy that works in sim runs
on the same code path in prod; a policy that fails in sim fails in prod.

This is what makes the evaluation pipeline in §11.3 of the MDP doc feasible: when
the pipeline says "run the candidate policy on the last 6 months of logged
arrivals," that is a sim run with `live` arrivals replayed as injected events, and
the candidate policy handling every decision point through its normal interface.

### 10.1 Outcome reconstruction

The sim produces outcomes (verdicts, appeals, escrow disbursements) in virtual-time
order. These feed `court_flow_outcomes` the same way real outcomes would. The MDP
trainer can operate on sim-generated outcome rows indistinguishably from live rows —
the `surface` field on the decision row names the run so training jobs can mix or
filter appropriately.

### 10.2 Sim-only vs. blended training

For very new policies, the MDP trains primarily on sim-generated data (because no
live data exists). As live data accumulates, the trainer shifts weight toward live
under the pattern in §11.6 of the MDP doc. The mixing ratio is itself a governance
choice, not a hidden parameter.

---

## 11. Robustness checklist

A running list of failure modes and countermeasures. Anything caught by a real
incident gets added; removed only after post-mortem.

| Failure mode                                                           | Countermeasure                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Sim accidentally sends a real email                                    | Six-layer safety (§7.1); any single catch is sufficient                              |
| Live binary accidentally loads a sim DB                                | DB-name prefix assertion at boot                                                    |
| Agent LLM-parsing breaks on template change                            | Structured action manifest (§4.1); no prose parsing                                 |
| Agent decides differently on re-run with same seed                     | Fully seeded RNGs per agent; pure decision function                                 |
| Sim passes but prod fails because agents were too agreeable            | Failure-mode probabilities required in every profile (§4.6); adversarial seeds       |
| MDP trains on sim that doesn't match reality                           | Sim-to-live divergence monitoring (§8.4); profile calibration against pilot         |
| Policy controller writes to prod from sim                              | `mdp_decisions` row has `env` field; writes asserted against run mode               |
| Sim run too slow for MDP training                                      | Event-driven clock (§6.2); profile cache; per-agent-seed parallelism across runs    |
| Clock drift between services during sim                                | All services read clock through the same adapter; no service has its own wall clock |
| Real judge profile leaks into sim (PII)                                | Sim seeds use synthetic-only identities; audit on seed load                         |
| Browser-only flow can't be agent-driven                                | Playwright escape hatch (§4.4) for the few flows that need it                        |
| Webhook handlers drift between live and sim behavior                   | Same webhook handler code path; sim calls the handler directly                      |
| Deterministic seed changes because of code changes (e.g., map order)   | RNG consumers use explicit keying, not iteration order; enforced in CI              |
| Escrow adapter accidentally charges a real card in sim                 | Stripe test-mode keys; sim cards never match a real PAN; webhook delivery assertion |
| Audit log filled with sim entries that mask live signal                | Separate log stores (§7.4); no ambiguity about which store to query                 |
| Adversarial sim result (e.g., policy exploits sim quirk) ships to live | Evaluation pipeline (§11.3 of MDP doc) requires stress + adversarial gates pre-live |

---

## 12. Rollout plan

1. **Platform skeleton** with auth, accounts, and the adapter interfaces. No business
   logic yet — just the ability to log in, create accounts, and send a
   "hello" email through both live and sim adapters.
2. **Case intake + signature + escrow pledge** in both modes. First end-to-end flow
   a plaintiff can complete, with signer/sponsors responding via sim-agents.
3. **Judge pool + commit-reveal assignment** with synthetic judges. Verify rotation
   and COI strikes work, publicly-verifiable seeds, and draw audit log.
4. **Full stage workflow** — screening, collision review, investigation, motions,
   trial, verdict, appeal, disbursement. Shadow-mode MDP controller reading state.
5. **Sim-agent behavior profile library** to cover the range of actor behaviors the
   court will see. First calibration is theoretical; iterative calibration against
   staging and pilot data later.
6. **Full-scale sim runs** — 1,000 judges, target case volume, multi-year virtual
   duration. Shake out performance + correctness at scale.
7. **Adversarial sim suite** — embedded captured judges, coordinated signer/sponsors,
   pattern-filing defendants. Verify audit + credibility detection.
8. **Staging canary** with real integrations and whitelisted team accounts. Real
   emails sent to real team inboxes.
9. **Pilot deployment** under oversight-board supervision, limited case volume,
   screening-tier only. Shadow MDP continues; live decisions made by humans with
   controller recommendations.
10. **Staged rollout** of policy-controlled action classes per §11.3 of the MDP
    doc — screening, then inquiry, then trial-tier, each gated on sim + canary
    metrics holding.
11. **Full production** once the oversight board signs off per the governance
    charter.

Each step produces a published artifact (benchmark, evaluation report, audit) — the
rollout itself is a public record.

---

## 13. User roles & identity model

[§2](#2-actor-taxonomy--who-gets-an-account) describes *who* gets an account. This
section specifies how those actors are represented in the software as **roles on user
records**, how permissions are enforced, and how the role system extends the pattern
already in the codebase at
[src/lib/isomorph/roles/dd-roles-2.ts](../src/lib/isomorph/roles/dd-roles-2.ts).

The pattern is reused, not reinvented: every authenticated human has the base `isUser`
flag plus any number of specialized role flags, and **each role flag carries its own
independent status**. A permission check is always a pair — the boolean must be true
AND the status must be `ACTIVE`.

### 13.1 Role shape — extending `UserRolesInfo`

The existing `UserRolesInfo` type already defines the shape (boolean + status) for
`isUser`, `isOwner`, `isAdmin`, `isEng`, `isOps`, `isHR`, `isCoach`, `isClient`,
`isCustomerSuccess`, `isCoachSuccess`, `isExp`. Court deployment keeps those (the
operational staff roles carry over unchanged) and adds court-specific roles following
the same pattern:

```ts
// Extensions to UserRolesInfo (src/lib/isomorph/roles/dd-roles-2.ts)

isCommissioner?: boolean;          commissionerStatus?: RoleStatus;
isJudge?: boolean;                 judgeStatus?: RoleStatus;
isPeerReviewer?: boolean;          peerReviewerStatus?: RoleStatus;
isOversightBoard?: boolean;        oversightBoardStatus?: RoleStatus;
isAuditor?: boolean;               auditorStatus?: RoleStatus;
isOmbuds?: boolean;                ombudsStatus?: RoleStatus;
isIntakeReviewer?: boolean;        intakeReviewerStatus?: RoleStatus;
isParalegal?: boolean;             paralegalStatus?: RoleStatus;
isInvestigator?: boolean;          investigatorStatus?: RoleStatus;
isClerkOfCourt?: boolean;          clerkOfCourtStatus?: RoleStatus;
isComplianceMonitor?: boolean;     complianceMonitorStatus?: RoleStatus;
isCounsel?: boolean;               counselStatus?: RoleStatus;
isSponsor?: boolean;               sponsorStatus?: RoleStatus;
isPress?: boolean;                 pressStatus?: RoleStatus;
isApiIntegration?: boolean;        apiIntegrationStatus?: RoleStatus;
isSimAgent?: boolean;              simAgentStatus?: RoleStatus;
```

Helper functions follow the pattern of `isOwner` / `isAdmin` / `isCoach` already in
the file:

```ts
export const isJudge = (v?: DDNullish<UserWithRoles>) => {
  const roles = v?.roles as UserRolesInfo | null | undefined;
  if (roles?.isUser !== true) return false;
  return roles?.isJudge === true
      && !!roles?.judgeStatus
      && goodStatus.includes(roles.judgeStatus as RoleStatus);
};
// ...isCommissioner, isParalegal, isOversightBoard, etc.
```

### 13.2 Role catalog

Roles group into five tiers by trust and purpose. Institutional roles are global
(one assignment per user); case-scoped roles live in a separate table (§13.4).

#### Institutional — platform operators

| Role             | Maps to actor in §2            | Analogous existing role | Notes                                                                                  |
| ---------------- | ------------------------------ | ----------------------- | -------------------------------------------------------------------------------------- |
| `commissioner`   | Platform owner                 | `owner`                 | The operating entity's principal (§2 of the court plan's 501(c)(3)/(4)). Rename of `owner` for court context; either the existing `isOwner` field is reused or `isCommissioner` is a court-specific alias — pick at implementation time. |
| `admin`          | Platform admin                 | `admin`                 | Unchanged.                                                                             |
| `eng`            | Engineering                    | `eng`                   | Unchanged, but **court-specific write restrictions** on `mdp_decisions`, credibility, and assignment records — enforced in code per the 4-eye rule in §12.1 of the MDP doc. |
| `ops`            | Operations                     | `ops`                   | Unchanged — used for SLA monitoring, block escalation.                                 |
| `support`        | Actor-facing support           | `customerSuccess`       | Unchanged. Read-mostly.                                                                |
| `hr`             | HR for commissioned judges + staff | `hr`                | Unchanged.                                                                             |

#### Judicial — panel and oversight

| Role                    | Maps to actor in §2 | Notes                                                                                   |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `judge`                 | Commissioned judge  | Status lifecycle: `PENDING` (pre-commission) → `ACTIVE` → `SUSPENDED` / `ALUMNI` (post-cliff, §5 of MDP doc). Seniority band is a separate attribute, not a distinct role. |
| `peer_reviewer`         | Peer reviewer       | Subset of `judge` — auto-derived from credibility band plus cohort filter, stored as an explicit flag so queries are simple. |
| `oversight_board`       | Board member        | Up to 9 simultaneously (§12.1 of MDP doc). Held in addition to `judge` or an external civic role. |
| `auditor`               | External auditor    | Rotated ≤3 years (§12.4 of MDP doc). Read-only across ops/code/governance.              |
| `ombuds`                | Ombuds              | Whistleblower custodian. Independent reporting line; write access only to `ombuds_reports`. |

#### Support / staff — case-work

Case-scoped unless otherwise noted.

| Role                    | Maps to actor in §2     | Notes                                                                          |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `paralegal`             | Clerk / court staff     | Supports judges and panels with research, docket management, document prep. Case-scoped. Elevated read; no voting. |
| `investigator`          | Investigator            | Stage-3 work (§2.1 of MDP doc). Case-scoped; rotation constraints apply.       |
| `intake_reviewer`       | Clerk / court staff     | Stage-0 intake/KYC reviewer. **Global, not case-scoped.**                      |
| `clerk_of_court`        | Clerk / court staff     | Runs vote-capture UX and logs procedural events for a specific panel. Case-scoped. |
| `compliance_monitor`    | Third-party monitor     | Under an injunctive sentence (§13.5 of MDP doc). Case-scoped.                  |
| `counsel`               | Defendant counsel       | Attorney of record. Case-scoped. Plaintiffs may also have counsel.             |

#### Case parties — non-staff

Always case-scoped. Same natural person may be plaintiff on case A, signer/sponsor on case B,
witness on case C.

| Role          | Maps to actor in §2 | Notes                                                     |
| ------------- | ------------------- | --------------------------------------------------------- |
| `plaintiff`   | Plaintiff           | Named filer on a case.                                    |
| `defendant`   | Defendant           | Named respondent on a case.                               |
| `sponsor`     | Signer/Sponsor      | Pledged signature + escrow on a case — the signature is the funding commitment; there are no money-less signatures. Signer/sponsors login, pledge, fund, cast **dollar-weighted priority votes** across open cases, post and update sponsor testimony, track progress, receive disbursements, and can withdraw before capture subject to terms. Case-scoped. The canonical compound term is "signer/sponsor" — `sponsor` is the storage/role-name form. |
| `witness`     | — (new)             | Disclosed witness in discovery.                           |
| `panel_juror` | — (new)             | Seated on the trial panel for a specific case.            |
| `appeal_judge`| — (new)             | Seated on the appeal panel for a specific case.           |
| `presiding_juror` | — (new)         | Elected presiding juror on a specific case.               |

#### Public / automation

| Role              | Maps to actor in §2       | Notes                                                                        |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `press`           | Press / academic / public | Optional signup with a read extension (e.g., docket annotation, API quota).  |
| *(anonymous)*     | Anonymous public reader   | No account; read-only access to the public docket only. Not a role per se.   |
| `api_integration` | —                         | Service accounts for Stripe Treasury, KYC provider, mail gateway, SMS gateway, etc. Scoped to specific allowed operations. |
| `sim_agent`       | —                         | Principal for simulated-human agents (§5). **Hard-gated to sim mode only** (§13.6). |
| `bot`             | —                         | Internal automation workers (credibility pipeline, reward computation, MDP controller). Not user-identity-mapped. |

### 13.3 Status lifecycle

Statuses drawn from the existing `RoleStatus` enum (`ACTIVE`, `PENDING`, `BANNED`,
`DECLINED`, `SUSPENDED`) plus a court addition:

- `ALUMNI` — for `judge` status. Set when a judge is non-renewed at the 3-year cliff
  (§5 of MDP doc) or voluntarily resigns in good standing. Alumni preserve history and
  may still hold `peer_reviewer` or `oversight_board` status, but cannot be drawn onto
  new panels.

Status transitions that matter:

| Transition                                  | Who authorizes                                         |
| ------------------------------------------- | ------------------------------------------------------ |
| `judge` PENDING → ACTIVE                    | Oversight-board commissioning action                   |
| `judge` ACTIVE → SUSPENDED (operational)    | `admin` for narrow cause (mid-case conflict, etc.)     |
| `judge` SUSPENDED → ACTIVE                  | Oversight-board action                                 |
| `judge` ACTIVE → ALUMNI (cliff)             | Automatic at 3-year anniversary per §5 of MDP doc      |
| `judge` ACTIVE → BANNED                     | 2/3 oversight-board supermajority                      |
| `oversight_board` ACTIVE                    | Charter-defined selection (§12.1 of MDP doc)           |
| `auditor` ACTIVE                            | Vendor onboarding + oversight-board approval; ≤3y      |
| `commissioner` ACTIVE                       | Charter action; singular                               |
| any role → BANNED                           | Governance action + logged in `role_grant_events`      |

### 13.4 Case-scoped roles

Global roles (institutional, judicial, oversight, automation) live on the user record
as the `UserRolesInfo` shape. Case-scoped roles are many-to-many and live in a new
table:

```sql
case_participants (
  case_id          uuid      not null,
  user_id          uuid      not null,
  role             text      not null,   -- plaintiff, sponsor, panel_juror, paralegal, ...
  status           role_status not null,
  granted_at       timestamptz not null,
  granted_by       uuid      not null,   -- the user who authorized the grant
  granted_by_policy_version  text null,  -- for controller-driven grants (panel seating)
  ended_at         timestamptz,
  ended_reason     text,
  primary key (case_id, user_id, role)
)
```

Panel seatings (`panel_juror`, `appeal_judge`, `screening_judge`, `collision_reviewer`,
`motion_judge`, `presiding_juror`) are themselves case-scoped roles — seating a juror
*grants* `panel_juror` for that case, which unlocks the voting UI. Seating records are
append-only and mirrored to the public docket.

Every permission check takes both layers:

```ts
canAccess(user, { caseId, action }):
  roles.global satisfy the action's global floor, AND
  case_participants(user_id, caseId) satisfy the action's case floor, AND
  no unresolved COI flag on (user, caseId)
```

### 13.5 Role-grant rules

Grants are audited, policy-gated, and exclusivity-checked.

- **Every grant is an event.** Each flip of a role flag — global or case-scoped — is a
  row in `role_grant_events` with actor, timestamp, authorizing policy version (if
  controller-driven), and reason. This is the audit-log obligation from §3.2.
- **COI check runs before case-scoped grants commit.** Seating a judge, counsel, or
  paralegal on a case runs the conflict-vector check (§3.1 of MDP doc). Conflicts
  block the grant; the commit-reveal lottery (§3.2 D of MDP doc) has already filtered
  the pool, so this is a backstop rather than the primary filter.
- **Exclusivity at grant time.** Failed-closed rules:
  - A user cannot hold `commissioner` + `judge` simultaneously.
  - A user cannot be `plaintiff` and `defendant` on the same case.
  - A user cannot be `sponsor` on a case where they are also `plaintiff`, `defendant`,
    `counsel`, `panel_juror`, `appeal_judge`, `paralegal`, `investigator`, or
    `clerk_of_court` — dollar-weighted influence must stay independent of case-party
    or adjudicator status.
  - A user cannot hold `auditor` while also holding `admin`, `eng`, or
    `commissioner` (auditor independence).
  - A user assigned to stage *k* of case *c* cannot be assigned to any other stage of
    the same case (the Lava-Jato rotation rule, per §2.1 of MDP doc).
  - An `oversight_board` member cannot sit on panels for the duration of their board
    term (capacity-bounded per §12.1 of MDP doc).
- **Separation of duties on role authorization.** The role(s) authorizing a grant
  cannot be held by the same user being granted. Commissioning a new judge requires a
  `commissioner` action + an `oversight_board` approval — the incoming judge cannot
  be either signatory.
- **Status transitions policy-gated.** See §13.3 table.

### 13.6 Sim-mode role rules

Mirrors the six-layer safety from §7:

- **`sim_agent` is the only role that can authenticate in sim mode without a matching
  live user.** All other roles can run in sim mode, but only using their live
  credentials — the sim run inherits the live user's role set for that user.
- **A `sim_agent` user cannot authenticate in live mode.** Enforced at the auth
  boundary; attempted live login as a `sim_agent` is a tripwire with alert.
- **Sim role records are partitioned** from live role records by the `mode` key that
  separates `sim_emails` from live emails. No cross-mode queries without an explicit
  `ANY` mode, which requires `eng` or higher and is itself logged.
- **Behavior profiles (§5) attach to `sim_agent` users, not to live users.** A live
  user signing in during a sim replay for debugging does not get a profile override.

### 13.7 Impersonation & support access

Support staff need impersonation for debugging, and the rules for it must not create
a capture surface.

- **Time-boxed with reason.** Every impersonation writes an audit record with explicit
  reason; session expires in ≤60 minutes; renewal logs separately.
- **Hard-gated roles that cannot be impersonated, ever:** `judge`, `oversight_board`,
  `auditor`, `ombuds`, `panel_juror` (while seated), and `commissioner`. These roles
  have view-your-own-data-only guarantees baked into the legitimacy story.
  Reproducing bugs against them uses synthetic test data or `sim_agent` accounts.
- **Defendant impersonation requires defendant consent**, written, captured in the
  audit record. Same for plaintiff.
- **Sim-mode always available** as a substitute for impersonation: reproducing issues
  against `sim_agent` accounts needs no impersonation ceremony.

### 13.8 Identity resolution — one person, many hats

One natural person = one `isUser` identity. Roles accrete over time without creating
new user records:

- A signer/sponsor becoming a plaintiff on a different case: same user, new case-scoped role.
- A judge candidate commissioned: same user, `judgeStatus: PENDING → ACTIVE`.
- A commissioned judge rolling off at the cliff: same user,
  `judgeStatus: ACTIVE → ALUMNI`.
- A plaintiff later sued as a defendant (unusual but possible): same user, new
  case-scoped role on the new case.

Identity resolution for **defendants** — especially the recidivism graph in §13.7 of
the MDP doc — uses the same user model. Corporate defendants and other legal entities
get user records with an `isLegalEntity` attribute (and no auth credentials unless
they're claimed by an authorized officer). Beneficial-ownership edges between natural
and legal persons live in a graph on top of the `users` table, reused by the COI
check and the recidivism tracker.

### 13.9 Mapping to existing codebase

- The boolean + status pattern is already in
  [dd-roles-2.ts](../src/lib/isomorph/roles/dd-roles-2.ts); extensions slot in as new
  fields on the `UserRolesInfo` type and new helper functions matching the existing
  `isOwner` / `isAdmin` / `isCoach` style.
- The `USER_ROLES` constant at `src/constants/constants.ts` and the `UserRole` enum
  at `src/constants/enums.ts` both gain the court-specific role names.
- The `rolesLookup` table (referenced by `hasRole` and `getRoleStatus`) gains matching
  entries so the generic helpers work unchanged on the new roles.
- Existing sidebar permission gating (`src/components/sidebar/sidebar.tsx` and
  related) extends to gate court-specific UI surfaces.
- The `case_participants` table is new — no direct analogue. The current app's
  coach-client model is 1:1 per engagement; court cases are many-to-many with roles
  per party, so this can't reuse the existing staff-change-history pattern and needs
  its own table.
- Existing staff roles (`eng`, `ops`, `hr`, `customerSuccess`, `coachSuccess`, `exp`)
  carry over and are reused for court operations.

### 13.10 Open role-design questions

- **`owner` vs. `commissioner`.** Reuse the existing `isOwner` for the court's
  commissioner (simpler; one field), or add `isCommissioner` as a distinct flag
  (more readable, but two sources of truth). Tentative: reuse `isOwner`, treat
  "Commissioner" as a display name.
- **Sponsor dollar-vote integration with the MDP.** Dollar-weighted priority votes
  should feed into the controller's admission and priority decisions (§3.2 A and B
  of the MDP doc) as a signal — how heavily to weight them, and how to guard against
  funding-magnitude capture of court capacity, is a governance-design question
  distinct from the role model.
- **Signer/Sponsor identity depth.** Does `sponsor` need a full account, or is an
  email-verified light identity enough until they sign a second case and graduate?
  KYC-light at signing (§12.1 of MDP doc) argues for full account; UX argues for the
  lighter path.
- **Legal-entity modeling.** Users table with `isLegalEntity=true`, or a parallel
  `entities` table with join rows? The recidivism graph needs both natural and legal
  persons in the same identity model, which pushes toward the unified table.
- **Oversight-board staff.** If a board member has their own staff (research,
  scheduling), do those staff get roles? Currently not modeled.
- **`peer_reviewer` as derived flag.** Keep it as an explicit flag, or compute on
  demand from `judge.credibility` + cohort filter? Explicit is simpler to query and
  audit; derived avoids a stale-flag failure mode.

---

## 14. Open questions

- **Vote-model calibration against reality.** How do we produce realistic
  judge-vote models without real-judge training data? Candidates: anonymized bar-
  disciplinary-panel voting patterns, law-review scholarly-consensus measures,
  mock-trial data from law schools. Governance should bless the calibration source.
- **KYC provider in sim.** Do we mock the KYC provider entirely, or run a "test
  mode" against the real provider's sandbox? Sandbox gives better coverage but
  adds a dependency; mock is simpler but risks missing provider-edge-case bugs.
- **Sim-to-live profile drift.** As the pilot runs, profiles should be updated to
  match observed behavior. What's the cadence and who approves the updates?
- **Agent evolution across a sim run.** A first-term-enthusiast judge becoming a
  burned-out-approaching-cliff judge is a real trajectory. Do we model profile
  transitions, or keep profiles static within a run and rely on cohort mixing?
- **Cost of Playwright fallback at scale.** If more flows than expected need it,
  sim runtime explodes. Do we restructure client-heavy flows to be API-drivable
  server-side, or invest in parallel Playwright farms?
- **Public docket indexing under sim load.** Full-text search at 10× arrival rate
  will stress the indexer; is this worth simulating before prod, or is it a
  well-understood scale problem we can handle with standard infra?

---

## 15. Next steps

1. Stand up the adapter interfaces for mail, SMS, clock, payment — all six live/sim
   pairs, with the six-layer safety from §7.1 in place from day one.
2. Build the `sim_inbox` + `sim_sms` + `sim_inbound` schema and the basic sim-agent
   worker; exercise end-to-end with a toy signup flow.
3. Specify the first five behavior profiles (conscientious judge, busy partner,
   engaged signer/sponsor, lazy signer/sponsor, diligent clerk) precisely enough to implement.
4. Wire up the event-driven virtual clock across all platform services and verify
   determinism under load.
5. First sim run: 100 accounts, one case, full happy-path through filing →
   signature → screening. Metric: reproducibility under identical seed.
