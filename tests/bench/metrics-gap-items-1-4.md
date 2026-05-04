# Metrics Gap Items 1–4 — Implementation Spec

Four quick-win instrumentation improvements for `tests/bench/metrics.ts` and
`tests/bench/report.ts`. All derive from already-captured data — no new event
emission needed. Items 1-2 are ~30 min total; items 3-4 are ~30 min each.

Each item below gives: the exact change to the interface, the exact change to
the aggregation function, and the exact change to the serializer in `report.ts`.
Run `bunx biome check --write tests/bench/` and `bunx tsc --noEmit` after each
item. Run `bun test tests/bench/` after all four to catch any broken tests
(snapshot tests will need updating).

---

## Item 1 — AKM engagement rates

**Why:** `meanSearchCount` only tells you the average invocation count. It can't
tell you what fraction of runs call AKM at all. A mean of 0.4 could mean 40%
of runs call it once or 20% call it twice. Engagement *rate* is the right
denominator for diagnosing whether agents skip AKM entirely.

**Files:** `tests/bench/metrics.ts`, `tests/bench/report.ts`

### 1a. `AkmOverheadAggregate` interface — `metrics.ts` line ~2999

Add three fields after `costPerSuccess`:

```ts
/** Fraction of runs (0–1) that invoked `akm search` at least once. */
searchEngagementRate: number;
/** Fraction of runs (0–1) that invoked `akm show` at least once. */
showEngagementRate: number;
/** Fraction of runs (0–1) that invoked `akm feedback` at least once. */
feedbackEngagementRate: number;
```

### 1b. Zero envelope in `aggregateAkmOverhead` — `metrics.ts` line ~3158

In the early-return when `n === 0`, add:

```ts
searchEngagementRate: 0,
showEngagementRate: 0,
feedbackEngagementRate: 0,
```

### 1c. Accumulate in the loop — `metrics.ts` line ~3193

Add three counters before the loop:

```ts
let searchEngagedRuns = 0;
let showEngagedRuns = 0;
let feedbackEngagedRuns = 0;
```

Inside the `for (const row of perRun)` loop (after the existing counter lines):

```ts
if (row.searchCount > 0) searchEngagedRuns += 1;
if (row.showCount > 0) showEngagedRuns += 1;
if (row.feedbackCount > 0) feedbackEngagedRuns += 1;
```

### 1d. Return the rates — `metrics.ts` in the `return` object of `aggregateAkmOverhead`

```ts
searchEngagementRate: searchEngagedRuns / n,
showEngagementRate: showEngagedRuns / n,
feedbackEngagementRate: feedbackEngagedRuns / n,
```

### 1e. Extend the serializer — `report.ts` `serialiseAkmOverheadAggregate`

Add three fields to the return type annotation and body:

```ts
// Return type:
search_engagement_rate: number;
show_engagement_rate: number;
feedback_engagement_rate: number;

// Body:
search_engagement_rate: agg.searchEngagementRate,
show_engagement_rate: agg.showEngagementRate,
feedback_engagement_rate: agg.feedbackEngagementRate,
```

---

## Item 2 — Search-to-show ratio

**Why:** A ratio < 1.0 means agents often search but never load anything
(`search_no_gold` pattern). A ratio > 1.0 means they load multiple assets per
search. This is distinct from `no_search` and is the next most-common failure
mode but currently invisible in the aggregate.

**Files:** `tests/bench/metrics.ts`, `tests/bench/report.ts`

### 2a. `AkmOverheadAggregate` interface — `metrics.ts` line ~2999

Add after the engagement rate fields from item 1:

```ts
/**
 * `showSum / searchSum` across all runs. `null` when no run invoked search
 * (avoids division by zero). Values < 1 indicate agents that search but never
 * load; values > 1 indicate multi-load-per-search behaviour.
 */
searchToShowRatio: number | null;
```

### 2b. Zero envelope — `metrics.ts` in the `n === 0` early return

```ts
searchToShowRatio: null,
```

### 2c. Compute in `aggregateAkmOverhead` — after the loop

`searchSum` and `showSum` are already accumulated in the loop. After the loop,
add:

```ts
const searchToShowRatio = searchSum === 0 ? null : showSum / searchSum;
```

### 2d. Return — add to the `return` object

```ts
searchToShowRatio,
```

### 2e. Extend the serializer — `report.ts` `serialiseAkmOverheadAggregate`

```ts
// Return type:
search_to_show_ratio: number | null;

// Body:
search_to_show_ratio: agg.searchToShowRatio,
```

---

## Item 3 — `tokensPerRun` (all outcomes, both arms)

**Why:** `tokensPerPass` only averages tokens over *passing* runs. That is a
biased sample — failing runs consume tokens too, and AKM might be causing agents
to spend more tokens before failing. `tokensPerRun` gives the honest
comparison across arms.

**Files:** `tests/bench/metrics.ts`, `tests/bench/report.ts`

### 3a. `PerTaskMetrics` interface — `metrics.ts` line ~116

Add after `tokensPerPass`:

```ts
/**
 * Mean total (input + output) tokens across ALL runs (any outcome) that carry
 * a parsed token measurement. `null` when no run in the bag has a parsed
 * measurement. Unlike `tokensPerPass`, this includes failing runs so it
 * reflects the true average token cost regardless of outcome.
 */
tokensPerRun: number | null;
```

### 3b. Zero envelope in `aggregatePerTask` — `metrics.ts` line ~152

```ts
tokensPerRun: null,
```

### 3c. Accumulate in `aggregatePerTask` loop — `metrics.ts` around line ~165

Add two counters before the loop:

```ts
let totalTokensInMeasuredRuns = 0;
let measuredRuns = 0;
```

Inside the loop (after the existing `runsWithMeasuredTokens` increment):

```ts
if (isMeasured(r)) {
  measuredRuns += 1;
  totalTokensInMeasuredRuns += r.tokens.input + r.tokens.output;
}
```

Note: `isMeasured(r)` is already called above for `runsWithMeasuredTokens`;
combine the blocks rather than calling it twice.

### 3d. Return `tokensPerRun` — in the `return` object of `aggregatePerTask`

```ts
tokensPerRun: measuredRuns === 0 ? null : totalTokensInMeasuredRuns / measuredRuns,
```

### 3e. Propagate through `CorpusMetrics` and `CorpusDelta` — `metrics.ts`

`CorpusMetrics` (line ~224) carries `tokensPerPass: number | null`. Add:

```ts
tokensPerRun: number | null;
```

In `aggregateCorpus` (line ~234), compute the same way `tokensPerPass` is
computed but using `t.tokensPerRun` instead of `t.tokensPerPass`.

`CorpusDelta` (line ~256) carries `tokensPerPass: number | null`. Add:

```ts
tokensPerRun: number | null;
```

In `computeCorpusDelta` (line ~261), compute `akm.tokensPerRun - noakm.tokensPerRun`
with the same null-safety as `tokensPerPass`.

### 3f. Serialization — `report.ts`

In `report.ts`, wherever `tokens_per_pass` appears in the output shape and body,
add a parallel `tokens_per_run` field derived from `tokensPerRun`. The simplest
approach is to grep for every `tokensPerPass` reference in `report.ts` and add
`tokensPerRun` alongside it.

Key locations:
- `buildAkmOverheadBlock` return type (line ~444) — add `tokens_per_run` to per-task rows if surfaced there
- The per-task summary block (around line ~615) that renders `tokens_per_pass`
- The delta block (around line ~623) that renders `tokensPerPassDelta`

---

## Item 4 — Positive vs negative feedback polarity split

**Why:** `feedbackRecorded` (a boolean) and `feedbackCount` (a count) tell you
feedback happened, but not whether the agent signalled success or failure. An
agent that always calls `akm feedback --negative` looks identical to one that
always calls `--positive`. Splitting by polarity lets you check whether the
agent's self-assessment tracks with the verifier outcome.

**Files:** `tests/bench/metrics.ts`, `tests/bench/report.ts`

### 4a. `AkmOverheadPerRun` interface — `metrics.ts` line ~2934

Add after `feedbackCount`:

```ts
/** Count of `akm feedback --positive` invocations in this run. */
positiveFeedbackCount: number;
/** Count of `akm feedback --negative` invocations in this run. */
negativeFeedbackCount: number;
```

### 4b. `AkmOverheadAggregate` interface — `metrics.ts` line ~2973

Add after `meanFeedbackCount`:

```ts
meanPositiveFeedbackCount: number;
meanNegativeFeedbackCount: number;
```

### 4c. Accumulate in `perRun()` — `metrics.ts` line ~3048

The existing loop in `perRun()` already handles `ev.type === "akm_feedback"`.
Add two counters:

```ts
let positiveFeedbackCount = 0;
let negativeFeedbackCount = 0;
```

Change the feedback branch to:

```ts
} else if (ev.type === "akm_feedback") {
  feedbackCount += 1;
  // Polarity is carried in args as "--positive" or "--negative".
  // Events sourced from events.jsonl also have args populated by
  // normalizeRunToTrace. Absence of both flags is treated as unknown
  // (contributes to feedbackCount but not to either polarity counter).
  if (ev.args?.includes("--positive")) positiveFeedbackCount += 1;
  else if (ev.args?.includes("--negative")) negativeFeedbackCount += 1;
}
```

Add to the `return` object of `perRun()`:

```ts
positiveFeedbackCount,
negativeFeedbackCount,
```

### 4d. Zero envelope in `aggregateAkmOverhead` — `metrics.ts` line ~3142

```ts
meanPositiveFeedbackCount: 0,
meanNegativeFeedbackCount: 0,
```

### 4e. Accumulate in `aggregateAkmOverhead` loop — `metrics.ts` line ~3193

Add two sums:

```ts
let positiveFeedbackSum = 0;
let negativeFeedbackSum = 0;
```

Inside the loop:

```ts
positiveFeedbackSum += row.positiveFeedbackCount;
negativeFeedbackSum += row.negativeFeedbackCount;
```

Add to the `return` object:

```ts
meanPositiveFeedbackCount: positiveFeedbackSum / n,
meanNegativeFeedbackCount: negativeFeedbackSum / n,
```

### 4f. Extend serializers — `report.ts`

In `serialiseAkmOverheadPerRun` (line ~460), add:

```ts
// Return type:
positive_feedback_count: number;
negative_feedback_count: number;

// Body:
positive_feedback_count: row.positiveFeedbackCount,
negative_feedback_count: row.negativeFeedbackCount,
```

In `serialiseAkmOverheadAggregate` (line ~494), add:

```ts
// Return type:
mean_positive_feedback_count: number;
mean_negative_feedback_count: number;

// Body:
mean_positive_feedback_count: agg.meanPositiveFeedbackCount,
mean_negative_feedback_count: agg.meanNegativeFeedbackCount,
```

---

## Testing

After implementing all four items:

1. `bunx biome check --write tests/bench/` — fix any lint issues
2. `bunx tsc --noEmit` — must pass clean (note: tsconfig excludes tests/, so
   run `bunx tsc --noEmit -p tsconfig.json` and verify no errors bleed through)
3. `bun test tests/bench/metrics.test.ts` — unit tests for all metric functions;
   update any snapshots that change due to the new fields
4. `bun test tests/bench/` — full bench test suite; expect snapshot failures in
   `report.test.ts` for the new fields — update them, do not delete them

The new fields should appear in the JSON output of any bench run under
`akm_overhead.aggregate` (items 1, 2, 4) and under each task's `akm` /
`noakm` / `delta` block (item 3).
