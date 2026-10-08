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

import { escapeHtml, renderHtml, resolveTemplatePath } from "../../output/html-render";
import { pkgVersion } from "../../version";
import { buildEchartsTag } from "../health/html-report";
import type { AkmMetricsResult, MetricsUsageRow } from "./types";

const esc = escapeHtml;

/** Most `rows.usage` entries the page carries; older rows are dropped with a note. */
export const MAX_HTML_USAGE_ROWS = 50_000;

function isMetricsResult(value: unknown): value is AkmMetricsResult {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<AkmMetricsResult>;
  return v.schemaVersion === 1 && typeof v.window === "object" && v.window !== null && typeof v.usage === "object";
}

function isoTimeTag(iso: string): string {
  return `<time data-iso="${esc(iso)}">${esc(iso.slice(0, 16).replace("T", " "))}</time>`;
}

/**
 * The result as the page receives it: `rows` always present (empty when the
 * caller left them out), usage rows cut to the most recent
 * {@link MAX_HTML_USAGE_ROWS}. Never mutates the input.
 */
function toPageData(result: AkmMetricsResult): AkmMetricsResult & { rows: NonNullable<AkmMetricsResult["rows"]> } {
  const notes = [...result.notes];
  let usage: MetricsUsageRow[] = result.rows?.usage ?? [];
  if (usage.length > MAX_HTML_USAGE_ROWS) {
    // ISO timestamps sort lexically; id breaks ties so the cut is stable.
    usage = [...usage].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id)).slice(-MAX_HTML_USAGE_ROWS);
    notes.push(
      `The dashboard shows the most recent ${MAX_HTML_USAGE_ROWS} usage rows of this window; older rows were left out of the page (totals in the JSON output are complete).`,
    );
  }
  return { ...result, notes, rows: { usage, llm: result.rows?.llm ?? [] } };
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
  const filterParts = [
    `source: ${esc(filters.source)}`,
    `bundles: ${filters.bundles.length > 0 ? esc(filters.bundles.join(", ")) : "all"}`,
    ...(filters.ref ? [`ref: ${esc(filters.ref)}`] : []),
  ];
  return {
    "%%ECHARTS_TAG%%": buildEchartsTag(),
    "%%REPORT_TITLE%%": "akm metrics",
    "%%WINDOW_HTML%%": `${isoTimeTag(win.since)} &rarr; ${isoTimeTag(win.until)}`,
    "%%FILTERS_HTML%%": filterParts.join(" &middot; "),
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
