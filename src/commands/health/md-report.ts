// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` Markdown renderers — the `--group-by run` detail table and the
 * `--window-compare` side-by-side table. Mirrors the HTML extraction in
 * `health/html-report.ts`; the shared metric/type surface lives in `./types`.
 *
 * Pure functions: no I/O, no clock, no globals — output is a function of the
 * input rows alone, so the tables are byte-identical for identical inputs.
 */

import type { DeltaEntry, ImproveRunSummary, WindowResult } from "./types";
import { INTERESTING_DELTA_PATHS, readNumericPath } from "./windows";

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padRight(h, widths[i] ?? 0)).join("  "));
  for (const row of rows) {
    lines.push(row.map((cell, i) => padRight(cell ?? "", widths[i] ?? 0)).join("  "));
  }
  return lines.join("\n");
}

/**
 * Render `--detail per-run` rows as a TSV-ish aligned table. The column
 * shape was originally inherited from the retired
 * `scripts/improve-stats/runs-detail` bash helper; keep the same shape
 * so operator muscle memory carries over.
 *
 * Columns: ts | ok | actions | refl_ok/fail/cd/skip |
 *   distill_q/llm-fail/qrej/cfg/skip | cons_proc/promo/merge/del |
 *   mem_cons/written/skip | graph_f/e/r | orphans | lint_f/fl
 */
export function renderRunsDetailMd(runs: ImproveRunSummary[]): string {
  const headers = [
    "ts",
    "ok",
    "actions",
    "refl_ok/fail/cd/skip",
    "distill_q/llm-fail/qrej/cfg/skip",
    "cons_proc/promo/merge/del",
    "mem_cons/written/skip",
    "graph_f/e/r",
    "orphans",
    "lint_f/fl",
  ];
  const rows = runs.map((r) => {
    const totalActions =
      r.actions.reflect.ok +
      r.actions.reflect.failed +
      r.actions.reflect.cooldown +
      r.actions.reflect.skipped +
      r.actions.distill.queued +
      r.actions.distill.llmFailed +
      r.actions.distill.qualityRejected +
      r.actions.distill.configDisabled +
      r.actions.distill.skipped +
      r.actions.memoryPrune +
      r.actions.memoryInference +
      r.actions.graphExtraction +
      r.actions.error;
    return [
      r.startedAt,
      String(r.ok),
      String(totalActions),
      `${r.actions.reflect.ok}/${r.actions.reflect.failed}/${r.actions.reflect.cooldown}/${r.actions.reflect.skipped}`,
      `${r.actions.distill.queued}/${r.actions.distill.llmFailed}/${r.actions.distill.qualityRejected}/${r.actions.distill.configDisabled}/${r.actions.distill.skipped}`,
      `${r.consolidation.processed}/${r.consolidation.promoted}/${r.consolidation.merged}/${r.consolidation.deleted}`,
      `${r.memoryInference.considered}/${r.memoryInference.written}/${r.memoryInference.skippedNoFacts}`,
      `${r.graphExtraction.extractedFiles}/${r.graphExtraction.entities}/${r.graphExtraction.relations}`,
      String(r.orphansPurged),
      `${r.lintFixed}/${r.lintFlagged}`,
    ];
  });
  return renderTable(headers, rows);
}

/**
 * Render a window-compare comparison as a side-by-side metric table with a
 * delta column. Bad-direction deltas (e.g. +pct on failed counts) get a `!`
 * marker prefix.
 */
export function renderWindowCompareMd(windows: WindowResult[], deltas: Record<string, DeltaEntry> | undefined): string {
  if (windows.length === 0) return "";
  const headers = ["metric", ...windows.map((w) => w.name), "delta"];
  const badIfPositive = new Set([
    "improve.actions.reflect.failed",
    "improve.actions.distill.llmFailed",
    "improve.graphExtraction.failures",
    "improve.graphExtraction.nonArrayBatchFailures",
    "improve.wallTime.medianMs",
    "improve.wallTime.p95Ms",
    "improve.memoryInference.skippedNoFacts",
  ]);
  const rows: string[][] = [];
  for (const path of INTERESTING_DELTA_PATHS) {
    const values = windows.map((w) => String(readNumericPath(w, path)));
    const delta = deltas?.[path];
    let deltaStr = "—";
    if (delta) {
      const pct = delta.pctChange;
      const num = typeof pct === "number" ? pct : pct;
      const sign = typeof num === "number" && num > 0 ? "+" : "";
      const formatted = typeof num === "number" ? `${sign}${num}%` : String(num);
      const marker = badIfPositive.has(path) && typeof num === "number" && num > 0 ? "!" : "";
      deltaStr = marker + formatted;
    }
    rows.push([path, ...values, deltaStr]);
  }
  return renderTable(headers, rows);
}
