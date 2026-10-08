// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import "../src/commands/metrics/md-report";
import type { AkmMetricsResult } from "../src/commands/metrics/types";
import { getMdRendererHandler } from "../src/output/render-registry";
import { formatPlain } from "../src/output/text";

const stage = {
  calls: 2,
  totalDurationMs: 1500,
  promptTokens: 100,
  completionTokens: 40,
  totalTokens: 140,
  reasoningTokens: 5,
  failures: 1,
};

function fixture(overrides: Partial<AkmMetricsResult> = {}): AkmMetricsResult {
  const assets = Array.from({ length: 8 }, (_, i) => ({
    ref: `team//skills/a${i}`,
    shows: 10 - i,
    searchHits: 20 - i,
    selects: 3,
    positive: 1,
    negative: 0,
    lastUsedAt: "2026-10-07T10:00:00.000Z",
  }));
  return {
    schemaVersion: 1,
    window: { since: "2026-09-08T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" },
    filters: { source: "user", bundles: [] },
    usage: {
      totals: {
        searches: 20,
        shows: 12,
        curates: 1,
        selects: 6,
        zeroResultSearches: 5,
        distinctAssets: 8,
        distinctQueries: 9,
      },
      selectRate: 0.4,
      searchMedianMs: 12.4,
      daily: [{ day: "2026-10-07", search: 20, show: 12, curate: 1, feedback: 2 }],
      topAssets: assets,
      topQueries: [{ query: "vpn | setup\nnotes", count: 4, avgResults: 2.5, lastAt: "2026-10-07T09:00:00.000Z" }],
      zeroResultQueries: [{ query: "kubernetes", count: 3, avgResults: 0, lastAt: "2026-10-06T09:00:00.000Z" }],
      bySource: { user: 18, improve: 2 },
    },
    feedback: {
      totals: { positive: 3, negative: 1 },
      byAsset: [{ ref: "team//skills/a0", positive: 3, negative: 1, valence: 0.5, lastAt: "2026-10-07T10:00:00.000Z" }],
      byTag: { stale: { positive: 0, negative: 1 } },
      recentNegative: [{ ref: "team//skills/a0", at: "2026-10-07T10:00:00.000Z", reason: "outdated", tags: ["stale"] }],
    },
    utility: {
      count: 8,
      histogram: [{ bucket: "0.0-0.1", count: 2 }],
      lowest: [
        {
          ref: "team//skills/a7",
          utility: 0.12,
          showCount: 1,
          searchCount: 2,
          selectRate: 0.5,
          lastUsedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      highest: [],
      neverUsed: 4,
    },
    outcomes: { lowestOutcome: [] },
    llm: {
      calls: 2,
      totalDurationMs: 1500,
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      reasoningTokens: 5,
      failures: 1,
      byStage: { reflect: stage },
      byProcess: {},
      byEngine: { local: stage },
    },
    index: { runs: 1, medianMs: 800, recent: [{ at: "2026-10-07T08:00:00.000Z", mode: "incremental", totalMs: 800 }] },
    tasks: { runs: 4, failed: 1, failRate: 0.25, byTask: [{ taskId: "improve", runs: 4, failed: 1, medianMs: null }] },
    proposals: {
      byStatus: { accepted: 2, pending: 1 },
      acceptRateBySource: [{ source: "reflect", total: 3, accepted: 2, rejected: 0, pending: 1, acceptRate: 1 }],
    },
    workflows: { runs: 0, byStatus: {}, tokens: 0, byModel: {} },
    notes: ["usage_events retention is 90 days"],
    ...overrides,
  };
}

function emptyFixture(): AkmMetricsResult {
  const f = fixture();
  return {
    ...f,
    usage: {
      totals: {
        searches: 0,
        shows: 0,
        curates: 0,
        selects: 0,
        zeroResultSearches: 0,
        distinctAssets: 0,
        distinctQueries: 0,
      },
      selectRate: null,
      searchMedianMs: null,
      daily: [],
      topAssets: [],
      topQueries: [],
      zeroResultQueries: [],
      bySource: {},
    },
    feedback: { totals: { positive: 0, negative: 0 }, byAsset: [], byTag: {}, recentNegative: [] },
    utility: { count: 0, histogram: [], lowest: [], highest: [], neverUsed: 0 },
    llm: {
      calls: 0,
      totalDurationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      failures: 0,
      byStage: {},
      byProcess: {},
      byEngine: {},
    },
    index: { runs: 0, medianMs: null, recent: [] },
    tasks: { runs: 0, failed: 0, failRate: null, byTask: [] },
    proposals: { byStatus: {}, acceptRateBySource: [] },
    notes: [],
  };
}

const text = (r: AkmMetricsResult, detail: "brief" | "normal" | "full" = "normal") => formatPlain("metrics", r, detail);
const md = (r: unknown, detail: "brief" | "normal" | "full" = "normal") => getMdRendererHandler("metrics")?.(r, detail);

describe("metrics text formatter", () => {
  test("renders every section with aligned tables", () => {
    const out = text(fixture())!;
    for (const s of ["USAGE", "FEEDBACK", "UTILITY", "LLM", "INDEX", "TASKS", "PROPOSALS", "WORKFLOWS", "NOTES"]) {
      expect(out).toContain(s);
    }
    expect(out).toContain("select rate");
    expect(out).toContain("40.0%");
    expect(out).toContain("Top assets:");
    expect(out).toContain("kubernetes");
    // Newlines in a query never break the row layout.
    expect(out).toContain("vpn | setup notes");
  });

  test("brief cuts lists to 5 and omits the daily table; normal shows them all", () => {
    const brief = text(fixture(), "brief")!;
    const normal = text(fixture(), "normal")!;
    expect(brief).toContain("team//skills/a4");
    expect(brief).not.toContain("team//skills/a5");
    expect(brief).not.toContain("Daily:");
    expect(normal).toContain("team//skills/a7");
    expect(normal).toContain("Daily:");
  });

  test("null rates render n/a, never NaN", () => {
    const out = text(emptyFixture())!;
    expect(out).toContain("n/a");
    expect(out).not.toContain("NaN");
    expect(out).toContain("Top assets: (none)");
    expect(out).not.toContain("By tag");
  });

  test("falls through (null) on a payload that is not a metrics result", () => {
    expect(formatPlain("metrics", { ok: true }, "normal")).toBeNull();
  });
});

describe("metrics md renderer", () => {
  test("registers and renders headings with GFM tables", () => {
    const out = md(fixture())!;
    expect(out).toContain("# akm metrics");
    expect(out).toContain("## Usage");
    expect(out).toContain("### Top assets");
    expect(out).toContain("| ref | shows | search hits | selects | + | - | last used |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("- **select rate:** 40.0%");
    expect(out).toContain("## Notes");
  });

  test("escapes pipes and newlines in cells", () => {
    const out = md(fixture())!;
    expect(out).toContain("vpn \\| setup notes");
  });

  test("brief cuts lists to 5", () => {
    const brief = md(fixture(), "brief")!;
    expect(brief).toContain("team//skills/a4");
    expect(brief).not.toContain("team//skills/a5");
  });

  test("empty result renders without NaN and marks empty lists", () => {
    const out = md(emptyFixture())!;
    expect(out).not.toContain("NaN");
    expect(out).toContain("_none_");
    expect(out).toContain("n/a");
  });

  test("is deterministic and returns null for a foreign payload", () => {
    expect(md(fixture())).toBe(md(fixture()));
    expect(md({ ok: true })).toBeNull();
  });
});
