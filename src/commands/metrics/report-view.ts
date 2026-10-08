// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Format-neutral view of an `AkmMetricsResult` for the `text` and `md`
 * renderers (`src/output/text/metrics.ts`, `./md-report.ts`).
 *
 * Both renderers print the same sections; only the serialization differs
 * (aligned columns vs GFM tables). Building the sections once keeps the two
 * formats from drifting. Pure: no I/O, no clock, so identical input renders
 * byte-identical output.
 */

import type { DetailLevel } from "../../output/context";
import type { AkmMetricsResult } from "./types";

/** Lists are cut to this many rows at `--detail brief`; `normal`/`full` show what `--top` already capped. */
export const BRIEF_LIST_LIMIT = 5;

export interface MetricsViewTable {
  title: string;
  headers: string[];
  rows: string[][];
  /** Omit the table entirely when it has no rows (otherwise it renders `(none)`). */
  hideWhenEmpty?: boolean;
}

export interface MetricsViewSection {
  title: string;
  facts: Array<[label: string, value: string]>;
  tables: MetricsViewTable[];
}

export interface MetricsView {
  window: string;
  filters: string;
  sections: MetricsViewSection[];
  notes: string[];
}

/** Narrow an unknown envelope to an `AkmMetricsResult`; renderers return `null` (generic fallback) otherwise. */
export function isMetricsResult(value: unknown): value is AkmMetricsResult {
  if (value === null || typeof value !== "object") return false;
  const r = value as Partial<AkmMetricsResult>;
  return r.schemaVersion === 1 && !!r.window && !!r.usage && !!r.feedback && !!r.llm;
}

const int = (n: number): string => String(n);
const dash = (v: string | undefined): string => (v === undefined || v === "" ? "-" : v);
/** A fraction as a percentage; `null` (zero denominator) is `n/a`, never `NaN`. */
const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const ms = (n: number | null): string => (n === null ? "n/a" : `${Math.round(n)} ms`);
const fixed = (n: number | null, digits: number): string => (n === null ? "n/a" : n.toFixed(digits));

function sourceFacts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "-" : entries.map(([k, v]) => `${k}=${v}`).join(" ");
}

function llmRows(group: Record<string, AkmMetricsResult["llm"]["byEngine"][string]>): string[][] {
  return Object.entries(group).map(([name, a]) => [
    name,
    int(a.calls),
    int(a.failures),
    int(a.promptTokens),
    int(a.completionTokens),
    int(a.totalTokens),
    ms(a.totalDurationMs),
  ]);
}

const LLM_HEADERS = ["name", "calls", "failed", "prompt", "completion", "total", "time"];

export function buildMetricsView(r: AkmMetricsResult, detail: DetailLevel): MetricsView {
  const brief = detail === "brief";
  const cut = <T>(items: T[]): T[] => (brief ? items.slice(0, BRIEF_LIST_LIMIT) : items);
  const { usage, feedback, utility, llm } = r;
  const searches = usage.totals.searches;

  const sections: MetricsViewSection[] = [
    {
      title: "Usage",
      facts: [
        ["searches", int(searches)],
        ["shows", int(usage.totals.shows)],
        ["curates", int(usage.totals.curates)],
        ["selects", int(usage.totals.selects)],
        ["select rate", pct(usage.selectRate)],
        [
          "zero-result searches",
          `${usage.totals.zeroResultSearches} (${pct(searches === 0 ? null : usage.totals.zeroResultSearches / searches)})`,
        ],
        ["search median", ms(usage.searchMedianMs)],
        ["distinct assets", int(usage.totals.distinctAssets)],
        ["distinct queries", int(usage.totals.distinctQueries)],
        ["by source", sourceFacts(usage.bySource)],
      ],
      tables: [
        {
          title: "Top assets",
          headers: ["ref", "shows", "search hits", "selects", "+", "-", "last used"],
          rows: cut(usage.topAssets).map((a) => [
            a.ref,
            int(a.shows),
            int(a.searchHits),
            int(a.selects),
            int(a.positive),
            int(a.negative),
            dash(a.lastUsedAt),
          ]),
        },
        {
          title: "Top queries",
          headers: ["query", "count", "avg results", "last"],
          rows: cut(usage.topQueries).map((q) => [q.query, int(q.count), fixed(q.avgResults, 1), q.lastAt]),
        },
        {
          title: "Zero-result queries",
          headers: ["query", "count", "last"],
          rows: cut(usage.zeroResultQueries).map((q) => [q.query, int(q.count), q.lastAt]),
        },
        {
          title: "Daily",
          headers: ["day", "search", "show", "curate", "feedback"],
          rows: brief
            ? []
            : usage.daily.map((d) => [d.day, int(d.search), int(d.show), int(d.curate), int(d.feedback)]),
          hideWhenEmpty: true,
        },
      ],
    },
    {
      title: "Feedback",
      facts: [
        ["positive", int(feedback.totals.positive)],
        ["negative", int(feedback.totals.negative)],
      ],
      tables: [
        {
          title: "By asset",
          headers: ["ref", "+", "-", "valence", "last"],
          rows: cut(feedback.byAsset).map((a) => [
            a.ref,
            int(a.positive),
            int(a.negative),
            fixed(a.valence, 2),
            a.lastAt,
          ]),
        },
        {
          title: "By tag",
          headers: ["tag", "+", "-"],
          rows: cut(Object.entries(feedback.byTag)).map(([tag, c]) => [tag, int(c.positive), int(c.negative)]),
          hideWhenEmpty: true,
        },
        {
          title: "Recent negative",
          headers: ["ref", "at", "reason", "tags"],
          rows: cut(feedback.recentNegative).map((n) => [n.ref, n.at, dash(n.reason), dash(n.tags?.join(", "))]),
        },
      ],
    },
    {
      title: "Utility",
      facts: [
        ["scored assets", int(utility.count)],
        ["never used", int(utility.neverUsed)],
      ],
      tables: [
        {
          title: "Histogram",
          headers: ["bucket", "count"],
          rows: utility.histogram.map((h) => [h.bucket, int(h.count)]),
          hideWhenEmpty: true,
        },
        { title: "Lowest", headers: utilityHeaders(), rows: cut(utility.lowest).map(utilityRow) },
        { title: "Highest", headers: utilityHeaders(), rows: cut(utility.highest).map(utilityRow) },
        {
          title: "Lowest outcome",
          headers: ["ref", "outcome", "retrievals", "negative", "accepted changes"],
          rows: cut(r.outcomes.lowestOutcome).map((o) => [
            o.ref,
            fixed(o.outcomeScore, 2),
            int(o.retrievalCount),
            int(o.negativeFeedbackCount),
            int(o.acceptedChangeCount),
          ]),
          hideWhenEmpty: true,
        },
      ],
    },
    {
      title: "LLM",
      facts: [
        ["calls", int(llm.calls)],
        ["failed", int(llm.failures)],
        ["prompt tokens", int(llm.promptTokens)],
        ["completion tokens", int(llm.completionTokens)],
        ["reasoning tokens", int(llm.reasoningTokens)],
        ["total tokens", int(llm.totalTokens)],
        ["time", ms(llm.totalDurationMs)],
      ],
      tables: [
        { title: "By engine", headers: LLM_HEADERS, rows: cut(llmRows(llm.byEngine)), hideWhenEmpty: true },
        { title: "By process", headers: LLM_HEADERS, rows: cut(llmRows(llm.byProcess)), hideWhenEmpty: true },
        { title: "By stage", headers: LLM_HEADERS, rows: cut(llmRows(llm.byStage)), hideWhenEmpty: true },
      ],
    },
    {
      title: "Index",
      facts: [
        ["runs", int(r.index.runs)],
        ["median time", ms(r.index.medianMs)],
      ],
      tables: [
        {
          title: "Recent runs",
          headers: ["at", "mode", "time"],
          rows: brief ? [] : r.index.recent.map((i) => [i.at, i.mode, ms(i.totalMs)]),
          hideWhenEmpty: true,
        },
      ],
    },
    {
      title: "Tasks",
      facts: [
        ["runs", int(r.tasks.runs)],
        ["failed", int(r.tasks.failed)],
        ["fail rate", pct(r.tasks.failRate)],
      ],
      tables: [
        {
          title: "By task",
          headers: ["task", "runs", "failed", "median"],
          rows: cut(r.tasks.byTask).map((t) => [t.taskId, int(t.runs), int(t.failed), ms(t.medianMs)]),
          hideWhenEmpty: true,
        },
      ],
    },
    {
      title: "Proposals",
      facts: [["by status", sourceFacts(r.proposals.byStatus)]],
      tables: [
        {
          title: "Accept rate by source",
          headers: ["source", "total", "accepted", "rejected", "pending", "accept rate"],
          rows: r.proposals.acceptRateBySource.map((p) => [
            p.source,
            int(p.total),
            int(p.accepted),
            int(p.rejected),
            int(p.pending),
            pct(p.acceptRate),
          ]),
          hideWhenEmpty: true,
        },
      ],
    },
    {
      title: "Workflows",
      facts: [
        ["runs", int(r.workflows.runs)],
        ["by status", sourceFacts(r.workflows.byStatus)],
        ["tokens", int(r.workflows.tokens)],
        ["tokens by model", sourceFacts(r.workflows.byModel)],
      ],
      tables: [],
    },
  ];

  const f = r.filters;
  return {
    window: `${r.window.since} to ${r.window.until}`,
    filters: `source=${f.source} bundles=${f.bundles.length > 0 ? f.bundles.join(",") : "all"} ref=${f.ref ?? "-"}`,
    sections,
    notes: r.notes,
  };
}

function utilityHeaders(): string[] {
  return ["ref", "utility", "shows", "searches", "select rate", "last used"];
}

function utilityRow(u: AkmMetricsResult["utility"]["lowest"][number]): string[] {
  return [u.ref, fixed(u.utility, 2), int(u.showCount), int(u.searchCount), pct(u.selectRate), dash(u.lastUsedAt)];
}
