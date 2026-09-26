// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The per-run LLM usage report (#944): the process × engine × model cross-tab
 * plus the enabled processes that made no call and why, rendered as one table
 * for the end-of-run stderr summary and `akm improve report`.
 */

import { IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "../../core/config/engine-semantics";
import type { DistillSkippedAggregate, ImproveActionResult, ImproveEligibleRef } from "../../core/improve-types";
import type { LlmUsageCrossTabRow } from "../health/types";
import type { AutonomyLane, GatedLane } from "./autonomy-gate";
import {
  eligibleRefCount,
  type ImproveProcessName,
  type ProcessRoutingRow,
  projectResolvedProcessRouting,
  type ResolvedImprovePlan,
} from "./improve-strategies";

/**
 * Only processes that call an LLM themselves: triage (a runner, attributed to
 * its judgment engine) and proactive maintenance (no engine) would always read
 * as "zero calls".
 */
const LLM_BACKED_PROCESSES = new Set<ImproveProcessName>(
  (Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES) as ImproveProcessName[]).filter(
    (name) => IMPROVE_PROCESS_ENGINE_CAPABILITIES[name] === "llm",
  ),
);

/** The autonomy lane gating each LLM-backed process, if any. */
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
 * Why an LLM-backed process made no call, in priority order: its engine is
 * unavailable; disabled — `autonomy_gated` when its lane was gated, else
 * nothing to report; every ref strategy-filtered; its dominant skip reason;
 * else `no_signal`. The reasons are the ones the events and results already
 * use.
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

/** Reflect's skip reasons, from its skipped (and older cooldown) actions. */
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

/** This run's `usageReport`, or `undefined` when both halves are empty. */
export function buildImproveUsageReport(args: {
  resolvedPlan: ResolvedImprovePlan;
  byProcessEngineModel: readonly LlmUsageCrossTabRow[];
  strategyFilteredRefsCount: number;
  loopRefs: readonly ImproveEligibleRef[];
  persistedActions: readonly ImproveActionResult[];
  distillSkippedAggregate?: DistillSkippedAggregate;
}): ImproveUsageReport | undefined {
  // The "triage.judgment" row is dropped too: its calls are never attributed to it (#947).
  const routing = projectResolvedProcessRouting(args.resolvedPlan).filter(
    (row): row is typeof row & { process: ImproveProcessName } =>
      row.process !== "triage.judgment" && LLM_BACKED_PROCESSES.has(row.process as ImproveProcessName),
  );
  const calledProcesses = new Set(args.byProcessEngineModel.filter((row) => row.calls > 0).map((row) => row.process));
  const reflectSkipCounts = countReflectSkipReasons(args.persistedActions);

  const noCalls: UsageReportNoCallRow[] = [];
  for (const row of routing) {
    if (calledProcesses.has(row.process)) continue;
    const eligibleRefs = eligibleRefCount(args.loopRefs, row.process, args.resolvedPlan.strategy.config);
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

function renderFixedWidthTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)];
}

/** The usage report as a fixed-width table; `notes` carry precision caveats (e.g. an older run recomputed from events). */
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
