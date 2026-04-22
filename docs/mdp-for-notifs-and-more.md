# MDP / Contextual Bandit — Notifications, Feed, and a Generic Predictor

This document describes the MVP that was landed in
[`src/server/subroutines/mdp/`](../src/server/subroutines/mdp/) and the
[`/api/cron/mdp`](../src/app/api/cron/mdp/route.ts) route, and lays out the
roadmap to turn it into a real learning system.

The current code is intentionally **separate from the live notification and
feed pipelines**. It reads, computes, and returns decisions — it does **not**
send, persist policy state, or modify existing tables. Every handler is
callable from the cron route for smoke testing.

---

## 1. Scope

Three decisioning surfaces share one pipeline:

| Surface           | Decision                             | Module                                                                                                       |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Notifications     | should we send / delay / hold?       | [`mdp-notif-routines.ts`](../src/server/subroutines/mdp/mdp-notif-routines.ts)                               |
| Feed (`u/user/feed`) | which items, in what order?       | [`mdp-feed-recommender-routines.ts`](../src/server/subroutines/mdp/mdp-feed-recommender-routines.ts)         |
| Generic prediction | when will event X happen? how likely is class Y? | [`mdp-event-predictor-routines.ts`](../src/server/subroutines/mdp/mdp-event-predictor-routines.ts) |

A fourth module, [`mdp-user-embeddings.ts`](../src/server/subroutines/mdp/mdp-user-embeddings.ts),
owns Gemini embeddings + cosine-similarity neighborhoods, which is the
mechanism by which "similar users help the algorithm learn faster."

Shared types live in [`mdp-types.ts`](../src/server/subroutines/mdp/mdp-types.ts).

---

## 2. Cron surface

All endpoints live at `/api/cron/mdp?action=<name>`. Auth mirrors
[`cron-generic`](../src/app/api/cron-generic/route.ts) via
`authenticateCronRequest`. `action=status` is unauthed and enumerates the
other actions.

| Action               | Purpose                                                      | Notable params                                  |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `status`             | list available actions + embedding cache size               | —                                               |
| `score-notifs`       | score a batch of candidate users and return "would-send" set | `limit`, `epsilon`, `embed=1`, `similar=1`      |
| `embed-users`        | (re)compute Gemini embeddings for candidate users            | `limit`                                         |
| `find-similar-users` | top-K cosine neighbors for a user                            | `userId`, `k`                                   |
| `rank-feed-mock`     | rank a synthetic candidate set for a real user state         | `userId`, `count`, `topN`                       |
| `predict-next-event` | exponential-smoothing prediction of next event time          | `userId`, `eventKind` (POST with `{events:[]}`) |
| `score-propensities` | coaching-interest / churn-risk / upgrade likelihood          | `userId`                                        |

### How it maps to the original four questions

1. **Triggers.** The cron route is the batch trigger. There is no interaction
   trigger yet — see §6 for the `mdp_events` ingestion plan.
2. **When do calculations run.** All math currently runs inside cron
   handlers. State features are read on-demand; scoring is a hand-tuned
   linear model (no matrix ops beyond embedding dot products). No training
   runs yet.
3. **RL / similar users.** Today: cosine similarity over Gemini embeddings.
   Future: shared-parameter Q-network where the embedding is an input
   feature, so SGD updates from user A automatically improve predictions for
   embedding-similar user B. See §5.
4. **Other predictions.** Covered by the event predictor and propensity
   heads. See §4.

---

## 3. MDP formulation

### 3.1 Notifications

- **State vector** (in `MdpUserState`, built in `buildUserState`): hour, day
  of week, recency of last activity, notifs sent in 24h/7d, 7d open rate,
  tenure, role bucket, account active, optional Gemini user embedding.
- **Actions**: `do_not_send | send_now | delay_30min | delay_2h`.
- **Reward (future)**: `+1` open, `+2` meaningful action, `-0.5` ignored,
  `-2` repeated ignore, `-10` churn. Rewards are not computed yet — §6.
- **Policy**: hand-tuned linear scorer over sin/cos-encoded time features
  and handcrafted fatigue/recency terms. ε-greedy selection on a softmax of
  raw Q-values. These weights are a **prior**, not a learned policy — the
  trainer will replace them.

### 3.2 Feed

- **State**: same `MdpUserState` with the user embedding mandatory.
- **Action**: rank a supplied candidate pool. The MVP accepts candidates
  from the caller rather than retrieving them, so candidate generation can
  evolve independently.
- **Score**: `w₁·cosine(userEmb, itemEmb) + w₂·recency + w₃·popularity − w₄·diversityPenalty`.
  Diversity penalty applies when the same `authorId` shows up more than once
  in a sliding window.

### 3.3 Generic predictor

- **Event time** (`predictNextEvent`): filter events by kind, compute
  inter-arrival gaps, exponentially smooth with `α=0.5`, add a confidence
  term based on stability and sample count.
- **Propensity** (`scorePropensity`): hand-tuned logistic regression with
  three labels for the MVP — `coaching_interest`, `churn_risk`,
  `upgrade_likelihood`. Same feature pipeline as the notif bandit.

---

## 4. Why "similar users" helps learning

There are two mechanisms, and the MVP ships only the first:

1. **Embedding-space nearest neighbors (shipped).** A user's state includes
   a Gemini embedding of a natural-language summary of their behavior.
   `findTopKSimilarUsers(userId, k)` returns neighbors by cosine similarity.
   Useful immediately for cold-start ("borrow the centroid of my 5 nearest
   warm neighbors") and for explanation ("why did we pick this action").
2. **Shared-parameter Q-network (roadmap).** When the trainer is built, the
   policy becomes `Q(s, a; θ)` where `s` contains `user_embedding`. Gradient
   updates from any user's `(s, a, r, s')` tuple update the shared θ. Two
   users with nearby embeddings automatically have similar Q-values — this
   is how the system generalizes across users.

The embedding cache today is an in-memory `Map` with a 24h TTL. It will not
survive a redeploy. Promoting it to persistence is the first step in §6.

---

## 5. Reinforcement learning — how this becomes RL

The MVP is a **hand-tuned linear scorer**, not RL. This section is the bridge
from "prior weights in a module constant" to a real learning system. It is
explicit about what learning rule runs, when it runs, how similar-user
generalization actually happens, and how we keep it from blowing up in prod.

### 5.1 Bandit → full MDP, in three stages

Do not ship a full RL agent first. The three stages, in order:

1. **Contextual bandit (reward = immediate).** Treat each decision as
   independent. Reward is whatever happened in the next ~30 min (open /
   click / ignored). Algorithm: LinUCB or Thompson sampling on logistic
   regression. This is what the notif surface should ship first — it's
   ~50 lines of math, gives cross-user learning via shared weights, and is
   safe because it cannot "starve now to win later."
2. **Episodic bandit with delayed reward.** Reward window extends to the
   end of the session or +24h. You still don't model transitions; you just
   wait longer before crediting the action. This catches "good long-read
   article" vs "cheap click-bait" without needing a value function.
3. **Full MDP via fitted Q-iteration or DQN.** Now `Q(s, a)` learns the
   expected *discounted return*: immediate reward + γ · max_a' Q(s', a').
   You need next-state snapshots in the log for this to work (§6 tables).
   γ = 0.9 is a reasonable starting point; tune it against offline eval.

The feed surface is bandit-shaped for a long time (each impression has a
fast signal). The notif surface graduates to MDP once we have enough
`next_state` data to learn that a silent hour now can earn a click later.

### 5.2 Function approximation and shared parameters

The policy is **one model, shared across all users**. Per-user tables
(`Q[user][s][a]`) don't generalize — a new user has no data. Instead:

```
Q(state, action; θ) ≈ MLP([featurize(state), one_hot(action)])
```

`featurize(state)` includes the 768-dim Gemini user embedding. That single
architectural choice is what makes "similar users help each other learn":

- User A's tuple `(s_A, a, r)` produces gradient `∇θ L`.
- θ is the same parameters used to score user B.
- If `user_embedding_A ≈ user_embedding_B`, the featurized inputs are close,
  so the network's response at B moves in the same direction as at A.

There is no explicit "transfer" step. Generalization is a byproduct of
shared parameters + an input space where similar users are nearby. That's
the entire collaborative-filtering-plus-RL insight — everything else is
implementation detail.

A lighter-weight alternative for stage 1 is a **single linear model per
action** with the full feature vector (including embedding) as input. Same
shared-parameter property, trivially fast to fit with SGD or closed-form
ridge regression, and easy to interpret.

### 5.3 The learning update, concretely

For a contextual bandit with logistic reward:

```
# on each logged tuple (features x, action a, reward r in {0,1})
p = sigmoid(theta_a · x)
gradient = (p - r) · x
theta_a <- theta_a - eta · gradient
```

For a Q-learning update with function approximation:

```
# on each logged tuple (s, a, r, s')
target = r + gamma · max_{a'} Q(s', a'; theta_target)
loss   = (Q(s, a; theta) - target)^2
theta  <- theta - eta · grad_theta loss
# periodically: theta_target <- theta   (target network for stability)
```

Batch these over all users every night. Gradients from all users hit the
same θ. That is the mechanical answer to "how do similar users learn from
each other."

### 5.4 Exploration

Pure argmax on a freshly-trained policy stalls learning — you only ever see
outcomes for the actions the current policy prefers. Options, in order of
recommendation:

- **ε-greedy, low ε.** MVP ships this. Simple, safe if ε is small
  (≤ 0.05 in prod), but wastes exploration budget uniformly.
- **Thompson sampling** (Bayesian bandit). Sample weights from the
  posterior, pick the argmax under the sample. Explores more where
  uncertainty is high. Best default for the notif bandit.
- **UCB / LinUCB.** Add a confidence bonus to the mean reward. Requires
  tracking per-arm covariance but is deterministic and easy to reason
  about.
- **Intrinsic curiosity / entropy bonus.** Relevant only at stage 3+.

Important: exploration must respect the hard rails (quiet hours, max
notifs/day). A `do_not_send` action is always safe to explore; `send_now`
is not. Constrain the action space, not the exploration strategy.

### 5.5 Reward design (the actual hard part)

The model will optimize whatever you hand it. Pitfalls and fixes:

| Failure mode | Cause | Fix |
| ------------ | ----- | --- |
| Spams high-open-rate users | reward = click, no cost | add `-lambda · notifs_sent_24h` to reward |
| Prefers click-bait | dwell not considered | `reward = click + 2·long_dwell - 2·fast_back` |
| Ignores long-term value | no session/churn signal | at stage 2, include `+5·session_continued`, `-10·churn_within_7d` |
| Never "wakes up" dormant users | `do_not_send` always wins | Thompson sampling + longer reward window |

Write the reward function in one place (`mdp-reward.ts`, future) and
version it. Changing it is equivalent to redefining the task — log which
reward version produced which weights.

### 5.6 Off-policy evaluation (OPE) and safe promotion

Never promote a new policy just because training loss went down. Between
training and sending, run:

- **Inverse propensity scoring** on held-out logs: estimate what the new
  policy's reward *would have been* on historical states, weighted by the
  ratio of new/old action probabilities. This requires that the logging
  policy was stochastic — ε-greedy is enough.
- **Doubly-robust** adds a learned reward model to reduce IPS variance.
  Worth the complexity once you have >1M decisions logged.
- **Canary shadow traffic.** Send the new policy's action to a small %
  cohort; keep the old policy on the rest. Compare reward after N days.

Promote a new `mdp_policy_weights` row only if IPS estimate > old policy
by a margin *and* canary confirms. Everything else is a recipe for a bad
push-notif week.

### 5.7 Cold start

Three paths, all of which the MVP already sets up:

1. **Population prior.** A new user with no embedding and no history uses
   the `PRIOR_WEIGHTS` in the code today. These act as the Bayesian prior.
2. **Cohort centroid.** Once we have some behavior (even one session),
   compute the embedding, then average the embeddings of its `k` nearest
   warm neighbors via `findTopKSimilarUsers` and use that cohort's
   preferred action until we have direct data.
3. **Higher ε for new users.** For users with < 7 days tenure, double ε.
   Exploration is cheapest when the user hasn't formed a habit yet.

### 5.8 Per-surface notes

- **Notifications (Q-learning fits naturally).** Small discrete action
  set, clear reward window, state transitions matter (sending now changes
  the fatigue state). Ship as bandit, graduate to DQN.
- **Feed (stay in bandit land longer).** Action space is large
  (pick-from-candidates), but impressions are cheap and signals are fast.
  Use contextual bandits on `Q(user, item)` for a long time. Only
  graduate if you find cases where near-term clicks hurt session length.
- **Propensity heads (supervised, not RL).** `coaching_interest`,
  `churn_risk`, `upgrade_likelihood` don't have actions — they predict a
  label. Standard logistic regression / gradient-boosted trees. They
  *share the feature store* with the RL surfaces but are not RL.

### 5.9 Where each piece lives in the code

| Concept | MVP today | Planned home |
| ------- | --------- | ------------ |
| Policy (Q) | `PRIOR_WEIGHTS` constant in `mdp-notif-routines.ts` | `mdp_policy_weights` row loaded into KV at process start |
| Decision log | in-memory, returned in cron response | `mdp_decisions` table (§6) |
| Reward signal | not logged | `mdp_events` via `logMdpEvent` server action (stage B, §6) |
| Training step | none | nightly `/api/cron/mdp?action=train` handler (not yet implemented) |
| Exploration | ε-greedy on softmax | Thompson sampling per-action once weights are learned |
| Evaluation | none | IPS + canary inside the train handler |

## 6. Training loop

### What shipped

- `mdp_decisions` table — migration at
  `src/server/databases/neondb/migrations/manual/20260416_create_mdp_decisions_table.sql`,
  Drizzle table at
  `src/server/databases/neondb/tables/mdp-decisions-table.ts`.
- Writer module at `src/server/subroutines/mdp/mdp-decision-writer.ts` with
  `persistNotifDecision`, `persistEscalationDecision`, `recordDecisionExecution`.
- Feature-flagged via env `MDP_PERSIST_DECISIONS` (`'1' | 'true' | 'yes'`
  to enable). Disabled by default so the code can land pre-migration.
- Hooked at the route layer (`src/app/api/cron/mdp/route.ts`) so core
  decision modules stay pure. Every `score-notifs`, `score-escalation`, and
  `execute-notif` call now best-effort persists its decision; execution
  outcomes update the row in place.
- Executor layer at `src/server/subroutines/mdp/mdp-notif-executor.ts`
  with three modes (`shadow | canary | live`) gated by
  `MDP_NOTIF_EXECUTE_MODE`. Canary slice fraction via
  `MDP_NOTIF_CANARY_FRACTION` (default 5%), deterministic per ddUserId.

### Still planned

1. Log every decision to `mdp_decisions` (user, state snapshot, action
   chosen, Q-values, ε, policy-version).
2. Log every outcome to `mdp_events` (decision id, reward signal, observed
   next state).
3. Nightly trainer cron joins `(decision, event, next_state)` → produces
   TD targets → does mini-batch SGD on the shared Q-network.
4. Offline evaluation (IPS / doubly-robust) compares proposed policy vs
   current policy over held-out logs. Gate promotion behind an eval
   threshold.
5. Promote new weights by writing a new row to `mdp_policy_weights` and
   bumping the version served from KV.

### Suggested tables

```sql
-- decisions persisted for later reward-joining and training
create table mdp_decisions (
  id              uuid primary key,
  dd_user_id      uuid not null,
  policy_version  text not null,
  surface         text not null,           -- 'notif' | 'feed' | 'propensity'
  state_jsonb     jsonb not null,
  action          text not null,
  q_values        jsonb not null,
  epsilon         real not null,
  explored        boolean not null,
  created_at      timestamptz not null default now()
);

-- discrete events joined back to a decision (or user-level if unattributed)
create table mdp_events (
  id               uuid primary key,
  dd_user_id       uuid not null,
  decision_id      uuid,                   -- nullable: unattributed events
  kind             text not null,          -- 'open' | 'click' | 'dismiss' | 'session_end' | 'churn'
  reward           real not null,
  occurred_at      timestamptz not null,
  created_at       timestamptz not null default now()
);

-- materialized state snapshots for fast training + debugging
create table mdp_user_state (
  dd_user_id       uuid primary key,
  state_jsonb      jsonb not null,
  user_embedding   vector(768),
  updated_at       timestamptz not null default now()
);

-- versioned policy weights; server loads the active row into KV
create table mdp_policy_weights (
  id               uuid primary key,
  surface          text not null,
  version          text not null,
  weights_jsonb    jsonb not null,
  promoted_at      timestamptz,
  created_at       timestamptz not null default now()
);
```

---

## 7. Wiring it into the live system (staged)

None of these steps are done. They can be done independently.

### Stage A — shadow logging
- Run `/api/cron/mdp?action=score-notifs` on a 15-minute cron.
- Persist decisions to `mdp_decisions`.
- Do **not** send anything.
- Backtest: for each "would-send" decision, check whether the existing
  `push-notifs` cron also sent one within ±30 min.

### Stage B — passive reward logging
- Add a thin server action `logMdpEvent({ decisionId?, kind, reward })`.
- Call it from existing notif open/click handlers and from `session_end`
  heartbeats. Use `decision_id` in the payload if known.
- Still no sending; we now have `(state, action, reward, next_state)`
  tuples for training.

### Stage C — train + promote
- Implement the nightly trainer (§5).
- Replace `PRIOR_WEIGHTS` in `mdp-notif-routines.ts` with loaded weights
  from KV keyed by version.
- Gate promotion behind IPS eval and a manual "allow promote" flag.

### Stage D — actually send
- Wire `action === 'send_now'` into `pushNotificationService` behind a
  feature flag.
- Start with a small cohort (e.g. 5% of active users); compare against
  control.
- Keep the hard rails (quiet hours, max/day) outside the model.

### Stage E — feed
- Replace `mockFeedCandidates` with real candidate generation from the
  feed retrieval layer ([`user-feed-routines.ts`](../src/server/subroutines/user-feed-routines.ts)).
- Page load at `u/user/feed` calls a server action that returns
  `rankFeedItems(state, candidates)`. Log impressions + interactions to
  `mdp_events` with `surface='feed'`.

### Stage F — propensity surfaces for marketing
- Nightly cron writes `scoreAllPropensities(state)` for every active user
  into a marketing-facing table (or syncs to HubSpot via the existing
  `hubspot-sync` cron).
- Sales uses the `coaching_interest` score to prioritize outreach.
- The trainer fills in real weights once we have outcome labels.

---

## 8. Safety rails

- **Hard limits live outside the model.** Max N notifs/user/24h, quiet
  hours, user prefs — enforce these in the sender, not the Q-network. The
  bandit should never be able to earn reward by discovering a loophole.
- **Exploration cap.** ε ≤ 0.1 in production; a fraction of that budget
  goes to Thompson/UCB-style exploration rather than uniform random.
- **Cold start fallback.** If a user has no embedding, the notif policy
  defaults to the population-averaged prior. For marketing propensity,
  users with <7 days tenure get a separate "new user" prior.
- **Reward hacking guard.** The trainer must include a strong negative
  term for `repeated_ignore` and `churn`. Without it, the model will learn
  to spam.

---

## 9. What the MVP does **not** do (explicitly)

- Does not send notifications.
- Does not write to `notifications`, `notification_user`, or any live
  table.
- Does not persist decisions, rewards, or embeddings beyond process
  memory.
- Does not train weights — the prior is hand-tuned.
- Does not drive the real feed at `u/user/feed`.
- Does not do off-policy evaluation.

All of the above are stage B–E in §7.

---

## 10. Smoke tests

```bash
# list available actions
curl 'https://<host>/api/cron/mdp?action=status'

# build embeddings for 10 active users
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=embed-users&limit=10'

# score 10 users, include similar-user recall in the response
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=score-notifs&limit=10&similar=1'

# nearest neighbors for one user
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=find-similar-users&userId=<uuid>&k=5'

# rank a mock feed for one real user
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=rank-feed-mock&userId=<uuid>&count=20&topN=10'

# propensity scores for a real user
curl -H "x-cron-secret: $CRON_SECRET" \
  'https://<host>/api/cron/mdp?action=score-propensities&userId=<uuid>'

# predict next event with explicit time series (POST)
curl -X POST -H "x-cron-secret: $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"events":[{"kind":"site_visit","ts":"2026-04-10T10:00:00Z"}, ...]}' \
  'https://<host>/api/cron/mdp?action=predict-next-event&eventKind=site_visit'
```
