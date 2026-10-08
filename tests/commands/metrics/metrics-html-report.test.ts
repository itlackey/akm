// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Pure rendering: renders a fixture AkmMetricsResult through the real template
// file. No database, network or process involved (AGENTS.md classification rule).

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { output } from "../../../src/cli/shared";
import { buildEchartsTag } from "../../../src/commands/health/html-report";
import {
  buildMetricsHtmlReplacements,
  MAX_HTML_USAGE_ROWS,
  renderMetricsHtml,
} from "../../../src/commands/metrics/html-report";
import type { AkmMetricsResult, MetricsUsageRow } from "../../../src/commands/metrics/types";
import { initOutputMode, resetOutputMode } from "../../../src/output/context";
import { renderHtml, resolveTemplatePath } from "../../../src/output/html-render";
import { deregisterOutputShape, registerOutputShape } from "../../../src/output/shapes/registry";

function fixture(overrides: Partial<AkmMetricsResult> = {}): AkmMetricsResult {
  const usage: MetricsUsageRow[] = [
    { id: 1, at: "2026-10-01T09:00:00.000Z", eventType: "search", query: "vpn setup", source: "user", resultCount: 2 },
    {
      id: 2,
      at: "2026-10-01T09:00:00.000Z",
      eventType: "search",
      query: "vpn setup",
      ref: "main//memories/vpn-note",
      source: "user",
    },
    { id: 3, at: "2026-10-01T09:01:00.000Z", eventType: "show", ref: "main//memories/vpn-note", source: "user" },
    {
      id: 4,
      at: "2026-10-02T10:00:00.000Z",
      eventType: "search",
      query: "nothing here",
      source: "user",
      resultCount: 0,
    },
    {
      id: 5,
      at: "2026-10-02T11:00:00.000Z",
      eventType: "feedback",
      ref: "main//skills/code-review",
      signal: "negative",
      source: "user",
      reason: "stale",
      tags: ["outdated"],
    },
    {
      id: 6,
      at: "2026-10-03T11:00:00.000Z",
      eventType: "feedback",
      ref: "main//skills/code-review",
      signal: "positive",
      source: "improve",
    },
    { id: 7, at: "2026-10-03T12:00:00.000Z", eventType: "show", ref: "other//knowledge/api-guide", source: "user" },
  ];
  return {
    schemaVersion: 1,
    window: { since: "2026-09-08T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" },
    filters: { source: "user", bundles: [] },
    usage: {
      totals: {
        searches: 2,
        shows: 2,
        curates: 0,
        selects: 1,
        zeroResultSearches: 1,
        distinctAssets: 2,
        distinctQueries: 2,
      },
      selectRate: 0.5,
      searchMedianMs: 42,
      daily: [{ day: "2026-10-01", search: 1, show: 1, curate: 0, feedback: 0 }],
      topAssets: [{ ref: "main//memories/vpn-note", shows: 1, searchHits: 1, selects: 1, positive: 0, negative: 0 }],
      topQueries: [{ query: "vpn setup", count: 1, avgResults: 2, lastAt: "2026-10-01T09:00:00.000Z" }],
      zeroResultQueries: [{ query: "nothing here", count: 1, avgResults: 0, lastAt: "2026-10-02T10:00:00.000Z" }],
      bySource: { user: 6, improve: 1 },
    },
    feedback: {
      totals: { positive: 1, negative: 1 },
      byAsset: [
        { ref: "main//skills/code-review", positive: 1, negative: 1, valence: 0, lastAt: "2026-10-03T11:00:00.000Z" },
      ],
      byTag: { outdated: { positive: 0, negative: 1 } },
      recentNegative: [
        { ref: "main//skills/code-review", at: "2026-10-02T11:00:00.000Z", reason: "stale", tags: ["outdated"] },
      ],
    },
    utility: {
      count: 2,
      histogram: Array.from({ length: 10 }, (_, i) => ({
        bucket: `0.${i}-${i === 9 ? "1.0" : `0.${i + 1}`}`,
        count: i === 5 ? 2 : 0,
      })),
      lowest: [{ ref: "main//skills/code-review", utility: 0.4, showCount: 3, searchCount: 5, selectRate: 0.6 }],
      highest: [{ ref: "main//memories/vpn-note", utility: 0.9, showCount: 9, searchCount: 9, selectRate: 1 }],
      neverUsed: 4,
    },
    outcomes: {
      lowestOutcome: [
        {
          ref: "main//skills/code-review",
          outcomeScore: -0.2,
          retrievalCount: 3,
          negativeFeedbackCount: 1,
          acceptedChangeCount: 0,
        },
      ],
    },
    llm: {
      calls: 2,
      totalDurationMs: 3000,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: 0,
      failures: 0,
      byStage: {},
      byProcess: {},
      byEngine: {},
      cost: [],
    },
    index: { runs: 1, medianMs: 800, recent: [{ at: "2026-10-01T08:00:00.000Z", mode: "full", totalMs: 800 }] },
    tasks: { runs: 4, failed: 1, failRate: 0.25, byTask: [{ taskId: "improve", runs: 4, failed: 1, medianMs: 1200 }] },
    proposals: { byStatus: { pending: 2 }, acceptRateBySource: [] },
    workflows: { runs: 0, byStatus: {}, tokens: 0, byModel: {} },
    rows: {
      usage,
      llm: [
        {
          at: "2026-10-01T09:00:00.000Z",
          stage: "distill",
          process: "improve",
          engine: "local",
          model: "m",
          outcome: "success",
          durationMs: 1000,
          promptTokens: 60,
          completionTokens: 30,
          totalTokens: 90,
        },
        {
          at: "2026-10-02T09:00:00.000Z",
          stage: "judge",
          process: "improve",
          engine: "local",
          model: "m",
          outcome: "error",
          durationMs: 2000,
          promptTokens: 40,
          completionTokens: 20,
          totalTokens: 60,
        },
      ],
    },
    notes: ["index.db missing"],
    ...overrides,
  };
}

function island(html: string): string {
  const m = html.match(/<script type="application\/json" id="akm-data">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no data island");
  return m[1] as string;
}

function loadCore(html: string): Record<string, (...args: never[]) => unknown> {
  const m = html.match(/\/\* CORE-BEGIN \*\/([\s\S]*?)\/\* CORE-END \*\//);
  if (!m) throw new Error("no core block");
  return new Function(
    `${m[1]}; return { filterRows, aggregate, aggregateLlm, toCsv, dayRange, sortRows, bundleOf };`,
  )() as never;
}

describe("renderMetricsHtml", () => {
  test("returns null for a non-metrics payload so the generic renderer takes over", () => {
    expect(renderMetricsHtml({ foo: 1 })).toBeNull();
    expect(renderMetricsHtml(null)).toBeNull();
  });

  test("substitutes every token and loads only the shared ECharts tag", () => {
    const html = renderMetricsHtml(fixture()) as string;
    expect(html).not.toMatch(/%%[A-Z_]+%%/);
    expect(html).toContain(buildEchartsTag());
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([buildEchartsTag().match(/src="([^"]+)"/)?.[1]]);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  test("the data island carries the full result including rows", () => {
    const result = fixture();
    const html = renderMetricsHtml(result) as string;
    const data = JSON.parse(island(html));
    expect(data.rows.usage).toHaveLength(7);
    expect(data.rows.llm).toHaveLength(2);
    expect(data.usage.totals.searches).toBe(2);
    expect(data.window.until).toBe("2026-10-08T00:00:00.000Z");
  });

  test("a hostile query or reason cannot break out of the data island", () => {
    const result = fixture();
    const evil = "</script><img src=x onerror=alert(1)><!-- <script>";
    result.rows?.usage.push({
      id: 99,
      at: "2026-10-03T00:00:00.000Z",
      eventType: "feedback",
      ref: "main//a/b",
      signal: "negative",
      source: "user",
      reason: evil,
      query: evil,
    });
    const html = renderMetricsHtml(result) as string;
    const raw = island(html);
    expect(raw).not.toContain("<");
    expect(raw).toContain("\\u003c/script>");
    expect(html).not.toContain("<img src=x");
    const parsed = JSON.parse(raw);
    expect(parsed.rows.usage.at(-1).reason).toBe(evil);
  });

  test("is deterministic and never reads the clock", () => {
    const now = spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must not be read");
    });
    try {
      const a = renderMetricsHtml(fixture()) as string;
      const b = renderMetricsHtml(fixture()) as string;
      expect(a).toBe(b);
      expect(a).toContain('<time data-iso="2026-10-08T00:00:00.000Z"');
    } finally {
      now.mockRestore();
    }
  });

  test("keeps the most recent rows past the cap and says so in the notes", () => {
    const result = fixture();
    const many: MetricsUsageRow[] = Array.from({ length: MAX_HTML_USAGE_ROWS + 5 }, (_, i) => ({
      id: i + 1,
      at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
      eventType: "show",
      ref: `main//k/${i}`,
      source: "user",
    }));
    // Hand them over newest-first to prove the cut is by time, not input order.
    (result.rows as { usage: MetricsUsageRow[] }).usage = [...many].reverse();
    const data = JSON.parse(island(renderMetricsHtml(result) as string));
    expect(data.rows.usage).toHaveLength(MAX_HTML_USAGE_ROWS);
    expect(data.rows.usage[0].id).toBe(6);
    expect(data.rows.usage.at(-1).id).toBe(MAX_HTML_USAGE_ROWS + 5);
    expect(data.notes.some((n: string) => n.includes(String(MAX_HTML_USAGE_ROWS)))).toBe(true);
    expect(data.notes).toContain("index.db missing");
  });

  test("does not mutate the input result", () => {
    const result = fixture();
    const before = JSON.stringify(result);
    renderMetricsHtml(result);
    expect(JSON.stringify(result)).toBe(before);
  });

  test("a result without rows still renders, with an island that has empty rows", () => {
    const { rows: _rows, ...rest } = fixture();
    const html = renderMetricsHtml(rest as AkmMetricsResult) as string;
    const data = JSON.parse(island(html));
    expect(data.rows).toEqual({ usage: [], llm: [] });
  });

  test("replacement tokens escape header text", () => {
    const r = buildMetricsHtmlReplacements(fixture({ filters: { source: "<b>", bundles: ["a&b"] } }));
    expect(r["%%FILTERS_HTML%%"]).toContain("&lt;b&gt;");
    expect(r["%%FILTERS_HTML%%"]).toContain("a&amp;b");
  });

  test("the template is embedded so the compiled binary can render it", () => {
    const viaDisk = renderHtml(resolveTemplatePath("metrics"), { "%%REPORT_TITLE%%": "T" });
    const viaEmbedded = renderHtml(path.join(os.tmpdir(), "does-not-exist", "metrics.html"), {
      "%%REPORT_TITLE%%": "T",
    });
    expect(viaEmbedded).toBe(viaDisk);
  });
});

interface Agg {
  totals: Record<string, number>;
  assets: Array<{ ref: string; shows: number; searchHits: number }>;
  zeroQueries: Array<{ query: string }>;
  tags: Record<string, { positive: number; negative: number }>;
  negatives: Array<{ reason: string }>;
  daily: Array<{ day: string }>;
}
interface LlmAgg {
  totals: Record<string, number>;
  byStage: Array<{ name: string }>;
}

describe("dashboard client core", () => {
  const html = renderMetricsHtml(fixture()) as string;
  const core = loadCore(html) as unknown as {
    filterRows: (rows: MetricsUsageRow[], f: Record<string, unknown>) => MetricsUsageRow[];
    aggregate: (rows: MetricsUsageRow[]) => Agg;
    aggregateLlm: (rows: unknown[], f: Record<string, unknown>) => LlmAgg;
    toCsv: (cols: Array<{ key: string; label: string }>, rows: Array<Record<string, unknown>>) => string;
    dayRange: (a: string, b: string) => string[];
    sortRows: (rows: Array<Record<string, unknown>>, key: string, dir: string) => Array<Record<string, unknown>>;
  };
  const rows = fixture().rows?.usage as MetricsUsageRow[];

  test("aggregate re-derives totals, assets, queries and feedback from rows", () => {
    const a = core.aggregate(rows);
    expect(a.totals.searches).toBe(2);
    expect(a.totals.shows).toBe(2);
    expect(a.totals.zeroResult).toBe(1);
    expect(a.totals.positive).toBe(1);
    expect(a.totals.negative).toBe(1);
    const vpn = a.assets.find((x) => x.ref === "main//memories/vpn-note");
    expect(vpn?.shows).toBe(1);
    expect(vpn?.searchHits).toBe(1);
    expect(a.zeroQueries.map((q) => q.query)).toEqual(["nothing here"]);
    expect(a.tags.outdated?.negative).toBe(1);
    expect(a.negatives[0]?.reason).toBe("stale");
    expect(a.daily.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  test("filters narrow by source, bundle, type, date and text", () => {
    expect(core.filterRows(rows, { sources: new Set(["improve"]) })).toHaveLength(1);
    expect(core.filterRows(rows, { bundles: new Set(["other"]) }).map((r) => r.id)).toEqual([7]);
    expect(core.filterRows(rows, { types: new Set(["feedback"]) })).toHaveLength(2);
    expect(core.filterRows(rows, { from: "2026-10-02", to: "2026-10-02" })).toHaveLength(2);
    expect(core.filterRows(rows, { text: "API-GUIDE" }).map((r) => r.id)).toEqual([7]);
    expect(core.filterRows(rows, {})).toHaveLength(7);
  });

  test("CSV quotes cells and neutralizes spreadsheet formulas", () => {
    const csv = core.toCsv(
      [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      [
        { a: 'say "hi", ok', b: 3 },
        { a: "=HYPERLINK(1)", b: null },
        { a: ["x", "y"], b: "@sum" },
      ],
    );
    expect(csv.split("\n")).toEqual(["A,B", '"say ""hi"", ok",3', "'=HYPERLINK(1),", "x; y,'@sum"]);
  });

  test("dayRange fills gaps and sortRows puts nulls last", () => {
    expect(core.dayRange("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    const sorted = core.sortRows([{ v: null }, { v: 1 }, { v: 5 }], "v", "desc");
    expect(sorted.map((r) => r.v)).toEqual([5, 1, null]);
    expect(core.sortRows([{ v: null }, { v: 1 }, { v: 5 }], "v", "asc").map((r) => r.v)).toEqual([1, 5, null]);
  });

  test("aggregateLlm sums tokens per dimension inside the date range", () => {
    const llm = fixture().rows?.llm as unknown[];
    const a = core.aggregateLlm(llm, { from: "2026-10-01", to: "2026-10-01" });
    expect(a.totals).toMatchObject({ calls: 1, tokens: 90, failures: 0 });
    expect(a.byStage[0]?.name).toBe("distill");
    const all = core.aggregateLlm(llm, {});
    expect(all.totals).toMatchObject({ calls: 2, tokens: 150, failures: 1 });
  });
});

describe("output() wiring", () => {
  afterEach(() => {
    resetOutputMode();
    deregisterOutputShape("metrics");
  });

  test("--format html routes the metrics command to the bespoke dashboard", () => {
    registerOutputShape("metrics", (result) => result);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-metrics-html-"));
    try {
      const out = path.join(dir, "metrics.html");
      initOutputMode(["--format", "html", "--output", out]);
      output("metrics", fixture());
      const html = fs.readFileSync(out, "utf8");
      expect(html).toContain('id="akm-data"');
      expect(html).toContain("akm metrics");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
