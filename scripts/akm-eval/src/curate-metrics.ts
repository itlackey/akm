/**
 * Re-export shim — the canonical module is the sibling `rank-metrics.ts`
 * (chunk-9 WI-9.4e, anchors C.3: relocated from `src/core/eval/rank-metrics.ts`,
 * which had zero `src/` importers, verbatim into this package). Bench + test
 * imports through this path keep working.
 */

export * from "./rank-metrics";
