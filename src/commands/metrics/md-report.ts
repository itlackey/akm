// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics --format md`: one heading per section, GFM tables.
 *
 * A pure function of the result. Registered into the shared md registry as a
 * side effect of import (`src/cli.ts` imports this module, as it does
 * `health/renderers`); an unrecognized payload returns `null` and falls
 * through to the generic renderer.
 */

import type { DetailLevel } from "../../output/context";
import { registerMdRenderer } from "../../output/render-registry";
import { buildMetricsView, isMetricsResult, type MetricsViewTable } from "./report-view";

/** Escape a cell so a query or reason containing `|` or a newline cannot break the table. */
function cell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderTable(table: MetricsViewTable): string[] {
  const row = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [
    `### ${table.title}`,
    "",
    row(table.headers),
    row(table.headers.map(() => "---")),
    ...table.rows.map(row),
    "",
  ];
}

export function renderMetricsMd(result: unknown, detail: DetailLevel): string | null {
  if (!isMetricsResult(result)) return null;
  const view = buildMetricsView(result, detail);
  const lines: string[] = ["# akm metrics", "", `- **Window:** ${view.window}`, `- **Filters:** ${view.filters}`, ""];
  for (const section of view.sections) {
    lines.push(`## ${section.title}`, "");
    for (const [label, value] of section.facts) lines.push(`- **${label}:** ${value}`);
    if (section.facts.length > 0) lines.push("");
    for (const table of section.tables) {
      if (table.rows.length > 0) lines.push(...renderTable(table));
      else if (!table.hideWhenEmpty) lines.push(`### ${table.title}`, "", "_none_", "");
    }
  }
  if (view.notes.length > 0) {
    lines.push("## Notes", "", ...view.notes.map((n) => `- ${n}`), "");
  }
  return lines.join("\n").trimEnd();
}

registerMdRenderer("metrics", renderMetricsMd);
