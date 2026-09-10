// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #944 — per-run LLM usage reporting: fold the process x engine x model
 * cross-tab (`summarizeLlmUsageCrossTab`, `health/llm-usage.ts`) together with
 * the resolved process routing table (`projectResolvedProcessRouting`, #947)
 * into the `usageReport` field `finalizeImproveResult` persists, and render
 * both halves as one fixed-width table shared by the end-of-run stderr
 * summary (`improve-cli.ts`) and `akm improve report`'s text output
 * (`src/output/text/improve-report.ts`).
 */

import { IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "../../core/config/engine-semantics";
import type { DistillSkippedAggregate, ImproveActionResult, ImproveEligibleRef } from "../../core/improve-types";
import type { LlmUsageCrossTabRow } from "../health/types";
import type { AutonomyLane, GatedLane } from "./autonomy-gate";
import {
  type ImproveProcessName,
  type ProcessRoutingRow,
  projectResolvedProcessRouting,
  type ResolvedImprovePlan,
  shouldSkipRef,
} from "./improve-strategies";

/**
 * The processes this report covers — only the ones {@link IMPROVE_PROCESS_ENGINE_CAPABILITIES}
 * marks `"llm"`. `triage` ("runner" kind — its LLM cost, if any, is
 * attributed to the separate `"triage.judgment"` pseudo-row, itself excluded
 * below) and `proactiveMaintenance` (no engine at all) never make an
 * attributable LLM call, so listing them as "zero calls" would always be a
 * false positive, not a real finding.
 */
const LLM_BACKED_PROCESSES = new Set<ImproveProcessName>(
  (Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES) as ImproveProcessName[]).filter(
    (name) => IMPROVE_PROCESS_ENGINE_CAPABILITIES[name] === "llm",
  ),
);

/** Ref-scoped processes `shouldSkipRef` understands — the only ones an eligible-ref count is meaningful for. */
const REF_SCOPED_PROCESSES = new Set<ImproveProcessName>(["reflect", "distill", "consolidate"]);

/** The autonomy lane (if any) gating each LLM-backed process, per `autonomy-gate.ts`'s `AUTONOMY_LANES`. */
const AUTONOMY_LANE_BY_PROCESS: Partial<Record<ImproveProcessName, AutonomyLane>> = {
  memoryInference: "memoryInference",
};

export interface UsageReportNoCallRow {
  process: string;
  engine?: string;
  reason: string;
}

export interface ImproveUsageReport {
  byProcessEngineModel: readonly LlmUsageCrossTabRow[];
  noCalls: readonly UsageReportNoCallRow[];
}

/** `{reason -> count}` for the dominant-reason lookup in {@link deriveNoCallReason}. */
function dominantReason(counts: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [reason, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The single decision point for why an LLM-backed process made zero LLM
 * calls this run — every case `buildImproveUsageReport` needs to report,
 * decided in one place instead of split between this function and its
 * caller. Priority order: `"engine_unavailable"` (the row's engine or
 * credential could not be resolved) beats everything else, including a
 * process that also happens to be autonomy-gated; then, for a disabled row
 * that IS resolvable, `"autonomy_gated"` when its lane was gated, else
 * `undefined` (a `false`-in-config process never reached the routing table
 * in the first place, so a disabled-and-not-gated row has no other
 * explanation to report); for an enabled row, `"strategy_filtered_all_passes"`
 * when every ref got filtered out, then the process's own dominant skip
 * reason, else the `"no_signal"` fallback.
 *
 * Reuses the SAME reason strings already emitted elsewhere
 * (`improve_skipped` events, reflect's `AkmReflectFailure.reason`, distill's
 * `distillSkipped.byReason` keys) rather than inventing a translation layer —
 * per the brief, never a fabricated category like `"limit_reached"`.
 */
export function deriveNoCallReason(args: {
  row: Pick<ProcessRoutingRow, "enabled" | "unavailable"> & { process: ImproveProcessName };
  autonomyGated: readonly GatedLane[];
  strategyFilteredRefsCount: number;
  /** Refs this process would act on post strategy-filter (reflect/distill/consolidate only). */
  eligibleRefs?: number;
  /** Per-reason skip counts for this process (reflect: cooldown/skip reasons; distill: `distillSkipped.byReason`). */
  skipReasonCounts?: Record<string, number>;
}): string | undefined {
  const { row } = args;
  if (row.unavailable) return "engine_unavailable";
  const lane = AUTONOMY_LANE_BY_PROCESS[row.process];
  const laneGated = lane !== undefined && args.autonomyGated.some((gated) => gated.lane === lane);
  if (!row.enabled) return laneGated ? "autonomy_gated" : undefined;
  if (args.eligibleRefs === 0 && args.strategyFilteredRefsCount > 0) return "strategy_filtered_all_passes";
  const dominant = args.skipReasonCounts ? dominantReason(args.skipReasonCounts) : undefined;
  if (dominant) return dominant;
  return "no_signal";
}

/** Reflect's per-ref skip reason, read off `AkmReflectFailure.reason` for both cooldown and skipped actions. */
function countReflectSkipReasons(actions: readonly ImproveActionResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    if (action.mode !== "reflect-cooldown" && action.mode !== "reflect-skipped") continue;
    const result = action.result as { reason?: unknown } | undefined;
    const reason = typeof result?.reason === "string" && result.reason.trim() ? result.reason : "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * Assemble this run's `usageReport` (#944): the process x engine x model
 * cross-tab plus which enabled processes made zero calls and why. Pure — no
 * I/O; the caller (`finalizeImproveResult`) supplies the cross-tab (already
 * computed from this run's `llm_usage` events) and every other input from
 * data it already has in scope.
 *
 * Returns `undefined` when both halves would be empty (e.g. a run whose
 * active strategy enables no LLM-backed process), matching the envelope's
 * existing convention of omitting empty optional sections.
 */
export function buildImproveUsageReport(args: {
  resolvedPlan: ResolvedImprovePlan;
  byProcessEngineModel: readonly LlmUsageCrossTabRow[];
  strategyFilteredRefsCount: number;
  loopRefs: readonly ImproveEligibleRef[];
  persistedActions: readonly ImproveActionResult[];
  distillSkippedAggregate?: DistillSkippedAggregate;
}): ImproveUsageReport | undefined {
  // Only the LLM-backed processes (see LLM_BACKED_PROCESSES) — this also
  // drops the "triage.judgment" pseudo-row (#947): judgment dispatch does
  // not route through `withLlmStage`, so its calls (if any) are never
  // attributable to a "triage.judgment" process in the cross-tab, and
  // reporting it here would always read as a false "zero calls".
  const routing = projectResolvedProcessRouting(args.resolvedPlan).filter(
    (row): row is typeof row & { process: ImproveProcessName } =>
      row.process !== "triage.judgment" && LLM_BACKED_PROCESSES.has(row.process as ImproveProcessName),
  );
  const calledProcesses = new Set(args.byProcessEngineModel.filter((row) => row.calls > 0).map((row) => row.process));
  const reflectSkipCounts = countReflectSkipReasons(args.persistedActions);

  const noCalls: UsageReportNoCallRow[] = [];
  for (const row of routing) {
    if (calledProcesses.has(row.process)) continue;
    const eligibleRefs = REF_SCOPED_PROCESSES.has(row.process)
      ? args.loopRefs.filter(
          (entry) =>
            !shouldSkipRef(
              entry.ref,
              row.process as "reflect" | "distill" | "consolidate",
              args.resolvedPlan.strategy.config,
            ).skip,
        ).length
      : undefined;
    const reason = deriveNoCallReason({
      row,
      autonomyGated: args.resolvedPlan.autonomyGated,
      strategyFilteredRefsCount: args.strategyFilteredRefsCount,
      eligibleRefs,
      skipReasonCounts:
        row.process === "reflect"
          ? reflectSkipCounts
          : row.process === "distill"
            ? args.distillSkippedAggregate?.byReason
            : undefined,
    });
    if (reason === undefined) continue;
    noCalls.push({ process: row.process, ...(row.engine ? { engine: row.engine } : {}), reason });
  }

  if (args.byProcessEngineModel.length === 0 && noCalls.length === 0) return undefined;
  return { byProcessEngineModel: args.byProcessEngineModel, noCalls };
}

// ── Shared fixed-width text rendering ────────────────────────────────────────

function renderFixedWidthTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

/**
 * Render a `usageReport` as fixed-width plain text — the ONE formatter shared
 * by the end-of-run `[improve] ...` stderr table (`improve-cli.ts`) and `akm
 * improve report`'s `--format text` output
 * (`src/output/text/improve-report.ts`), per the brief. `notes` surfaces
 * degraded-precision caveats (e.g. a pre-0.9.15 run recomputed from raw
 * events, per `improve-report.ts`).
 */
export function formatUsageReportTable(usageReport: ImproveUsageReport, notes?: readonly string[]): string {
  const lines: string[] = ["[improve] usage report (process x engine x model):"];
  if (usageReport.byProcessEngineModel.length === 0) {
    lines.push("  (no LLM calls recorded)");
  } else {
    const headers = ["process", "engine", "model", "calls", "failures", "promptTok", "complTok", "totalTok", "ms"];
    const rows = usageReport.byProcessEngineModel.map((row) => [
      row.process,
      row.engine,
      row.model,
      String(row.calls),
      String(row.failures),
      String(row.promptTokens),
      String(row.completionTokens),
      String(row.totalTokens),
      String(row.totalDurationMs),
    ]);
    for (const line of renderFixedWidthTable(headers, rows)) lines.push(`  ${line}`);
  }
  if (usageReport.noCalls.length > 0) {
    lines.push("[improve] enabled processes with zero calls:");
    const headers = ["process", "engine", "reason"];
    const rows = usageReport.noCalls.map((row) => [row.process, row.engine ?? "-", row.reason]);
    for (const line of renderFixedWidthTable(headers, rows)) lines.push(`  ${line}`);
  }
  for (const note of notes ?? []) lines.push(`  note: ${note}`);
  return lines.join("\n");
}
