/**
 * akm-bench metrics (spec §6).
 *
 * #236 ships only `computeOutcomeAggregate`; the §6.1-6.8 catalog (trajectory,
 * proposal-quality, longitudinal, attribution, failure-mode taxonomy, search-
 * pipeline bridge, feedback-signal integrity) lands in #238 and beyond. The
 * single function here is what `bench utility`'s unit test exercises so the
 * CLI dispatcher has something concrete to call.
 */

import type { RunResult } from "./driver";

export interface OutcomeAggregate {
  /** Fraction of runs whose outcome is `pass`. Zero when results is empty. */
  passRate: number;
  /**
   * Mean total tokens across runs that passed; `0` when there are no passes
   * (avoids `Infinity` and `NaN` polluting downstream JSON).
   */
  tokensPerPass: number;
  /** Mean wallclock ms across all runs (not just passes). */
  wallclockMs: number;
  /** Number of runs whose outcome is `budget_exceeded`. */
  budgetExceeded: number;
}

/**
 * Aggregate outcome metrics over a flat list of RunResults.
 *
 * Aggregations across multiple arms are the caller's responsibility — pass
 * each arm's slice in separately. This helper deliberately stays a single
 * pure function so the v1 contract is "what does a single bag of runs look
 * like in summary." Anything richer is post-#236.
 */
export function computeOutcomeAggregate(results: RunResult[]): OutcomeAggregate {
  if (results.length === 0) {
    return { passRate: 0, tokensPerPass: 0, wallclockMs: 0, budgetExceeded: 0 };
  }
  let passes = 0;
  let budgetExceeded = 0;
  let totalTokensInPasses = 0;
  let totalWallclock = 0;
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    if (r.outcome === "pass") {
      passes += 1;
      totalTokensInPasses += r.tokens.input + r.tokens.output;
    } else if (r.outcome === "budget_exceeded") {
      budgetExceeded += 1;
    }
  }
  return {
    passRate: passes / results.length,
    tokensPerPass: passes === 0 ? 0 : totalTokensInPasses / passes,
    wallclockMs: totalWallclock / results.length,
    budgetExceeded,
  };
}
