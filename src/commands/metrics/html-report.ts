// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics --format html` — the self-contained dashboard
 * (docs/plans/metrics-command.md §5).
 *
 * The page carries the window's data in a JSON island
 * (`<script type="application/json" id="akm-data">`) and renders every panel
 * client-side from it, so the viewer's filters re-aggregate without re-running
 * the command. The template is `src/assets/templates/html/metrics.html`.
 *
 * Determinism: nothing here reads the clock. `%%GENERATED_AT%%` is
 * `window.until`, so identical input gives byte-identical output.
 */

import { escapeHtml, isoTimeTag, renderHtml, resolveTemplatePath } from "../../output/html-render";
import { pkgVersion } from "../../version";
import { buildEchartsTag } from "../health/html-report";
import { isMetricsResult } from "./report-view";
import type { AkmMetricsResult, MetricsLlmRow, MetricsUsageRow } from "./types";

const esc = escapeHtml;

/** Most `rows.usage` entries the page carries; older rows are dropped with a note. */
export const MAX_HTML_USAGE_ROWS = 50_000;

/** A per-hit usage row as the page receives it: `query` is an index into `rows.queries`. */
type PageUsageRow = Omit<MetricsUsageRow, "query"> & { query?: string; q?: number };

type PageData = Omit<AkmMetricsResult, "rows"> & {
  rows: { usage: PageUsageRow[]; llm: MetricsLlmRow[]; queries: string[] };
};

/**
 * The result as the page receives it: `rows` always present (empty when the
 * caller left them out), usage rows cut to the most recent
 * {@link MAX_HTML_USAGE_ROWS}, and the query text of per-hit rows (those with a
 * ref) moved into one `rows.queries` table so a query that surfaced many assets
 * is written once; the page puts it back on load. Never mutates the input.
 */
function toPageData(result: AkmMetricsResult): PageData {
  const notes = [...result.notes];
  let usage: MetricsUsageRow[] = result.rows?.usage ?? [];
  if (usage.length > MAX_HTML_USAGE_ROWS) {
    // ISO timestamps sort lexically; id breaks ties so the cut is stable.
    usage = [...usage].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id)).slice(-MAX_HTML_USAGE_ROWS);
    notes.push(
      `The dashboard shows the most recent ${MAX_HTML_USAGE_ROWS} usage rows of this window; older rows were left out of the page (totals in the JSON output are complete).`,
    );
  }
  const queries: string[] = [];
  const queryIndex = new Map<string, number>();
  const pageUsage = usage.map((row): PageUsageRow => {
    if (row.ref === undefined || row.query === undefined) return row;
    const { query, ...rest } = row;
    let q = queryIndex.get(query);
    if (q === undefined) {
      q = queries.length;
      queries.push(query);
      queryIndex.set(query, q);
    }
    return { ...rest, q };
  });
  return { ...result, notes, rows: { usage: pageUsage, llm: result.rows?.llm ?? [], queries } };
}

/**
 * Serialize for an inline `<script type="application/json">`. Escaping `<` is
 * enough: it stops `</script>` and `<!--` in a query or reason from ending the
 * island, and `JSON.parse` turns `<` back into `<`.
 */
function islandJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildMetricsHtmlReplacements(result: AkmMetricsResult): Record<string, string> {
  const { filters, window: win } = result;
  return {
    "%%ECHARTS_TAG%%": buildEchartsTag(),
    "%%REPORT_TITLE%%": "akm metrics",
    "%%WINDOW_HTML%%": `${isoTimeTag(win.since)} &rarr; ${isoTimeTag(win.until)}`,
    "%%FILTERS_HTML%%": `source: ${esc(filters.source)}`,
    "%%GENERATED_AT%%": esc(win.until),
    "%%AKM_VERSION%%": esc(pkgVersion),
    "%%DATA_JSON%%": islandJson(toPageData(result)),
  };
}

/**
 * `--format html` renderer for `akm metrics`, called directly from
 * `cli/shared.ts`. Returns `null` for a payload that is not a metrics result so
 * the generic renderer takes over.
 */
export function renderMetricsHtml(result: unknown): string | null {
  if (!isMetricsResult(result)) return null;
  return renderHtml(resolveTemplatePath("metrics"), buildMetricsHtmlReplacements(result));
}
