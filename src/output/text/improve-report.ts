// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #944 — `akm improve report --format text`. Renders the SAME fixed-width
 * table `formatUsageReportTable` produces for the end-of-run stderr summary
 * (`improve-cli.ts`), prefixed with which run(s) it covers.
 */

import { formatUsageReportTable, type ImproveUsageReport } from "../../commands/improve/improve-usage-report";
import type { TextFormatterEntry } from "./registry";

function formatImproveReportPlain(result: Record<string, unknown>): string | null {
  const usageReport = result.usageReport as ImproveUsageReport | undefined;
  if (!usageReport) return null;
  const lines: string[] = [];
  if (result.mode === "since") {
    const runIds = Array.isArray(result.runIds) ? (result.runIds as string[]) : [];
    lines.push(
      `[improve] report since ${String(result.since ?? "?")} (${runIds.length} run${runIds.length === 1 ? "" : "s"})`,
    );
  } else {
    lines.push(
      `[improve] report for run ${String(result.runId ?? "?")}${result.strategy ? ` (strategy: ${result.strategy})` : ""}`,
    );
  }
  lines.push(formatUsageReportTable(usageReport, result.notes as string[] | undefined));
  return lines.join("\n");
}

export const improveReportFormatters: TextFormatterEntry[] = [
  { command: "improve-report", handler: (r) => formatImproveReportPlain(r) },
];
