/**
 * Re-export shim — the canonical module moved to `src/core/eval/rank-metrics.ts`
 * (R5: the collapse/churn detector shares these metrics; src/ must not import
 * from scripts/). Bench + test imports through this path keep working.
 */

export * from "../../../src/core/eval/rank-metrics";
