# MDP / Contextual Bandit — Scraping Escalation (Gemini probe + Browser)

This document describes how to extend the MDP framework introduced in
[`mdp-for-notifs-and-more.md`](./mdp-for-notifs-and-more.md) to a fourth
decisioning surface: **when to escalate an email-scraping fetch from a
cheap HTTP adapter to (a) a Gemini "is JS needed?" probe, and (b) a
heavy browser adapter (Playwright / Puppeteer).**

It builds on the existing per-(tool, engine) rotation in
[`scrape-tool-rotation-routines.ts`](../src/server/subroutines/scrape-tool-rotation-routines.ts)
and the multi-tool driver in
[`email-scrape-multi-tool-routines.ts`](../src/server/subroutines/email-scrape-multi-tool-routines.ts).
That system already chooses an adapter per (engine, query) using an
EWMA-blended ε-greedy bandit and persists outcomes to
[`email_scrape_tool_runs`](../src/server/databases/neondb/tables/email-scrape-tool-runs-table.ts)
and `email_scrape_tool_aggregates`. **It does not yet condition on the
state of the HTML returned**, and it does not learn a separate
"escalate vs. stop" decision. That is what this doc adds.

---

## 1. The decision we are not making today

Today the rotation works at the `(tool, engine)` level. For each query
we pick one adapter, run it, score its outcome, and update its EWMA.
Browser adapters (Playwright, Puppeteer) compete in the same pool and
get picked when their score is high.

What the system does **not** do:

- Look at the actual HTML body returned by a cheap adapter and decide
  *"this page probably has emails behind a JS render — escalate"* vs.
  *"this page is static and has nothing — give up."*
- Use Gemini as a **classifier** over the HTML to predict whether a
  browser run would unlock more emails, before paying the browser cost.
- Learn a per-page-class policy. A blog post and an `/about` page
  behave differently; the existing aggregate scores collapse them.

Concretely: today, if `fetch+cheerio` returns 0 emails on a page, the
multi-tool loop just moves to the next URL. Sometimes that page
genuinely has no emails. Sometimes the emails are rendered by JS, and
a Playwright pass would have found them. We currently can't tell the
two apart, so we either (a) leave emails on the table, or (b) waste
Playwright on dead pages.

The escalation policy below is the missing decision.

---

## 2. Scope and module layout

A new module pair under [`src/server/subroutines/mdp/`](../src/server/subroutines/mdp/):

| File | Purpose |
| ---- | ------- |
| `mdp-scrape-escalation-routines.ts` | Builds page state, scores actions, returns escalation decision |
| `mdp-scrape-types.ts` | `PageState`, `EscalationAction`, `EscalationDecision`, reward types |

A new cron action under [`/api/cron/mdp`](../src/app/api/cron/mdp/route.ts):

| Action | Purpose | Notable params |
| ------ | ------- | -------------- |
| `score-escalation` | given a URL or run-batch, score the escalation action(s) | `runBatchId` or `urlBatch` |
| `train-escalation` | nightly trainer over logged decisions + outcomes | — |

Multi-tool driver in
[`email-scrape-multi-tool-routines.ts`](../src/server/subroutines/email-scrape-multi-tool-routines.ts)
calls the policy after each non-browser fetch returns its HTML, before
moving to the next URL. **No browser adapter is invoked unless the
policy says to.** This replaces the implicit "browser adapters compete
on EWMA" behaviour for browser tools; cheap adapters keep their
existing rotation.

---

## 3. MDP formulation

### 3.1 State (`PageState`)

Built per (URL, fetch-result) by `buildPageState(url, html, prevTool)`:

- **Cheap fetch result features**
  - `httpStatus`, `captchaSuspected`, `byteLength`, `wasRedirect`
  - `tagDensity.script`, `tagDensity.iframe`, `tagDensity.img`
  - `mailtoCount` — number of `href="mailto:"` links found
  - `obfuscatedEmailCount` — `[at]`, `(at)`, `&#64;`, JS-string
    concatenation patterns matched in the raw HTML
  - `frameworkHints` — boolean flags for `__NEXT_DATA__`,
    `window.__NUXT__`, `data-reactroot`, `ng-version`, presence of a
    big `application/json` blob, etc.
  - `emailsFoundByCheapAdapter` — count of valid emails the regex
    extractor already pulled out
- **URL / domain features**
  - `urlPathDepth`, `urlHasContact`, `urlHasTeam`, `urlHasAbout`
  - `domainTld`, `domainAgeBucket` (if known via prior runs)
  - `domainPriorBrowserSuccessRate` — historical fraction of browser
    runs on this domain that found ≥1 new email
- **Query / campaign features**
  - `queryRowId`, `queryEmbedding` (Gemini, optional)
  - `engine` that surfaced this URL
- **Budget features**
  - `browserBudgetRemainingThisRun`, `geminiBudgetRemainingThisRun`,
    `runBatchId`

State is logged as JSON, **not** held only in memory — the trainer
needs it. Mirror the layout of `MdpUserState` in
[`mdp-types.ts`](../src/server/subroutines/mdp/mdp-types.ts).

### 3.2 Action set (`EscalationAction`)

A two-step action space, consumed sequentially:

```
type EscalationAction =
  | 'stop'              // no more work on this URL
  | 'gemini_probe'      // run Gemini classifier on the HTML, then re-decide
  | 'browser_playwright'
  | 'browser_puppeteer'
```

`gemini_probe` is itself an action (it costs tokens), and its result
becomes a *new* feature on the state. The policy is then re-evaluated
with the probe output appended. This is the same pattern as a
two-stage bandit: the cheap probe modulates the expensive escalation.

### 3.3 Reward

Per URL, computed by `scoreEscalationOutcome(decision, outcome)`:

```
reward =
    1.0   * new_unique_emails_found
  - 0.05  * gemini_probe_invoked       // ~ token cost normalised
  - 0.50  * browser_invoked            // browser launch + page wall time
  - 1.00  * captcha_or_block_triggered // we paid and got rate-limited
  + 0.20  * domain_first_seen_with_emails  // collaborative-discovery bonus
```

The constants are starting priors; they get re-tuned once we have ≥10k
logged decisions and can fit them against observed
emails-per-dollar-of-compute. Same versioning rule as
[`mdp-for-notifs-and-more.md` §5.5](./mdp-for-notifs-and-more.md#55-reward-design-the-actual-hard-part):
write the reward in one place (`mdp-scrape-reward.ts`, future), version
it, log which version produced which weights.

`new_unique_emails_found` is computed against the
[`email-alias-routines`](../src/server/subroutines/email-alias-routines.ts)
group store so we don't reward re-discovering an email we already have.

### 3.4 Policy (stage 1 — bandit)

Linear scorer per action with shared state features:

```
Q(state, a) = w_a · featurize(state)
choose      = argmax_a Q(state, a)   (with ε-greedy override)
```

Featurize is the same featurizer used by all four MDP surfaces — see
[`mdp-types.ts`](../src/server/subroutines/mdp/mdp-types.ts) and the
"shared parameters" discussion in
[`mdp-for-notifs-and-more.md` §5.2](./mdp-for-notifs-and-more.md#52-function-approximation-and-shared-parameters).

ε is per-action. At launch: 0.10 for `gemini_probe` and `stop`, 0.05
for `browser_playwright` and `browser_puppeteer` (the `browser_*` cap
from §8). Each per-action ε decays to 0.03 once we have ≥1k logged
decisions per `(domain_tld, action)` cell.

### 3.5 The Gemini probe (the second model)

This is a **classifier**, not the policy. It runs only when the
escalation policy picks `gemini_probe`. Prompt skeleton:

```
You are inspecting raw HTML from a page that was fetched without a
browser. The page may be missing content because it requires JS to
render. Estimate, on a 0–100 scale:

1. P(emails are present in the rendered DOM but not in this raw HTML)
2. P(this page is a contact / team / about / staff directory)
3. Rough page kind (one of: contact, team, blog, marketing, login,
   error, other)
4. One sentence of reasoning.

Return strict JSON: { p_emails_behind_js, p_is_contactish, page_kind,
                      reasoning }
```

Use `gemini-2.5-flash` (matches
[`gemini-email-match-routines.ts`](../src/server/subroutines/gemini-email-match-routines.ts)),
temperature 0.2, maxOutputTokens ~256, key rotation via
`getNextAvailableKey`. Truncate the HTML to the first ~30k characters
of `<body>` after stripping `<script>` / `<style>` blocks; record the
truncated length on the decision row so the trainer can correct for it
later.

The probe outputs become features `p_emails_behind_js`,
`p_is_contactish`, `page_kind` (one-hot) on the next decision step.
The policy then chooses among `stop | browser_playwright | browser_puppeteer`.

**Why a probe and not "always run Gemini":** the probe is cheap
relative to a browser launch but not free. If the cheap-fetch state
already implies `p_emails_behind_js > 0.9` (e.g. the page is a
near-empty `<div id="root">` with a single Next.js bundle), we should
escalate to a browser without paying for the probe. If
`p_emails_behind_js < 0.1` is implied (e.g. plain WordPress page with
0 mailto links and 0 obfuscated patterns), we should stop. The probe
is for the messy middle.

---

## 4. Where the policy is called from

Inside the existing per-URL loop in
[`email-scrape-multi-tool-routines.ts`](../src/server/subroutines/email-scrape-multi-tool-routines.ts):

```
// after the cheap adapter has returned for this URL
const state = await buildPageState({
  url, html: fetchResult.html, cheapAdapterName: adapter.name,
  cheapEmails: extractedEmails, runBatchId, queryRowId,
  engine,                                         // SERP engine that surfaced this URL
});

let decision = scoreEscalation(state);            // step 1
const step1 = await logDecision({ runBatchId, url, state, decision, parentId: null });

if (decision.action === 'gemini_probe') {
  const probe = await runGeminiHtmlProbe(state);  // adds features
  const state2 = mergeProbeIntoState(state, probe);
  decision = scoreEscalation(state2);             // step 2
  const step2 = await logDecision({
    runBatchId, url, state: state2, decision,
    parentId: step1.id,                           // links step 2 → step 1 via mdp_scrape_decisions.parent_id
  });
  // outcome is logged against the most recent decision (step2):
  await resolveAndLogOutcome(step2, decision);
} else {
  await resolveAndLogOutcome(step1, decision);
}

async function resolveAndLogOutcome(loggedDecision, decision) {
  if (decision.action === 'browser_playwright' || decision.action === 'browser_puppeteer') {
    const browserAdapter = pickBrowserAdapter(decision.action);
    const browserResult = await runBrowserOnUrl(browserAdapter, url);
    const reward = scoreEscalationOutcome(decision, browserResult);
    await logOutcome({ decisionId: loggedDecision.id, reward, browserResult });
  } else {
    // 'stop' — log a zero-cost outcome so the trainer knows we gave up
    await logOutcome({ decisionId: loggedDecision.id, reward: 0, browserResult: null });
  }
}
```

This block is the **only** place browser adapters get invoked. Browser
adapters are removed from the per-(tool, engine) rotation pool inside
`adaptersForEngine` once this lands; they only run via the escalation
policy. Cheap adapters keep their existing rotation untouched.

---

## 5. Page embeddings — recognition + RAG-style learning

Same insight as
[`mdp-for-notifs-and-more.md` §4](./mdp-for-notifs-and-more.md#4-why-similar-users-helps-learning),
applied to pages instead of users — and load-bearing enough that it
deserves its own section. Two mechanisms, both shipped:

1. **Embedding-space neighbors at decision time (RAG-style prior).**
   Before scoring `Q(state, a)` for a URL we have not seen,
   look up its top-K nearest pages by cosine similarity and **blend
   their observed per-action rewards into the prior**. This is
   recognition + retrieval: "we've seen pages that look like this one;
   here is what worked on them."
2. **Shared-parameter Q-network (later).** The featurizer takes the
   embedding directly as input. SGD updates from page A move θ in a
   way that improves predictions for embedding-similar page B. Same
   collaborative-filtering-plus-RL property as the notif surface —
   see
   [§5.2 in the parent doc](./mdp-for-notifs-and-more.md#52-function-approximation-and-shared-parameters).

### 5.1 What we embed

Two embeddings per URL, both optional, both populated lazily:

| Name | Input | When generated | Why |
| ---- | ----- | -------------- | --- |
| `page_html_embedding` | sanitised first ~4k chars of `<body>` (after stripping `<script>`/`<style>`), prefixed by `domain` and `url-path` | first time we decide on this URL | recognises pages that *look* alike (templates, CMS shells) — drives the RAG prior on Q |
| `page_probe_embedding` | the Gemini probe's `reasoning + page_kind` text | first time the probe runs on this URL | recognises pages with similar **semantic** classification, even when raw HTML differs (e.g. two contact pages on different stacks) |

### 5.2 Where we store them

A **dedicated** `mdp_scrape_page_embeddings` table — *not* the shared
[`EntityEmbeddingTable`](../src/server/databases/neondb/tables/entities-tables.ts).
Web-page embeddings are generated at scraping volume (potentially
thousands per cron run) and would otherwise overwhelm the main
entity-embeddings table, which is sized for user-facing entities like
people, leads, candidates, and posts. Keeping the page corpus in its
own table also lets us tune retention, indexing (HNSW vs IVFFlat), and
provider mix independently of user-entity embeddings.

Schema is in §7. Generation reuses the multi-provider helper from
[`multi-provider-embeddings.ts`](../src/server/subroutines/multi-provider-embeddings.ts)
but the persist target is the new table. Per row:

- `url_hash = sha256(url)` (stable across runs, used for upserts)
- `embedding_type = 'page_html' | 'page_probe'`
- `provider = 'gemini' | 'openai'` — generate **both** when budget
  allows, so we can A/B which provider gives better
  neighbour-recall→reward correlation
- `content_hash` — sha256 of the embedded text; avoids regenerating
  when the cheap-fetch HTML is unchanged across runs
- `meta = { domain, url, runBatchId, lastDecisionId }`

The `page_embedding` column on `mdp_scrape_decisions` (§7) is a
denormalised copy of the active vector for that row, populated when
the decision is made. The source of truth is
`mdp_scrape_page_embeddings`; the denormalised copy exists so the
trainer doesn't pay a join per row.

### 5.3 How RAG retrieval drives the decision

Inside `scoreEscalation(state)`:

```
// 1. handcrafted features → base Q-values
const baseQ = featurize(state) · W;

// 2. retrieve neighbours from mdp_scrape_page_embeddings
//    (skip if embedding not yet generated)
const neighbors = await topKByCosine({
  embedding: state.pageHtmlEmbedding,
  embeddingType: 'page_html',
  k: 8,
  excludeUrlHash: state.urlHash,
});

// 3. for each neighbour, look up the reward-per-action they actually got
//    (from mdp_scrape_outcomes joined on mdp_scrape_decisions)
const neighborQ = await neighborMeanRewardPerAction(neighbors);

// 4. Bayesian blend — neighbour weight tapers off as we accumulate
//    direct evidence on this exact URL
const n = state.priorDecisionCountForThisUrl;
const lambda = 5 / (n + 5);                     // strength of the neighbour prior
const Q = mapActions(a => (1 - lambda) * baseQ[a] + lambda * neighborQ[a]);
```

This is the "recognition + RAG" loop the user asked about: at decision
time, we *retrieve* similar past pages, *aggregate* their outcomes per
action, and *blend* that into the policy as a prior. As the URL itself
accumulates direct evidence, the blend leans toward direct Q and away
from the neighbour estimate.

### 5.4 Why this accelerates learning

- **Cold start on new URLs.** Without the neighbour prior, a never-seen
  URL has only the population-average Q. With the neighbour prior, an
  `/about` page on a fresh domain inherits the average outcome of
  every `/about` page we've decided on.
- **Cold start on new domains.** A new SaaS marketing site embeds
  near other SaaS marketing sites; if those reliably need browser
  escalation, the prior nudges us to escalate immediately.
- **Recognition of bad templates.** "Dead WordPress with consent
  banner and no contact info" is a recognisable cluster. The
  neighbour prior on those will favour `stop`, saving Gemini probe
  cost on every future hit.
- **Generalisation across queries.** The embedding doesn't include
  the originating query, so two queries that surface the same kind of
  page will share evidence. The existing per-query bandit cannot do
  this.

### 5.5 Caching + retention

Two cache layers, mirroring
[`mdp-user-embeddings.ts`](../src/server/subroutines/mdp/mdp-user-embeddings.ts):

1. In-memory `Map<urlHash, EmbeddingVector>` with a 24h TTL — saves
   the round-trip to `mdp_scrape_page_embeddings` for hot URLs inside
   one cron run.
2. The persistent `mdp_scrape_page_embeddings` row — survives
   redeploys, shared across cron runs and across processes.

`topKByCosine` is an `ORDER BY embedding <=> $1 LIMIT 8` against
`mdp_scrape_page_embeddings` filtered by `embedding_type` and
`provider`. Add an HNSW index on `(embedding_type, provider, embedding)`
from day one — this table will grow faster than user-entity
embeddings, so don't wait until the exact scan gets slow.

Retention: a nightly job evicts rows where `last_decision_at` is older
than 90 days **and** the URL has produced zero new emails across all
historical decisions. Keep everything else — the long-tail negatives
are exactly what the policy needs to learn `stop`. Retention runs
against `mdp_scrape_page_embeddings` only; user-entity embeddings are
unaffected.

---

## 6. Reinforcement learning — how this becomes RL

Same three-stage progression as
[`mdp-for-notifs-and-more.md` §5.1](./mdp-for-notifs-and-more.md#51-bandit--full-mdp-in-three-stages):

1. **Contextual bandit (immediate reward).** Reward is computed within
   ~30s of the decision (browser ran, we know if it found emails).
   This is the natural starting point — escalation is essentially a
   one-step decision per URL. Algorithm: per-action linear logistic
   regression with Thompson sampling; the action's "prediction" is the
   probability of positive reward.
2. **Episodic bandit with delayed reward (probably skip).** There is
   no real "session" the way there is for notifs. The URL either
   yielded emails or it didn't. Stage 2 is mostly irrelevant here.
3. **Two-step MDP.** Becomes meaningful only because of the probe →
   browser sequence. The full Q update credits the `gemini_probe`
   action with the eventual browser reward minus the probe cost. This
   is what lets the system learn *"the probe is worth it on
   marketing-looking pages with low mailto count but a Next.js
   bundle."*

Concrete update for stage 3 (function-approximation Q-learning):

```
// on each logged tuple (s, a, r, s')   — s' is the post-probe state
target = r + gamma * max_{a'} Q(s', a'; theta_target)
loss   = (Q(s, a; theta) - target)^2
theta  <- theta - eta * grad_theta loss
// every N batches: theta_target <- theta
```

`gamma = 0.9` is fine; the chain is at most two steps so discounting
barely matters, but keep γ < 1 for numerical stability.

### Exploration

ε-greedy (≤ 0.1) for the MVP, then promote to Thompson sampling on the
linear posteriors. The hard rail (see §8) is the budget cap, not ε.
Exploration of `gemini_probe` is cheap and should stay open longer
than exploration of `browser_*`.

### Off-policy evaluation

Identical pattern to
[`mdp-for-notifs-and-more.md` §5.6](./mdp-for-notifs-and-more.md#56-off-policy-evaluation-ope-and-safe-promotion):
inverse propensity scoring on held-out logged decisions, then a
canary cohort on a small fraction of run-batches. Promote a new
weights row only if estimated `emails / browser-second` is strictly
better than the current policy.

### Cold start

Three layers, top to bottom:

1. **Population prior** in code (`PRIOR_ESCALATION_WEIGHTS`).
2. **Domain prior** — once we have ≥5 decisions on a domain, shrink
   the per-domain success rate toward the population mean: weight the
   per-domain rate by `n / (n + 5)` and the population prior by
   `5 / (n + 5)`, where `n` is the per-domain decision count. Same
   shrinkage shape as the neighbour blend in §5.3 (small-n →
   population dominates; large-n → direct evidence dominates).
3. **Embedding-neighbor prior** — for unseen URLs, use the average Q
   of the top-K nearest URL embeddings.

---

## 7. Schema (planned)

Mirrors the planned `mdp_decisions` / `mdp_events` tables in
[`mdp-for-notifs-and-more.md` §6](./mdp-for-notifs-and-more.md#suggested-tables),
with a `surface = 'scrape_escalation'` discriminator so they can share
the trainer.

```sql
-- per-URL escalation decision (one row per call to scoreEscalation;
-- a single URL with a probe will produce 2 rows linked by parent_id)
create table mdp_scrape_decisions (
  id                 uuid primary key,
  parent_id          uuid,                          -- ties step-2 decisions to their step-1 parent
  run_batch_id       uuid not null,                 -- matches email_scrape_tool_runs.run_batch_id
  query_row_id       uuid,
  url                text not null,
  domain             text not null,
  policy_version     text not null,
  state_jsonb        jsonb not null,                -- PageState, including any probe outputs already merged
  action             text not null,                 -- 'stop' | 'gemini_probe' | 'browser_playwright' | 'browser_puppeteer'
  q_values_jsonb     jsonb not null,                -- {action -> q-value} at decision time
  epsilon            real not null,
  explored           boolean not null,
  cheap_adapter_name varchar(60) not null,
  cheap_emails_found integer not null default 0,
  page_embedding     vector,                        -- nullable; populated lazily; dimensionless because providers vary (Gemini 768, OpenAI 1536/3072)
  page_embedding_provider text,                     -- which provider produced page_embedding for this row
  created_at         timestamptz not null default now(),

  constraint mdp_scrape_decisions_parent_fk
    foreign key (parent_id) references mdp_scrape_decisions(id) on delete set null
);
create index idx_mdp_scrape_decisions_run_batch on mdp_scrape_decisions(run_batch_id);
create index idx_mdp_scrape_decisions_domain on mdp_scrape_decisions(domain);
create index idx_mdp_scrape_decisions_action on mdp_scrape_decisions(action);
create index idx_mdp_scrape_decisions_parent on mdp_scrape_decisions(parent_id);

-- one row per resolved decision (browser ran, or 'stop' decided the URL is dead)
create table mdp_scrape_outcomes (
  id                       uuid primary key,
  decision_id              uuid not null references mdp_scrape_decisions(id),
  reward                   real not null,           -- computed by mdp-scrape-reward.ts
  reward_version           text not null,
  new_unique_emails_found  integer not null default 0,
  browser_invoked          boolean not null default false,
  browser_duration_ms      integer not null default 0,
  browser_captcha          boolean not null default false,
  gemini_probe_invoked     boolean not null default false,
  gemini_probe_jsonb       jsonb,                   -- raw probe output
  occurred_at              timestamptz not null default now()
);
create index idx_mdp_scrape_outcomes_decision on mdp_scrape_outcomes(decision_id);

-- versioned policy weights (shared schema with the notif/feed surfaces)
-- See `mdp_policy_weights` in mdp-for-notifs-and-more.md §6 — same table,
-- this surface uses surface = 'scrape_escalation'.

-- dedicated page-embedding store; intentionally NOT entity_embeddings,
-- to keep the high-volume scrape corpus from blowing up the main table
-- that powers user-facing entity recall (people, leads, candidates, posts).
create table mdp_scrape_page_embeddings (
  id                uuid primary key,
  url_hash          bytea not null,                  -- sha256(url)
  url               text not null,
  domain            text not null,
  embedding_type    text not null,                   -- 'page_html' | 'page_probe'
  provider          text not null,                   -- 'gemini' | 'openai' | ...
  model_name        text not null,
  dimensions        integer not null,
  embedding         vector,                          -- size matches `dimensions`
  content_hash      bytea not null,                  -- sha256 of the embedded text
  source_text_len   integer not null,                -- length of pre-truncation input
  last_decision_id  uuid,                            -- most recent decision that used this row
  last_decision_at  timestamptz,
  meta_jsonb        jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (url_hash, embedding_type, provider, model_name)
);
create index idx_mdp_scrape_page_emb_domain on mdp_scrape_page_embeddings(domain);
create index idx_mdp_scrape_page_emb_last_decision on mdp_scrape_page_embeddings(last_decision_at);
-- HNSW for ANN cosine search; one partial index per (embedding_type, provider)
-- pair, since dimensions differ across providers and we always filter by both.
create index idx_mdp_scrape_page_emb_hnsw_html_gemini
  on mdp_scrape_page_embeddings using hnsw (embedding vector_cosine_ops)
  where embedding_type = 'page_html' and provider = 'gemini';
```

The source of truth for embeddings is `mdp_scrape_page_embeddings`,
keyed by `(url_hash, embedding_type, provider, model_name)` — see §5.2
for why we deliberately keep this off `entity_embeddings`. The
`page_embedding` column on `mdp_scrape_decisions` is a denormalised
copy of the active vector at decision time, populated by
`scoreEscalation` so the trainer can read it without an extra join.

---

## 8. Safety rails

- **Budget caps live outside the model.** Every run sets
  `browserBudgetRemainingThisRun` (e.g. 50 launches) and
  `geminiBudgetRemainingThisRun` (e.g. 200 probes). When a budget hits
  zero, the policy can no longer choose that action — enforced in
  `scoreEscalation` by zeroing the corresponding logits, not by
  trusting the model to learn the limit. This mirrors the "hard limits
  outside the model" rule from
  [`mdp-for-notifs-and-more.md` §8](./mdp-for-notifs-and-more.md#8-safety-rails).
- **Per-domain cooldown reuse.** Honour the existing `cooldownUntil`
  on `email_scrape_tool_aggregates` for browser adapters. The cooldown
  is keyed by `(toolName, engine)`; the engine consulted is **the
  engine that surfaced this URL into the run** (carried on
  `PageState.engine`, originating from the SERP step). If
  `(playwright, <surfacing_engine>)` is in cooldown, the policy
  cannot pick `browser_playwright` for this URL until cooldown lifts,
  regardless of Q-value. Same rule for `browser_puppeteer`.
- **Robots / TOS guard.** Browser escalation must consult the same
  `robots.txt` / blocklist gate that
  [`fetch-cheerio-adapter.ts`](../src/server/services/scrapers/fetch-cheerio-adapter.ts)
  uses. The model must not be able to earn reward by side-stepping it.
- **Probe-truncation logging.** Always log the byte length of HTML
  passed to Gemini. If the trainer sees that decisions on
  truncation-clipped pages systematically underperform, that's a
  feature-engineering signal, not a policy bug.
- **Exploration cap on browsers.** ε for `browser_*` actions is
  capped at 0.05 in prod; ε for `gemini_probe` and `stop` can stay at
  0.10. We don't want random browser launches eating budget.
- **Reward hacking guard.** The reward must subtract for captchas /
  blocks. Without that term, the policy can learn to "always
  Playwright" on adversarial pages because the few that work outweigh
  the soft cost.

---

## 9. Wiring it into the live system (staged)

None of these are done. They can be done independently, same shape as
[`mdp-for-notifs-and-more.md` §7](./mdp-for-notifs-and-more.md#7-wiring-it-into-the-live-system-staged).

### Stage A — shadow scoring
- Add `scoreEscalation(state)` and call it from
  [`email-scrape-multi-tool-routines.ts`](../src/server/subroutines/email-scrape-multi-tool-routines.ts)
  after every cheap fetch.
- Persist the decision to `mdp_scrape_decisions`.
- **Do not run the action.** Browser adapters keep running through
  the existing rotation. We're only measuring agreement / disagreement
  between the proposed escalation and what actually happened.

### Stage B — passive reward logging
- After every browser run that did happen (still via existing
  rotation), look up the matching shadow decision (by `run_batch_id +
  url`) and write an `mdp_scrape_outcomes` row.
- After every URL that the existing pipeline gave up on, write a
  `stop` outcome.
- We now have `(state, action, reward)` for the trainer.

### Stage C — gate browser launches behind the policy
- Remove browser adapters from the cheap-rotation pool in
  [`scrape-tool-rotation-routines.ts`](../src/server/subroutines/scrape-tool-rotation-routines.ts).
- Browser adapters are now invoked **only** when
  `scoreEscalation` returns `browser_*`.
- Keep ε high (0.10) for the first week so we keep collecting
  exploration data on URLs the policy would otherwise skip.

### Stage D — turn on the Gemini probe
- Implement `runGeminiHtmlProbe` in
  `mdp-scrape-escalation-routines.ts`, sharing key rotation with
  [`gemini-email-match-routines.ts`](../src/server/subroutines/gemini-email-match-routines.ts).
- Add `gemini_probe` to the action set. Initial weights bias toward
  the probe when `mailtoCount === 0 && obfuscatedEmailCount === 0 &&
  byteLength < 8000 && frameworkHints.anyJsApp`.

### Stage E — train + promote
- Implement nightly `train-escalation` cron handler.
- Replace `PRIOR_ESCALATION_WEIGHTS` with weights loaded from
  `mdp_policy_weights` (same KV-loaded pattern as the notif surface).
- Gate promotion behind IPS eval + canary on a fraction of
  `run_batch_id`s.

### Stage F — page-embedding recognition + RAG (see §5)
- Create the dedicated `mdp_scrape_page_embeddings` table (§7) — keep
  it off `entity_embeddings` so the high-volume scrape corpus does not
  contend with user-entity recall.
- Generate `page_html_embedding` lazily on first decision per URL via
  the helper in
  [`multi-provider-embeddings.ts`](../src/server/subroutines/multi-provider-embeddings.ts),
  but persist into the new table.
- Wire `topKByCosine` (pgvector `<=>` operator over the partial HNSW
  index) and the Bayesian blend from §5.3 into `scoreEscalation`.
- Generate `page_probe_embedding` after each Gemini probe and store it
  alongside the html embedding.
- Add the nightly retention job described in §5.5.
- Once Stage E weights are learned, also feed the embedding directly
  into the featurizer so the Q-network gets shared-parameter
  generalisation on top of the RAG prior.

---

## 10. What this MVP does **not** do (explicitly)

- Does not change the cheap-adapter rotation at all.
- Does not run Gemini probes or persist their outputs.
- Does not write to `email_scrape_tool_runs` or
  `email_scrape_tool_aggregates`.
- Does not gate any live browser launch (until Stage C).
- Does not train weights — the prior is hand-tuned.
- Does not do off-policy evaluation.

All of the above are stages B–F.

---

## 11. Smoke tests (planned)

```bash
# list available actions (should now include score-escalation, train-escalation)
curl 'https://<host>/api/cron/mdp?action=status'

# shadow-score every URL fetched in a recent run-batch
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=score-escalation&runBatchId=<uuid>'

# score a single URL with explicit cheap-fetch HTML (POST)
curl -X POST -H "x-cron-secret: $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/team","cheapAdapterName":"fetch-cheerio","html":"...","cheapEmails":[]}' \
  'https://<host>/api/cron/mdp?action=score-escalation'

# nightly trainer (will no-op until Stage B has produced outcomes)
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=train-escalation'
```

---

## 12. Relationship to the existing rotation bandit

The existing per-(tool, engine) bandit in
[`scrape-tool-rotation-routines.ts`](../src/server/subroutines/scrape-tool-rotation-routines.ts)
solves a different question: *"which adapter should I use to fetch
this URL in the first place?"* It's stateless w.r.t. the page. It
should keep doing that for cheap adapters indefinitely.

The escalation policy in this doc solves: *"given what came back, do I
escalate?"* It is conditioned on the **actual response**, not on prior
adapter performance.

The two systems share infra:
- Same `mdp_policy_weights` table (different `surface`).
- Same KV / EWMA primitives where useful.
- Same featurizer module (planned `mdp-features.ts` extraction).
- Same exploration philosophy (Thompson on linear posteriors,
  fall back to ε-greedy).
- Same OPE → canary → promote loop.

They differ in their **state space** (page-level vs. tool-level), and
that is the whole point of adding the escalation surface.
