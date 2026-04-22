# MDP / Contextual Bandit — Outbound Email Outreach (Template × ICP × Source)

This document describes how to extend the MDP framework from
[`mdp-for-notifs-and-more.md`](./mdp-for-notifs-and-more.md) to two
**outbound-email** decisioning surfaces:

1. **`outbound_email`** — per-send: should we send at all, which
   template, which tone, which from-pool, and when? Conditioned on
   recipient features (email type, ICP, prior history) and campaign
   features (template, sender reputation, sending window).
2. **`email_source`** — per-enrichment-request: which provider
   (`hunter.io`, `apollo.io`, `zoominfo`, our own web scrape, …) should
   we pay to resolve contacts for a given segment? Budgeted learner.

Both surfaces share the outcome stream — bounces, opens, clicks,
replies, unsubscribes — which also powers a **template × ICP fit**
model that generalises across new templates and new ICPs via shared
embeddings. That third system is not a separate surface; it is the
shared-parameter scorer that `outbound_email` uses to compute its
template-action Q-values.

It builds on the infra already shipped for notifications and scraping
escalation:
[`mdp_decisions`](../src/server/databases/neondb/tables/mdp-decisions-table.ts)
(shared decision log — add two new `surface` values),
[`mdp-decision-writer.ts`](../src/server/subroutines/mdp/mdp-decision-writer.ts)
(persistence gate), the executor-layer pattern from
[`mdp-notif-executor.ts`](../src/server/subroutines/mdp/mdp-notif-executor.ts)
(shadow / canary / live), and the similar-entity blend from
[`mdp-user-embeddings.ts`](../src/server/subroutines/mdp/mdp-user-embeddings.ts).

---

## 1. Scope

What this doc covers:

- The state/action/reward shape for outbound email.
- How template × ICP fit is modelled (shared-parameter scorer + per-cell
  Q-residual; no separate `template_fit` surface).
- The parallel bandit over enrichment **sources** — so we actually
  learn whether `hunter.io` is worth its per-contact cost on SaaS
  mid-market versus `apollo.io` on healthcare SMB, or whether our own
  scraping + Gemini pipeline beats both.
- Supporting data: `icps`, `company_icp_assignments`,
  `outreach_templates`, `outbound_email_sends`,
  `outbound_email_outcomes`, `email_source_runs`,
  `template_embeddings`, `icp_embeddings`.
- Staged wiring into the live outbound pipeline without sending a
  single extra email until the policy is explicitly turned on.

What it does **not** cover:

- The transport layer (SES, SendGrid, etc.). The executor calls the
  existing send primitive; we don't touch delivery.
- Reputation management of sender domains / mailbox warmup. Warmup is
  a state feature, not a learned decision here.
- Sequence orchestration (step 1 → step 2 → step 3 of a drip).
  Multi-step is a deliberate follow-up — §5.1 covers why the MVP is a
  contextual bandit per send and how the MDP extension lands later.

---

## 2. Cron surface

New actions on [`/api/cron/mdp`](../src/app/api/cron/mdp/route.ts),
alongside the existing notif / feed / escalation / propensity actions:

| Action | Purpose | Notable params |
| ------ | ------- | -------------- |
| `score-outbound` | score a batch of pending outbound-email candidates | `runBatchId` or `sendIds` |
| `choose-source` | pick the enrichment provider for a segment | `segmentId`, `contactsNeeded` |
| `assign-icps` | (re-)compute `company_icp_assignments` | `since`, `companyIds` |
| `train-outbound` | nightly trainer over logged decisions + outcomes | — |
| `train-source` | nightly trainer over source provider outcomes | — |

Status action includes the two new surfaces so the control plane can
confirm they are live before wiring any executor.

---

## 3. MDP formulation

Two surfaces; one shared featurizer module
(`src/server/subroutines/mdp/mdp-outbound-features.ts`, planned) so the
same recipient features can feed both the per-send bandit and the
source bandit. Same shape as
[`mdp-types.ts`](../src/server/subroutines/mdp/mdp-types.ts).

### 3.1 Outbound email (per-send)

#### State (`OutboundEmailState`)

Built per candidate send by
`buildOutboundEmailState({ contactId, campaignId, now })`:

- **Recipient features**
  - `emailKind` — one of `corporate | freemail | role_alias | unknown`
    (role aliases = `info@`, `sales@`, `hello@`)
  - `sourceProvider` — which enrichment source delivered this email
    (`hunter | apollo | zoominfo | own_scrape | manual | unknown`)
  - `enrichmentAgeDays` — days since the source confirmed this address
  - `domainReputationPrior` — our own per-domain bounce rate (EWMA)
  - `priorSendsToThisDomain24h / 7d / 30d` — fatigue at the domain
    level (SaaS mail servers punish volume, not per-inbox)
  - `priorSendsToThisAddress30d` — per-inbox fatigue
  - `priorOpensToThisAddress30d`, `priorRepliesToThisAddress30d`
  - `unsubscribedFlag`, `hardBounceFlag`, `complaintFlag` — **hard
    rails**, not features: if any is true the policy must pick `skip`
    (see §8).
- **ICP / company features**
  - `icpId` — the ICP this company is currently assigned to (from
    `company_icp_assignments`; null until assigned)
  - `icpMatchScore` — the match confidence for `icpId`
  - `companyEmbedding` — from the existing company-embedding pipeline,
    optional; used only by the shared-parameter scorer (§3.3)
  - `companySize`, `companyIndustry`, `companyGeo` — raw features so
    the bandit has a fallback when the embedding is missing
- **Campaign features**
  - `campaignId`, `sequenceStep` (1 = cold, 2+ = follow-up)
  - `templateId` — the **candidate** template being scored (each
    template is a separate action; see action set)
  - `templateEmbedding` — from `template_embeddings`, optional
  - `templateTone` — one-hot over `{formal, casual, urgent, friendly}`
  - `senderPoolId`, `senderWarmupScore` — the from-address pool and
    its warmup status (0..1)
- **Time / pacing**
  - `hourOfDayLocal`, `dayOfWeekLocal` (recipient-local, from company
    timezone if known)
  - `sendsThisCampaignToday`, `sendsThisCampaignThisWeek` — campaign
    pacing vs. configured cap
- **Budget / compliance**
  - `dailyOutboundBudgetRemaining`, `poolDailyCapRemaining`
  - `gdprRegion` (EU / UK / other) — drives consent handling, not Q

#### Action set (`OutboundEmailAction`)

The action space is **factored** — template choice is one axis, timing
is another — but for the MVP we keep it flat to make Q-values easy to
inspect:

```
type OutboundEmailAction =
  | 'skip'                          // do not send
  | `send_now:${TemplateId}`        // send immediately with given template
  | `delay_2h:${TemplateId}`        // queue for recipient-local mid-afternoon
  | `delay_next_morning:${TemplateId}` // queue for recipient-local 9am next biz day
```

The number of concrete actions = `#eligibleTemplates × #timingChoices + 1`.
Eligible templates are filtered upstream (tone matches campaign, not
archived, language matches recipient). We cap the candidate set at
~8 templates × 3 timings per decision so the scorer stays cheap.

`skip` is always available and is the only action allowed when any
hard-rail flag is true.

#### Reward

Composite, latency-aware, versioned. Computed by
`scoreOutboundOutcome(decision, outcome)` in planned
`mdp-outbound-reward.ts`:

```
reward =
  + 1.0  * reply_positive           // intent / meeting booked
  + 0.3  * reply_neutral            // replied but no intent
  + 0.05 * opened
  + 0.02 * clicked
  - 0.3  * hard_bounce
  - 0.1  * soft_bounce
  - 2.0  * unsubscribed
  - 3.0  * spam_complaint
  - 0.01 * sent_cost                // per-send cost amortised (SES + provider fees)
```

Reply sentiment (positive / neutral / negative) comes from a
lightweight Gemini classifier on the inbound thread; same pattern as
[`gemini-email-match-routines.ts`](../src/server/subroutines/gemini-email-match-routines.ts).

Latency handling is the hard part: bounces within minutes, opens
within hours, replies within days. The trainer (§6) uses **truncated
returns with optimistic imputation** — a decision with no reply after
14 days is sealed as "no reply"; before then its reward is partial. We
log `outcome_sealed_at` so stale-imputation bugs are caught offline.

Versioned: every reward change bumps `reward_version` and is written
to `outbound_email_outcomes.reward_version`. Old outcomes are never
rescored in-place; a re-score pass writes a new `reward_version_v2`
column only when we need A/B over reward definitions.

#### Policy

Same linear scorer as the notif surface. `Q(state, action)` is
computed by `computeOutboundQ(state, candidateActions)` —
hand-tuned prior weights per (feature, action-kind) live in
`PRIOR_OUTBOUND_WEIGHTS`. ε-greedy with ε = 0.1 per decision (not per
action), clamped to 0.03 once we have ≥10k decisions per (campaign,
template) cell. Hard rails override the policy (§8).

### 3.2 Email source (per-enrichment)

A separate, lighter bandit. One decision per "we need N contacts for
segment S" request.

#### State (`EmailSourceState`)

- **Segment features**
  - `segmentId`, `icpId`, `industryBucket`, `titleBucket`, `geoBucket`
  - `contactsNeeded`, `minEmailFreshnessDays`
- **Per-source history**
  - For each provider: rolling EWMA of
    `(replies + 0.1·opens − 0.5·bounces) / $spend` on this segment over
    the last 30/90 days. These feed in as features so the scorer can
    condition its Q on per-segment evidence, not just the global
    average.
  - `providerFreshnessDays` — mean age of the last 100 emails that
    provider delivered for this segment
  - `providerDuplicateRate30d` — fraction of delivered contacts that
    we already had in our CRM
- **Budget**
  - `monthlyEnrichmentBudgetRemaining`, `perProviderCapRemaining`

#### Action set

```
type EmailSourceAction =
  | `use:${Provider}`
  | `fanout:${Provider[]}` // rare; MVP omits
```

Providers: `hunter | apollo | zoominfo | own_scrape | rocketreach | dropcontact`.

Our own web-scrape is a first-class action, not a fallback. Its cost
per contact (cron-time + browser budget) is modelled, so the bandit
can legitimately pick it when it beats paid sources on
`replies-per-dollar` for a given segment.

#### Reward

Amortised over cost, per contact delivered:

```
per-contact reward =
    + 1.0  * downstream_reply_positive
    + 0.1  * downstream_opened
    - 0.5  * downstream_hard_bounce
    - 1.5  * downstream_unsubscribe
    - k    * duplicate_of_existing_contact
  normalized_by:
    + (cost_per_contact_usd)         // so "cheap-but-worse" can still win
```

Downstream outcomes are joined in from `outbound_email_outcomes`,
aggregated per `source_enrichment_run_id` that delivered the contact.
A source that delivers lots of contacts that never get replied to is
penalised **as much** as a source that delivers bouncy contacts.

This is a long-delay reward (contact delivered today → reply next
week). The trainer has to handle that explicitly — see §6.

#### Policy

Thompson sampling over per-segment posterior means from day one —
there are only ~6 providers, so the posterior is cheap to maintain
per segment and Thompson gives better exploration on cold segments
than ε-greedy. Fallback to ε-greedy on segments with `<50` historical
contact deliveries.

### 3.3 Template × ICP fit (inside the outbound surface)

Template choice is an **action** on the `outbound_email` surface, not
a separate surface. But "which template works on which kind of
company" is the load-bearing learning problem, so it deserves its own
treatment.

Two complementary scorers, summed:

1. **Shared-parameter affinity** (generalises, needed for cold-start)

   ```
   affinity(template, icp) = cosine(template_embedding, icp_embedding)
                           + β_size     · size_match(company, template.target_size_band)
                           + β_tone     · tone_match(company.culture, template.tone)
                           + β_industry · industry_match_rules[...]
   ```

   Template embeddings are generated once from
   `subject + body + tone_tags` via Gemini (same
   `gemini-embedding-001` / 768d we use for users); ICP embeddings
   from the ICP `criteria.description` field. See §5.2 for storage.

2. **Per-cell Q-residual** (captures what the shared scorer misses)

   ```
   residual(template, icp) = learned delta from observed reward
                             over (template_id, icp_id) cells with ≥20 sends
   ```

   Stored on `outbound_email_template_icp_stats` keyed by
   `(template_id, icp_id)`. Shrunk toward zero by
   `n / (n + 20)` until the cell has real evidence — same shrinkage
   shape as the neighbour blend in
   [`mdp-scraping-escalation.md §5.3`](./mdp-scraping-escalation.md#53-how-rag-retrieval-drives-the-decision).

The `Q` for a `send_now:T` action on a recipient with ICP `I` is then:

```
Q(state, send_now:T) = base_handcraft_Q(state, send_now)
                     + α_affinity · affinity(T, I)
                     + α_residual · residual(T, I)
```

`α_affinity`, `α_residual` start at 1.0 and are learned by the
trainer. Same shape as the notif surface's neighbour-Q blend; see
[`mdp-for-notifs-and-more.md §4`](./mdp-for-notifs-and-more.md#4-why-similar-users-helps-learning).

This gives us three desirable behaviours at once:

- A brand-new template starts with nonzero Q on ICPs its embedding is
  near — no "send blindly to everyone until data exists."
- A template that looks generic via embedding but empirically crushes
  on one ICP gets a large positive residual there and wins that cell
  despite weak affinity.
- A template that looks great via embedding but bounces like crazy on
  a specific ICP gets a strongly negative residual that can veto the
  affinity recommendation.

---

## 4. Why ICPs + embeddings help learning

Same argument as
[`mdp-for-notifs-and-more.md §4`](./mdp-for-notifs-and-more.md#4-why-similar-users-helps-learning)
for "similar users" and
[`mdp-scraping-escalation.md §5`](./mdp-scraping-escalation.md#5-page-embeddings--recognition--rag-style-learning)
for "similar pages" — applied to **companies** and **templates**.

The learning-acceleration payoff comes from three distinct
generalisation axes:

- **ICPs cluster companies.** Two mid-market Series B SaaS companies
  behave similarly for outreach purposes even if we've never emailed
  either. Once we have 100 sends to the cluster, a new company in the
  cluster inherits that evidence immediately.
- **Template embeddings cluster messaging.** Two templates that
  mention "quarterly hiring plan" and lead with a CFO-facing hook
  cluster together; reward observed on one transfers to the other as
  a prior.
- **Segment × source clusters.** The email-source bandit does the
  same for providers: if `hunter.io` is dominating on "US SaaS
  mid-market founders," a new segment that embeds near it should
  start with `hunter.io` as the prior preference.

Concretely, this means we can ship a brand-new outreach campaign with
a brand-new template and still make non-random decisions on day one.
The alternative — waiting for 20k sends to build per-(template, ICP)
cells from scratch — is the thing that kills outbound-ML projects.

### 4.1 ICPs as first-class entities

An ICP (Ideal Customer Profile) is **not** a tag on a company. It is
its own row with:

- Structured criteria: industry list, size bands, titles, geos,
  tech-stack tags, revenue bands.
- A free-text `description` (used for the embedding).
- A `match_method_spec` — how companies get assigned to it:
  `rules_only`, `embedding_only`, or `hybrid`.

Company-to-ICP is many-to-many with confidences:
`company_icp_assignments(company_id, icp_id, match_score, match_method,
valid_from, invalidated_at)`. A company can match three ICPs with
scores `0.9`, `0.6`, `0.3`; the per-send decision picks the highest
scoring active one for the state, **but the trainer sees all of them**
so the per-cell residual learns across overlapping membership.

ICPs drift. A company that was "mid-market SaaS" last quarter might
be "enterprise SaaS" this quarter. `valid_from` + `invalidated_at` on
`company_icp_assignments` is how we keep the training join honest —
training reads the assignment that was live at the decision's
`computed_at`, not the current row. This is the same temporal-join
shape as `mdp_scrape_decisions.state_jsonb` snapshotting page features
at decision time.

---

## 5. Reinforcement learning — how this becomes RL

### 5.1 Bandit → delayed-reward MDP

Three stages, same shape as
[`mdp-for-notifs-and-more.md §5.1`](./mdp-for-notifs-and-more.md#51-bandit--full-mdp-in-three-stages):

1. **Contextual bandit (truncated reward).** Per-send decision,
   reward sealed after 14 days. This is the MVP.
2. **Episodic bandit (sequence-level reward).** One decision per
   step of a drip sequence; reward credits the eventual reply to the
   sequence, not the last step. Needed once multi-step sequences are
   in scope. Implementable as truncated n-step return with
   `n = sequence_length`.
3. **Full MDP.** State carries sequence history (`step`, prior opens
   / no-opens on this prospect), actions include "stop the sequence"
   as a first-class option. γ = 0.95; sequences rarely exceed 6 steps
   so discounting only barely matters but keeps the target bounded.

The MVP is stage 1 on `outbound_email` and full Thompson-sampling
bandit on `email_source`. Stages 2 and 3 are behind stage E wiring.

### 5.2 Shared parameters and embeddings

Template and ICP embeddings are stored in
`template_embeddings` and `icp_embeddings` — their own tables, **not**
[`EntityEmbeddingTable`](../src/server/databases/neondb/tables/entities-tables.ts).
Same reasoning as
[`mdp-scraping-escalation.md §5.2`](./mdp-scraping-escalation.md#52-where-we-store-them):
high-volume, high-churn, independent tuning. Additionally, we
regenerate a template's embedding on every body edit, which is the
wrong churn profile for the general entity store.

Per row:

- `template_embeddings`: `template_id`, `model_name`, `dimensions`,
  `embedding`, `source_text_hash` (so we can detect "already embedded
  this exact body"), `created_at`.
- `icp_embeddings`: `icp_id`, `model_name`, `embedding`,
  `criteria_hash`, `created_at`. Regenerated when criteria or
  description changes.

Same HNSW indexing rule as in the scraping doc — separate partial
HNSW index per `(model_name, dimensions)` pair, because we may have
Gemini-768 and OpenAI-1536 co-existing during a provider A/B.

### 5.3 The learning update

Linear per-action for the handcrafted base Q, plus a per-cell
Q-residual table for template × ICP. Trained nightly off logged
decisions + outcomes, same as every other surface:

```
// for each (state, action, reward) tuple sealed ≥14d ago
target = reward
loss   = (Q(state, action; theta) - target)^2
theta  <- theta - eta * grad_theta loss

// per-cell residual update (template × icp)
residual[(t,i)] <- residual[(t,i)] + eta_r * shrinkage(n) *
                   (reward - Q_without_residual(state, send_now:t))
```

Shrinkage keeps a low-n cell from swinging wildly off a single lucky
reply.

### 5.4 Exploration

- **Per-send (`outbound_email`):** ε-greedy, ε = 0.1 across the
  candidate action set. `skip` is *not* a random-explore target —
  ε-exploration only samples among send actions. We don't want random
  skips.
- **Per-source (`email_source`):** Thompson sampling over the
  per-segment posterior from day one. Cold segments fall back to
  ε-greedy 0.15 with a uniform prior — only fires until a segment has
  50 historical deliveries.

### 5.5 Reward design — the same hard problem, harder

Every concern from
[`mdp-for-notifs-and-more.md §5.5`](./mdp-for-notifs-and-more.md#55-reward-design-the-actual-hard-part)
applies, plus three that are specific to outbound:

- **Reward hacking via easy audiences.** The policy must not learn
  "always target freemail `@gmail.com` sales ops people because open
  rates are high and replies sometimes come" if the company value of
  those replies is low. The reward must weight by
  `company_revenue_band` (via `icp.revenue_bands`) — a reply from an
  enterprise target is worth more than a reply from a SMB lookalike.
- **Bounce latency lies.** A 550 from a mailserver is instant; a
  soft-bounce-then-permanent-bounce 72h later is a different story.
  We seal bounce-state after 7d, not immediately.
- **Unsubscribes are non-recoverable.** The reward for an unsubscribe
  includes the *expected lost future value* of the inbox, not just
  −2.0. The offline trainer computes per-segment average lifetime
  reply rate and charges unsubscribes the full NPV loss.
- **GDPR / CAN-SPAM compliance is a hard rail, not a reward term.**
  See §8. The policy cannot earn reward by violating consent; the
  executor drops the send before transmission.

### 5.6 Off-policy evaluation (OPE) and safe promotion

Same IPS pattern as the notif surface (see
[`mdp-for-notifs-and-more.md §5.6`](./mdp-for-notifs-and-more.md#56-off-policy-evaluation-ope-and-safe-promotion)).
Promotion gate for a new weights row:

- IPS-estimated reward-per-send strictly > current.
- IPS-estimated bounce rate not higher than current by >1 pp.
- IPS-estimated unsubscribe rate not higher than current by >0.2 pp.
- Canary on 5% of `campaign_id`s for ≥3 days before 100% rollout.

Source-bandit promotion is per-segment; we promote a new prior row
into `mdp_policy_weights` only after IPS on that segment shows ≥10%
improvement in `replies-per-dollar`.

### 5.7 Cold start

Same three layers as the scraping surface:

1. **Population prior** in code (`PRIOR_OUTBOUND_WEIGHTS`,
   `PRIOR_SOURCE_WEIGHTS`).
2. **Cluster prior** — for a new ICP with fewer than 100 decisions,
   shrink its per-cell Q-residuals toward the population mean. For a
   new source with fewer than 50 contacts delivered in a segment,
   shrink its posterior toward the global source posterior.
3. **Embedding-neighbour prior** — for an unseen template, blend the
   average per-ICP reward of the top-5 nearest template embeddings.
   For an unseen ICP, blend the average per-template reward of the
   top-5 nearest ICP embeddings.

Implemented once in a shared helper used by both surfaces:
`mdp-outbound-cold-start.ts` (planned). Identical shape to the
`blendWithNeighbors` helper already in
[`mdp-notif-routines.ts`](../src/server/subroutines/mdp/mdp-notif-routines.ts).

### 5.8 Relationship to the source bandit

The two bandits talk to each other through shared state, not through
a hierarchical decision graph. Concretely:

- Source-bandit picks a provider; contacts get enriched and stored.
- Each contact's `source_provider` becomes a **feature** in the
  per-send state.
- Per-send outcomes get rolled up (joined on
  `source_enrichment_run_id`) into the source-bandit's reward.

This keeps both bandits simple (each optimises its own action in its
own state space) while letting the source-bandit learn from
downstream deliverability, not just "did we get contact records back."

---

## 6. Training loop

### Outcomes pipeline

The trainer reads from `outbound_email_outcomes` (joined on
`outbound_email_sends` and on `company_icp_assignments` valid-at-time)
to produce training tuples. Critical invariants:

- **Temporal join correctness.** The ICP assigned at *decision time*
  is what the trainer sees, even if the assignment has since been
  invalidated. Read
  `company_icp_assignments WHERE valid_from <= computed_at AND
  (invalidated_at IS NULL OR invalidated_at > computed_at)`.
- **Outcome sealing.** Only tuples with `outcome_sealed_at IS NOT NULL`
  and `outcome_sealed_at < now() - 1 day` are used — prevents the
  trainer from chasing half-formed reward signals.
- **Propensity logging.** Every decision row records
  `chosen_action_propensity` (probability the decision made this pick
  under the live policy at the time). Required for IPS — without it
  you cannot promote new weights safely.

### Trainer schedule

- `train-outbound` — nightly.
- `train-source` — nightly.
- `assign-icps` — every 6h incremental (new companies since last
  run), full re-pass weekly.

### Policy weights

Shared `mdp_policy_weights` table (see §7), one row per
`(surface, version)`. KV-cached on hot paths same as notif surface.
New versions are proposed by the trainer, OPE-evaluated, then
canaried; only then does the executor start using them.

---

## 7. Schema (planned)

Mirrors existing conventions in
[`mdp-decisions-table.ts`](../src/server/databases/neondb/tables/mdp-decisions-table.ts).
The two new surfaces reuse the shared `mdp_decisions` table via new
`surface` enum values: `'outbound_email'` and `'email_source'`. That
keeps the decision log unified so the trainer reads one table.

Outcome tables are **separate per-surface** because the columns
diverge (bounces/opens/replies for outbound; cost/freshness/duplicates
for source) and we don't want a sparse wide table.

```sql
-- ──────────────────────────────────────────────────
-- ICPs
-- ──────────────────────────────────────────────────
create table icps (
  id                uuid primary key,
  name              text not null,
  description       text not null,
  criteria_jsonb    jsonb not null,                   -- {industries:[], size_bands:[], titles:[], geos:[], tech_tags:[], revenue_bands:[]}
  match_method      text not null default 'hybrid',   -- 'rules_only' | 'embedding_only' | 'hybrid'
  created_by        uuid,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_icps_active on icps(archived_at) where archived_at is null;

-- embedding of icp.description — dedicated table (see §5.2)
create table icp_embeddings (
  id              uuid primary key,
  icp_id          uuid not null references icps(id) on delete cascade,
  provider        text not null,                       -- 'gemini' | 'openai'
  model_name      text not null,
  dimensions      integer not null,
  embedding       vector,
  criteria_hash   bytea not null,                      -- sha256(description + criteria_jsonb)
  created_at      timestamptz not null default now(),
  unique (icp_id, provider, model_name, criteria_hash)
);
create index idx_icp_emb_hnsw_gemini
  on icp_embeddings using hnsw (embedding vector_cosine_ops)
  where provider = 'gemini';

-- company ↔ icp, many-to-many, temporal
create table company_icp_assignments (
  id               uuid primary key,
  company_id       uuid not null,                       -- FK to your existing company table
  icp_id           uuid not null references icps(id),
  match_score      real not null,                       -- [0,1]
  match_method     text not null,                       -- 'rules' | 'embedding' | 'manual'
  reasoning        text,                                -- audit trail
  valid_from       timestamptz not null default now(),
  invalidated_at   timestamptz,                         -- null = still active
  created_at       timestamptz not null default now()
);
create index idx_cia_company on company_icp_assignments(company_id) where invalidated_at is null;
create index idx_cia_icp on company_icp_assignments(icp_id) where invalidated_at is null;
-- point-in-time lookup by (company, at)
create index idx_cia_company_temporal on company_icp_assignments(company_id, valid_from, invalidated_at);

-- ──────────────────────────────────────────────────
-- Outreach templates
-- ──────────────────────────────────────────────────
create table outreach_templates (
  id                uuid primary key,
  name              text not null,
  subject           text not null,
  body_md           text not null,
  tone_tags         text[] not null default '{}',
  target_size_bands text[] not null default '{}',
  language          varchar(16) not null default 'en',
  archived_at       timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_outreach_templates_active on outreach_templates(archived_at) where archived_at is null;

create table template_embeddings (
  id                uuid primary key,
  template_id       uuid not null references outreach_templates(id) on delete cascade,
  provider          text not null,
  model_name        text not null,
  dimensions        integer not null,
  embedding         vector,
  source_text_hash  bytea not null,                     -- sha256(subject + body + tone_tags)
  created_at        timestamptz not null default now(),
  unique (template_id, provider, model_name, source_text_hash)
);
create index idx_template_emb_hnsw_gemini
  on template_embeddings using hnsw (embedding vector_cosine_ops)
  where provider = 'gemini';

-- per-cell residual Q for template × icp (§3.3)
create table outbound_email_template_icp_stats (
  template_id   uuid not null references outreach_templates(id) on delete cascade,
  icp_id        uuid not null references icps(id) on delete cascade,
  n_sends       integer not null default 0,
  n_opens       integer not null default 0,
  n_replies_pos integer not null default 0,
  n_bounces     integer not null default 0,
  n_unsubs      integer not null default 0,
  residual_q    real not null default 0,                 -- shrunk estimate used by the scorer
  updated_at    timestamptz not null default now(),
  primary key (template_id, icp_id)
);

-- ──────────────────────────────────────────────────
-- Sends + outcomes (the reward stream)
-- ──────────────────────────────────────────────────
create table outbound_email_sends (
  id                        uuid primary key,
  decision_id               uuid,                         -- references mdp_decisions.decision_id (surface='outbound_email')
  campaign_id               uuid not null,
  sequence_step             integer not null default 1,
  contact_id                uuid not null,                -- FK to your contacts table
  company_id                uuid not null,
  icp_id_at_send            uuid,                         -- snapshot of winning ICP at decision time
  template_id               uuid not null references outreach_templates(id),
  sender_pool_id            uuid not null,
  source_enrichment_run_id  uuid,                         -- ties back to email_source_runs
  source_provider           text not null,
  email_kind                text not null,                -- 'corporate' | 'freemail' | 'role_alias' | 'unknown'
  chosen_action             text not null,                -- matches mdp_decisions.chosen_action
  chosen_action_propensity  real not null,                -- required for IPS
  state_jsonb               jsonb not null,               -- snapshot of OutboundEmailState at send time
  computed_at               timestamptz not null,
  sent_at                   timestamptz,                  -- null = scheduled but not transmitted yet
  transport_message_id      text,                         -- ID returned by SES/SendGrid etc
  created_at                timestamptz not null default now()
);
create index idx_oes_campaign on outbound_email_sends(campaign_id);
create index idx_oes_contact on outbound_email_sends(contact_id);
create index idx_oes_company on outbound_email_sends(company_id);
create index idx_oes_template on outbound_email_sends(template_id);
create index idx_oes_decision on outbound_email_sends(decision_id);
create index idx_oes_source_run on outbound_email_sends(source_enrichment_run_id);

create table outbound_email_outcomes (
  id                       uuid primary key,
  send_id                  uuid not null references outbound_email_sends(id) on delete cascade,
  decision_id              uuid,                          -- denormalised copy for trainer join speed
  opened                   boolean not null default false,
  opened_at                timestamptz,
  clicked                  boolean not null default false,
  clicked_at               timestamptz,
  replied                  boolean not null default false,
  replied_at               timestamptz,
  reply_sentiment          text,                          -- 'positive' | 'neutral' | 'negative'
  hard_bounce              boolean not null default false,
  soft_bounce              boolean not null default false,
  bounce_code              text,
  unsubscribed             boolean not null default false,
  unsubscribed_at          timestamptz,
  spam_complaint           boolean not null default false,
  reward                   real,                          -- null until sealed
  reward_version           text,
  outcome_sealed_at        timestamptz,                   -- null until trainer-eligible
  last_event_at            timestamptz not null default now(),
  created_at               timestamptz not null default now()
);
create index idx_oeo_send on outbound_email_outcomes(send_id);
create index idx_oeo_sealed on outbound_email_outcomes(outcome_sealed_at) where outcome_sealed_at is not null;

-- ──────────────────────────────────────────────────
-- Source enrichment runs (email_source surface)
-- ──────────────────────────────────────────────────
create table email_source_runs (
  id                       uuid primary key,
  decision_id              uuid,                           -- mdp_decisions.decision_id (surface='email_source')
  segment_id               uuid,
  icp_id                   uuid,
  provider                 text not null,                  -- 'hunter' | 'apollo' | 'zoominfo' | 'own_scrape' | ...
  contacts_requested       integer not null,
  contacts_delivered       integer not null default 0,
  contacts_duplicate       integer not null default 0,
  cost_usd_total           numeric(10,4) not null default 0,
  freshness_mean_days      real,
  state_jsonb              jsonb not null,
  computed_at              timestamptz not null,
  completed_at             timestamptz,
  reward                   real,                            -- amortised, sealed when downstream outcomes mature
  reward_version           text,
  outcome_sealed_at        timestamptz,
  created_at               timestamptz not null default now()
);
create index idx_esr_provider on email_source_runs(provider);
create index idx_esr_segment on email_source_runs(segment_id);
create index idx_esr_sealed on email_source_runs(outcome_sealed_at) where outcome_sealed_at is not null;

-- mdp_policy_weights — shared with every other surface
-- See `mdp-for-notifs-and-more.md §6` for the cross-surface shape.
-- New surfaces this doc introduces:
--   'outbound_email'
--   'email_source'
```

### Why separate outcome tables

The shared `mdp_decisions` table captures the decision itself, but
bounce/open/reply/unsub telemetry is fundamentally a different rate
and shape from source-enrichment cost/freshness/duplicate telemetry.
Putting them in a wide shared table would:

- Produce enormous JSONB blobs or sparse columns.
- Force the trainer's IPS join to scan rows it doesn't care about.
- Make retention policy harder — we keep send-outcomes forever (they
  fuel the trainer), but source-run rows can be compacted to
  per-segment aggregates after 90 days.

Same decision rationale as keeping
`mdp_scrape_page_embeddings` separate from `entity_embeddings`
([`mdp-scraping-escalation.md §5.2`](./mdp-scraping-escalation.md#52-where-we-store-them)).

---

## 8. Safety rails

- **Consent / compliance is a hard rail, not a Q term.** Before the
  per-send decision runs, the executor checks:
  - Recipient is not in `suppressions` (unsubscribe, hard-bounce,
    complaint).
  - GDPR lawful-basis is recorded for EU/UK recipients; if not, the
    only permissible action is `skip`.
  - CAN-SPAM physical-address footer is resolvable for the sender
    pool.
  If any check fails, the decision writer still logs the decision
  (for auditability) but the executor refuses to transmit. This is
  the same pattern as the `blockedActions` array on
  `MdpEscalationDecision` — hard limits outside the model, logged
  explicitly, not trusted to be learned.
- **Daily outbound budget caps.** Per-campaign and per-sender-pool.
  When a budget hits zero, `skip` is the only action; other
  candidate actions get removed from the `candidateActions` list
  before scoring. Mirrors the browser-budget rail in
  [`mdp-scraping-escalation.md §8`](./mdp-scraping-escalation.md#8-safety-rails).
- **Sender-pool warmup.** New pools are capped at 50 sends/day with
  a linear ramp for 30 days. The warmup cap is enforced outside the
  policy; the policy sees `senderWarmupScore` as a feature.
- **Per-domain throttle.** Max `N` sends per recipient domain per
  24h — protects sender reputation regardless of what the policy
  wants. Configurable per domain in `outbound_domain_throttles`
  (planned).
- **Unsubscribe propagation.** On any unsubscribe or complaint, the
  contact is suppressed **across every campaign**, not just the one
  that triggered it. The executor reads the suppression list on
  every send.
- **Reward hacking guard on source bandit.** The per-source reward
  must amortise over *contacts delivered that actually got sent to*,
  not "contacts delivered." A source that dumps 10k unverifiable
  role-alias addresses should not look better than one that delivers
  2k targeted corporate inboxes.
- **PII in logs.** `state_jsonb` must not contain the recipient's
  raw email address — only the derived features (email kind, domain
  hash, enrichment provider). The address itself lives in the
  contact table behind normal access controls.

---

## 9. Wiring it into the live system (staged)

None of these are done. They can be done independently, same shape
as [`mdp-for-notifs-and-more.md §7`](./mdp-for-notifs-and-more.md#7-wiring-it-into-the-live-system-staged)
and
[`mdp-scraping-escalation.md §9`](./mdp-scraping-escalation.md#9-wiring-it-into-the-live-system-staged).

### Stage A — shadow scoring on outbound

- Add `scoreOutbound(state, candidateActions)` and call it from the
  existing outbound-email dispatcher (wherever `sendOutreachEmail` is
  invoked) **after the live decision has already been made**.
- Persist the decision to `mdp_decisions` with
  `surface='outbound_email'` via the existing
  [`persistNotifDecision`-style writer](../src/server/subroutines/mdp/mdp-decision-writer.ts)
  (add a `persistOutboundDecision` peer).
- **Do not change the live send.** We are measuring agreement vs.
  the human-configured rule.

### Stage B — shadow scoring on sources

- Add `chooseSource(segmentState)` and log its decision via
  `mdp_decisions` with `surface='email_source'`. Live enrichment
  calls still go through whatever provider the operator configured.

### Stage C — passive outcome logging

- Stand up `outbound_email_sends` and `outbound_email_outcomes`.
- Webhook handlers for bounces / opens / clicks / replies /
  unsubscribes write to `outbound_email_outcomes` with `send_id`.
- Nightly `seal-outcomes` job marks rows `outcome_sealed_at = now()`
  when ≥14 days since `sent_at` and computes the final `reward` via
  the versioned reward function.
- Backfill a `source_enrichment_run_id` on existing
  contacts-from-paid-sources so the source bandit has historical
  reward.

### Stage D — ICP entity + assignment

- Create `icps`, `icp_embeddings`, `company_icp_assignments`.
- Port any existing ad-hoc ICP tags (CRM fields, spreadsheet
  definitions) into `icps.criteria_jsonb`.
- Ship the `assign-icps` cron — hybrid rule + embedding matcher.
  Start read-only: compute assignments, write them, don't use them
  for any live decision yet.

### Stage E — template embeddings + per-cell stats

- Create `outreach_templates` (or migrate from whatever table holds
  templates today), `template_embeddings`,
  `outbound_email_template_icp_stats`.
- Regenerate template embeddings on every template edit.
- Nightly batch fills `outbound_email_template_icp_stats.residual_q`
  from sealed outcomes, applying shrinkage.

### Stage F — gate outbound sends behind the policy (canary)

- Executor starts consulting `scoreOutbound` on a 5% slice of
  `campaign_id`s (hash-based, stable) — see the canary slicing
  helper already used in
  [`mdp-notif-executor.ts`](../src/server/subroutines/mdp/mdp-notif-executor.ts).
- ε stays at 0.10 during the canary — diversify the training data
  before promoting further.
- Hard rails (§8) always enforce regardless of canary slice.

### Stage G — gate source selection behind the policy (canary)

- Same shape as Stage F but for `email_source`. 10% of enrichment
  requests go through Thompson sampling; the rest go through the
  operator-configured default provider.

### Stage H — train + promote

- `train-outbound` + `train-source` nightly. IPS + 3-day canary
  before promoting new weights.
- KV-cached load of `mdp_policy_weights` on every hot path; same
  pattern as the notif surface.

### Stage I — multi-step (sequence) MDP

- Add `sequence_step` / prior-step features to the state.
- Switch reward attribution to n-step truncated returns.
- Add `stop_sequence` as a first-class action.

---

## 10. What the MVP does **not** do (explicitly)

- Does not send any email.
- Does not change the live dispatcher's behaviour (stages A / B / C
  are all shadow).
- Does not assign ICPs (stage D) — existing CRM tags remain the
  source of truth for humans until the assignment pipeline is live.
- Does not train weights — the priors are hand-tuned.
- Does not do off-policy evaluation on outbound.
- Does not gate any live send on a learned policy (until stage F).
- Does not touch sender warmup or reputation management.
- Does not handle sequence multi-step RL (until stage I).

All of the above are stages D–I.

---

## 11. Smoke tests (planned)

```bash
# list available actions (should include score-outbound, choose-source,
# assign-icps, train-outbound, train-source)
curl 'https://<host>/api/cron/mdp?action=status'

# shadow-score a pending outbound candidate
curl -X POST -H "x-cron-secret: $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"contactId":"...","campaignId":"...","candidateTemplateIds":["t1","t2","t3"]}' \
  'https://<host>/api/cron/mdp?action=score-outbound'

# choose a source for a segment
curl -X POST -H "x-cron-secret: $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"segmentId":"...","contactsNeeded":500}' \
  'https://<host>/api/cron/mdp?action=choose-source'

# incremental ICP re-assignment
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=assign-icps&since=2026-04-10T00:00:00Z'

# nightly trainers (no-op until stage C produces sealed outcomes)
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=train-outbound'
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=train-source'
```

---

## 12. Relationship to sibling surfaces

The outbound-email surface is the first one to involve **external
third parties as part of the action space** (enrichment providers on
the source bandit) and the first with **multi-day reward latency**.
Every other surface has O(hours) latency at most.

Shared with sibling surfaces:

- Same `mdp_decisions` decision log, with new `surface` values.
- Same `mdp_policy_weights` shape, keyed on `(surface, version)`.
- Same OPE → canary → promote loop.
- Same persist/executor split (writer logs the decision; executor
  enforces hard rails + acts).
- Same embedding-neighbour cold-start pattern.

Different from sibling surfaces:

- Reward is composite and latency-heterogeneous — bounce (minutes),
  open (hours), reply (days). Trainer handles this via outcome
  sealing and truncated returns.
- Second bandit (`email_source`) layered alongside the primary one,
  sharing outcomes via the `source_enrichment_run_id` join.
- Hard rails include regulatory / consent constraints, not just
  budget caps. These cannot be soft-modelled.

The module layout mirrors the scraping-escalation split:

| File | Purpose |
| ---- | ------- |
| `mdp-outbound-email-routines.ts` | per-send state builder, candidate-action enumeration, scoring |
| `mdp-email-source-routines.ts` | source bandit — Thompson sampler + posterior update |
| `mdp-outbound-features.ts` | shared featurizer (recipient, ICP, template, timing) |
| `mdp-outbound-cold-start.ts` | neighbour-blend helpers used by both surfaces |
| `mdp-outbound-reward.ts` | versioned reward functions (send-level + source-level) |
| `mdp-outbound-executor.ts` | shadow / canary / live executor; enforces hard rails |
| `mdp-icp-assignment-routines.ts` | rule + embedding hybrid company → ICP matcher |

All under
[`src/server/subroutines/mdp/`](../src/server/subroutines/mdp/), same
directory as every other MDP surface.
