// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics --format text`: aligned sections with top-N tables. Lists are
 * cut to 5 at `--detail brief` and show everything `--top` kept otherwise.
 */

import { buildMetricsView, isMetricsResult, type MetricsViewTable } from "../../commands/metrics/report-view";
import type { DetailLevel } from "../context";
import type { TextFormatterEntry } from "./registry";

const flat = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ");

function renderTable(table: MetricsViewTable): string[] {
  const all = [table.headers, ...table.rows].map((r) => r.map(flat));
  const widths = table.headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => `  ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd();
  return [`${table.title}:`, ...all.map(line)];
}

export function formatMetricsPlain(result: Record<string, unknown>, detail: DetailLevel): string | null {
  if (!isMetricsResult(result)) return null;
  const view = buildMetricsView(result, detail);
  const lines: string[] = [`akm metrics  ${view.window}`, `filters: ${view.filters}`];
  for (const section of view.sections) {
    lines.push("", section.title.toUpperCase());
    const labelWidth = Math.max(0, ...section.facts.map(([label]) => label.length));
    for (const [label, value] of section.facts) lines.push(`  ${label.padEnd(labelWidth)}  ${value}`);
    for (const table of section.tables) {
      if (table.rows.length > 0) lines.push("", ...renderTable(table));
      else if (!table.hideWhenEmpty) lines.push("", `${table.title}: (none)`);
    }
  }
  if (view.notes.length > 0) lines.push("", "NOTES", ...view.notes.map((n) => `  - ${flat(n)}`));
  return lines.join("\n");
}

export const metricsFormatters: TextFormatterEntry[] = [
  { command: "metrics", handler: (r, detail) => formatMetricsPlain(r, detail) },
];
