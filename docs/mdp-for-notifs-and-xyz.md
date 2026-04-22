# Core Engine: Markov Decision Process (MDP) System

This document outlines the architecture, roadmap, and staged implementation plan for integrating a multi-purpose Reinforcement Learning (RL) / Markov Decision Process (MDP) system into the Dancing Dragons platform. 

The `mdp-engine-routines` is built as a polymorphic system designed to handle three distinct cognitive loops:
1. **Notifications Engine:** Determines "WHEN to send."
2. **Feed Recommendation Engine:** Determines "WHAT to show."
3. **Marketing Prediction Engine:** Determines "WHO is ready to convert."

---

## 🎯 The Three Engines

### 1. Notifications Engine (Temporal Optimization)
*   **State (S):** User recency, fatigue score, day of week, time of day.
*   **Action (A):** The delay interval (e.g., Send Now=1, Delay 2h=2, Hold).
*   **Reward (R):** +1 for notification open, -0.5 for ignore, -10 for churn.

### 2. Feed Recommendation Engine (Content Optimization)
*   **State (S):** Current session dwell time, recent N items viewed, user content embedding.
*   **Action (A):** Select item UUID from 100+ candidate vectors (retrieved via `pgvector`).
*   **Reward (R):** +1 for click, +3 for share/like, -1 for fast skip, +5 for extending session duration.

### 3. Marketing Prediction Engine (Conversion Optimization)
*   **State (S):** Profile completeness score, platform age, meeting participation count, feature adoption score.
*   **Action (A):** Binary intervention (1 = Inject marketing upsell UI/email, 0 = Wait).
*   **Reward (R):** +50 for clicking to upgrade/purchasing, -2 for immediate bounce on marketing page.

---

## 🏗️ Staged Wiring Plan

### Phase 1: Polymorphic Contextual Bandit (Shadow Mode)
*   **Goal:** Build data pipelines, establish standardized contextual state representations per domain, and log proposed decisions *without* impacting user UX.
*   **Actions:**
    *   Deploy `mdp-notifications-routines.ts` and general cron triggers (`/api/p/crons/mdp-notifications`).
    *   Log proposals to `mdp_decisions` table with contextual flags (`contextType: 'notification' | 'feed' | 'marketing'`).

### Phase 2: Reward Logging & Q-Value Initialization
*   **Goal:** Close the feedback loop by attributing subsequent events (feed dwell times, email clicks, coaching conversions) back to logged decisions.
*   **Actions:**
    *   Hook into click handlers, feed viewing subroutines, and Stripe billing pipelines.
    *   Run nightly batch jobs to calculate composite delayed rewards based on `mdp_events`.

### Phase 3: Collaborative Generalization (Gradients)
*   **Goal:** Enable collaborative learning across similar user groupings.
*   **Actions:**
    *   Integrate `user_embeddings` (from user behavior interactions) into the MDP State arrays.
    *   Connect backprop updates on the `mdp_policy_weights` table: $loss = (Q(s,a) - Target)^2$.

### Phase 4: Production Rollout
*   **Goal:** Actively hand over non-critical decision flows to the engine.
*   **Actions:**
    *   Implement $\varepsilon$-greedy sampling in production feeds and notification schedulers.

---

## 🗄️ Proposed Schemas

### 1. `mdp_decisions`
Logs every interaction and domain context.
```typescript
{
  id: uuid,
  ddUserId: uuid,
  contextType: string,     // 'notification' | 'feed_recommendation' | 'marketing_prediction'
  stateVector: jsonb,      // Abstract numeric representation [0.1, 14, 0.4, ...]
  actionTaken: string,     // The literal string action or UUID chosen
  exploration: boolean,    // True if chosen via epsilon
  propensityScore: float,  // Initial predicted Q-value
  realizedReward: float,   // Updated async
  createdAt: timestamp
}
```

### 2. `mdp_events`
Asynchronous signal attribution mechanism.
```typescript
{
  id: uuid,
  ddUserId: uuid,
  decisionId: uuid,        // FK to mdp_decisions
  eventType: string,       // e.g., 'feed_post_dwell', 'notification_ignored'
  eventValue: float,       // Represents multiplier (seconds or weight)
  createdAt: timestamp
}
```

### 3. `mdp_policy_weights`
Parameter storage for the individual network approximations.
```typescript
{
  domainContext: string,   // 'notification' | 'feed_recommendation' | ...
  layerId: string,         
  weights: jsonb,          // Flattened weights array
  version: integer,
  updatedAt: timestamp
}
```

---

## 🛡️ Safety Rails

1.  **Global Throttling:** Non-transactional notification limiters run post-MDP logic.
2.  **Marketing Velocity Limit:** Prevent a user from receiving $>1$ conversion flag in any 14-day window.
3.  **Feed Diversity Penalties:** Hard negative modifiers added to $Q(s,a)$ if candidate item similarities are mathematically too close to recent items.
4.  **Cold Start Fallback (Safe Default):** Users missing structural baseline data (new accounts) route to simple time-independent baselines. 

---

## 🧠 Reinforcement Learning & Q-Learning Implementation

The core mathematical engine bridging the gap between raw interactions and the "Prediction Engine" is a deep variant of Q-Learning (DQN). The system is designed to seamlessly transition from purely supervised heuristics (Phase 1) to fully autonomous, delayed-reward optimization (Phase 3).

### 1. The Q-Function ($Q(s,a)$)
The fundamental goal of the engine is to approximate the Q-Function:
$Q(s, a) = \text{Expected long-term value of taking action } a \text{ in state } s$

Right now, the `evaluateQValue` subroutines are manually engineered heuristics. In Phase 3, this will be replaced by a Multi-Layer Perceptron (MLP) mapping the `StateVector` to a real number for each action.

### 2. Credit Assignment via the Bellman Equation
How does the system know that an email sent *yesterday* caused a conversion *today*? Through Temporal Difference (TD) learning using the Bellman Equation:
$Q(s, a) \leftarrow Q(s, a) + \alpha \left[ R + \gamma \max_{a'} Q(s', a') - Q(s, a) \right]$

*   **Alpha ($\alpha$):** Learning rate (how quickly to override old behavior).
*   **Gamma ($\gamma$):** Discount factor (e.g., $0.95$). Ensures that immediate rewards (feed click) are valuable, but long-term states (session retention) dictate optimal strategy.

**Implementation Plan:** 
1. The cron sweeps capture user "transitions" into the `mdp_events` table as $(S_t, A_t, R_{t+1}, S_{t+1})$ tuples.
2. An asynchronous worker queries these tuples nightly, calculating the TD error.
3. The gradient is applied to the MLP parameters stored in `mdp_policy_weights`.

### 3. "Cross-Pollination" (Generalization across users)
Standard Q-Learning builds a giant table of answers, which is impossible due to millions of state permutations. By integrating `pgvector` user embeddings into the state array, the Neural Network generalizes:
*   Because User A and User B possess similar content embeddings, when User A engages favorably with a specific notification interval or feed topic, the weights in `mdp_policy_weights` adapt. 
*   User B automatically inherits this learned optimal path without needing to undergo inefficient exploration themselves.

### 4. Continuous Exploration
The system fundamentally relies on an **$\varepsilon$-Greedy Policy** (`selectActionWithEpsilon`).
*   $90\%$ of the time ($\varepsilon = 0.90$), the system chooses the maximum $Q(s, a)$ action.
*   $10\%$ of the time, the system rolls the dice and selects a random action. This ensures the system perpetually pushes its mathematical boundaries, discovering if new patterns (e.g., a shifting trend in coach bookings on Tuesdays) have emerged over time.
