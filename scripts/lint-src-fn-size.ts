// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repo-wide function-size ratchet for `src/**` (0.9.0 gate hardening).
 *
 * Same measurement as the chunk-7 improve gate (shared `fn-size-core.ts`),
 * different semantics: this is a SHRINK-TOLERANT ratchet, not the improve
 * gate's absolute-empty assertion and not its exact-equality worklist.
 *
 *   - A function NOT in {@link SRC_FN_SIZE_BASELINE} that exceeds
 *     {@link SRC_FN_SIZE_BAR} fails (no new god functions anywhere in src/).
 *   - A baselined function that GROWS past its recorded size fails
 *     (no re-fattening the existing offenders).
 *   - A baselined function that shrinks or drops below the bar passes
 *     SILENTLY — no baseline edit required. This deliberately differs from
 *     the improve ratchet's exact-equality rule so in-flight refactor chunks
 *     (6, 9, Wave 2) never go red for making things better; the baseline is
 *     re-trimmed opportunistically, not compulsorily.
 *
 * `src/commands/improve/**` is EXCLUDED here — it is owned by the stricter
 * absolute gate in `scripts/lint-improve-fn-size.ts` (chunk-7 DoD 5), and
 * double-gating it would force every improve change to satisfy two baselines.
 *
 * Enforced by `tests/architecture/src-fn-size-ratchet.test.ts` (runs in the
 * unit suite, so every chunk Finalize `bun run check` carries it). Plan
 * anchor: §11 Chunk 9 (health/tasks god decomposition) and the Wave-2 chunks
 * mint NEW code — this ratchet is what holds the 220-line bar for them.
 */

import path from "node:path";
import { type FnOffender, measureFnOffenders, REPO_ROOT } from "./fn-size-core";

/** Same inclusive-line-span ceiling as the improve gate. */
export const SRC_FN_SIZE_BAR = 220;

/** Owned by the absolute improve gate; never double-gated here. */
export const SRC_FN_SIZE_EXCLUDE = ["src/commands/improve/"] as const;

export type SrcFnOffender = FnOffender;

/**
 * SHRINK-ONLY baseline, measured at the chunk-7 completion HEAD (43d6f10).
 * Entries may be removed or lowered when a function is decomposed; they must
 * NEVER be added to or raised. Several are already scheduled for deletion or
 * decomposition by the plan (html-report → residual audit; graph-extraction →
 * 0.9.1 measurement pass; health/tasks gods → Chunk 9; run-workflow → engine
 * sweep) — the ratchet just keeps the list from growing while they wait their
 * turn. Chunk 8 (WI-8.6, §10.7) decomposed `report.ts`'s 438-line
 * `reportWorkflowUnitWithBarrier` into its five named phases, dropping its entry.
 */
export const SRC_FN_SIZE_BASELINE: readonly SrcFnOffender[] = [
  { id: "src/indexer/graph/graph-extraction.ts :: runGraphExtractionPass", lines: 458 },
  { id: "src/storage/repositories/index-schema.ts :: ensureSchema", lines: 348 },
  { id: "src/workflows/exec/run-workflow.ts :: driveRun", lines: 327 },
  { id: "src/integrations/agent/spawn.ts :: runAgent", lines: 298 },
  { id: "src/commands/mv-cli.ts :: run", lines: 294 },
  { id: "src/workflows/exec/brief.ts :: buildWorkflowBrief", lines: 289 },
  { id: "src/commands/mv-cli.ts :: withAssetMutationLease#arg1", lines: 282 },
  { id: "src/indexer/search/db-search.ts :: searchDatabase", lines: 281 },
  { id: "src/indexer/passes/memory-inference.ts :: runMemoryInferencePass", lines: 255 },
  { id: "src/integrations/harnesses/opencode-sdk/sdk-runner.ts :: runOpencodeSdk", lines: 245 },
  { id: "src/llm/graph-extract.ts :: extractGraphFromBodies", lines: 236 },
  { id: "src/commands/sources/self-update.ts :: performUpgrade", lines: 232 },
  { id: "src/commands/proposal/propose.ts :: akmPropose", lines: 231 },
  { id: "src/commands/read/search.ts :: akmSearch", lines: 228 },
];

/** Scan `src/**` (minus the improve exclusion) for over-bar functions. */
export function measureSrcFnOffenders(): SrcFnOffender[] {
  return measureFnOffenders(path.join(REPO_ROOT, "src"), SRC_FN_SIZE_BAR, SRC_FN_SIZE_EXCLUDE);
}

/** A violation of the shrink-tolerant ratchet: new offender or grown offender. */
export interface SrcFnSizeViolation {
  id: string;
  lines: number;
  kind: "new" | "grew";
  baselineLines?: number;
}

/**
 * Ratchet check: returns the violations (empty array = green). Shrinkage and
 * disappearance are allowed silently by design.
 */
export function checkSrcFnSizeRatchet(live: readonly SrcFnOffender[] = measureSrcFnOffenders()): SrcFnSizeViolation[] {
  const baseById = new Map(SRC_FN_SIZE_BASELINE.map((o) => [o.id, o.lines]));
  const violations: SrcFnSizeViolation[] = [];
  for (const o of live) {
    const base = baseById.get(o.id);
    if (base === undefined) violations.push({ id: o.id, lines: o.lines, kind: "new" });
    else if (o.lines > base) violations.push({ id: o.id, lines: o.lines, kind: "grew", baselineLines: base });
  }
  return violations;
}
