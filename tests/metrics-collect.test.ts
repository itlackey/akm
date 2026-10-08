// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Pure aggregation behind `akm metrics`: plain rows in, the result envelope out. */

import { describe, expect, test } from "bun:test";
import { emptyLlmUsageAggregate, summarizeLlmUsage } from "../src/commands/health/llm-usage";
import {
  buildMetricsResult,
  indexRunsFromEvents,
  llmRowsFromEvents,
  type MetricsInput,
  refMatchesFilters,
  retentionNotes,
  toUsageRow,
  usageCreatedAtToIso,
} from "../src/commands/metrics/collect";
import type { EventEnvelope } from "../src/core/events-types";
import type { UsageEventRow } from "../src/indexer/usage/usage-events";
import type { TaskHistoryRow } from "../src/storage/repositories/task-history-repository";

let nextId = 1;
function usage(partial: Partial<UsageEventRow> & Pick<UsageEventRow, "event_type" | "created_at">): UsageEventRow {
  return {
    id: nextId++,
    query: null,
    entry_id: null,
    entry_ref: null,
    signal: null,
    metadata: null,
    source: "user",
    ...partial,
  };
}

function input(partial: Partial<MetricsInput> = {}): MetricsInput {
  return {
    window: { since: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z" },
    filters: { source: "user", bundles: [] },
    top: 20,
    includeRows: false,
    usage: [],
    selects: [],
    utility: undefined,
    outcomes: [],
    llm: emptyLlmUsageAggregate(),
    llmRows: [],
    indexRuns: [],
    tasks: [],
    proposals: { byStatus: {}, acceptRateBySource: [] },
    workflows: { runs: 0, byStatus: {}, tokens: 0, byModel: {} },
    notes: [],
    ...partial,
  };
}

function task(taskId: string, status: string, durationMs: number): TaskHistoryRow {
  return {
    task_id: taskId,
    status,
    started_at: "2026-01-05T00:00:00.000Z",
    completed_at: "2026-01-05T00:01:00.000Z",
    failed_at: null,
    log_path: null,
    target_kind: null,
    target_ref: null,
    metadata_json: JSON.stringify({ durationMs, detail: null }),
  } as TaskHistoryRow;
}

describe("usage rows", () => {
  test("created_at becomes ISO, whether it is SQLite's form or already ISO", () => {
    expect(usageCreatedAtToIso("2026-01-10 13:05:09")).toBe("2026-01-10T13:05:09.000Z");
    expect(usageCreatedAtToIso("2026-01-10T13:05:09.250Z")).toBe("2026-01-10T13:05:09.250Z");
    expect(usageCreatedAtToIso("garbage")).toBe("garbage");
  });

  test("metadata fields surface; malformed metadata is ignored", () => {
    const row = toUsageRow(
      usage({
        event_type: "feedback",
        created_at: "2026-01-10 13:05:09",
        entry_ref: "b//skills/x",
        signal: "negative",
        metadata: JSON.stringify({ reason: "stale", tags: ["a", 3, "b"], resultCount: 2, totalMs: 9 }),
      }),
    );
    expect(row).toMatchObject({
      eventType: "feedback",
      ref: "b//skills/x",
      signal: "negative",
      reason: "stale",
      tags: ["a", "b"],
      resultCount: 2,
      totalMs: 9,
    });
    const bad = toUsageRow(usage({ event_type: "show", created_at: "2026-01-10 00:00:00", metadata: "{nope" }));
    expect(bad.reason).toBeUndefined();
    expect(bad.resultCount).toBeUndefined();
  });
});

describe("usage section", () => {
  const rows = [
    usage({
      event_type: "search",
      created_at: "2026-01-02 10:00:00",
      query: "deploy",
      metadata: '{"resultCount":3,"totalMs":10}',
    }),
    usage({ event_type: "search", created_at: "2026-01-02 10:00:00", query: "deploy", entry_ref: "b//skills/deploy" }),
    usage({
      event_type: "search",
      created_at: "2026-01-03 10:00:00",
      query: "deploy",
      metadata: '{"resultCount":1,"totalMs":30}',
    }),
    usage({ event_type: "search", created_at: "2026-01-03 11:00:00", query: "nope", metadata: '{"resultCount":0}' }),
    usage({ event_type: "show", created_at: "2026-01-03 12:00:00", entry_ref: "b//skills/deploy" }),
    usage({ event_type: "show", created_at: "2026-01-03 12:30:00", entry_ref: "b//skills/other" }),
    usage({ event_type: "curate", created_at: "2026-01-03 13:00:00", query: "q" }),
    usage({ event_type: "curate", created_at: "2026-01-03 13:00:00", entry_ref: "b//skills/deploy" }),
  ];
  const result = buildMetricsResult(
    input({ usage: rows, selects: [{ ts: "2026-01-03T12:00:01.000Z", ref: "b//skills/deploy" }] }),
  ).usage;

  test("totals count summary rows once and per-hit rows not at all", () => {
    expect(result.totals).toEqual({
      searches: 3,
      shows: 2,
      curates: 1,
      selects: 1,
      zeroResultSearches: 1,
      distinctAssets: 2,
      distinctQueries: 2,
    });
  });

  test("select rate divides by searches that returned something; median uses persisted timings", () => {
    expect(result.selectRate).toBe(1 / 2);
    expect(result.searchMedianMs).toBe(30);
  });

  test("daily buckets by UTC day, ascending", () => {
    expect(result.daily).toEqual([
      { day: "2026-01-02", search: 1, show: 0, curate: 0, feedback: 0 },
      { day: "2026-01-03", search: 2, show: 2, curate: 1, feedback: 0 },
    ]);
  });

  test("assets, queries and zero-result queries rank by count then name", () => {
    expect(result.topAssets[0]).toMatchObject({ ref: "b//skills/deploy", shows: 1, searchHits: 1, selects: 1 });
    expect(result.topAssets[0]?.lastUsedAt).toBe("2026-01-03T12:00:01.000Z");
    expect(result.topQueries.map((q) => [q.query, q.count, q.avgResults])).toEqual([
      ["deploy", 2, 2],
      ["nope", 1, 0],
    ]);
    expect(result.zeroResultQueries).toEqual([
      { query: "nope", count: 1, avgResults: 0, lastAt: "2026-01-03T11:00:00.000Z" },
    ]);
    expect(result.bySource).toEqual({ user: 8 });
  });

  test("--top caps every ranked list", () => {
    const capped = buildMetricsResult(input({ usage: rows, top: 1 })).usage;
    expect(capped.topAssets).toHaveLength(1);
    expect(capped.topQueries).toHaveLength(1);
  });

  test("rates are null, never NaN, when the denominator is 0", () => {
    const empty = buildMetricsResult(input()).usage;
    expect(empty.selectRate).toBeNull();
    expect(empty.searchMedianMs).toBeNull();
  });

  test("under a bundle filter the per-hit rows are the searches", () => {
    const filtered = buildMetricsResult(
      input({ usage: [rows[1]!, rows[4]!], filters: { source: "user", bundles: ["b"] } }),
    ).usage;
    expect(filtered.totals.searches).toBe(1);
    expect(filtered.totals.zeroResultSearches).toBe(0);
    expect(filtered.topQueries.map((q) => q.query)).toEqual(["deploy"]);
  });

  test("under a bundle filter one search that wrote several per-hit rows is one search", () => {
    const hit = (ref: string, createdAt: string, eventType: "search" | "curate" = "search") =>
      usage({ event_type: eventType, created_at: createdAt, query: "deploy", entry_ref: ref });
    const filtered = buildMetricsResult(
      input({
        usage: [
          hit("b//skills/a", "2026-01-02 10:00:00"),
          hit("b//skills/b", "2026-01-02 10:00:00"),
          hit("b//skills/c", "2026-01-02 10:00:00"),
          hit("b//skills/a", "2026-01-03 10:00:00"),
          hit("b//skills/a", "2026-01-04 10:00:00", "curate"),
          hit("b//skills/b", "2026-01-04 10:00:00", "curate"),
        ],
        selects: [{ ts: "2026-01-02T10:00:01.000Z", ref: "b//skills/a" }],
        filters: { source: "user", bundles: ["b"] },
      }),
    ).usage;
    expect(filtered.totals.searches).toBe(2);
    expect(filtered.totals.curates).toBe(1);
    expect(filtered.totals.distinctQueries).toBe(1);
    expect(filtered.topQueries.map((q) => [q.query, q.count])).toEqual([["deploy", 2]]);
    expect(filtered.daily.map((d) => [d.day, d.search, d.curate])).toEqual([
      ["2026-01-02", 1, 0],
      ["2026-01-03", 1, 0],
      ["2026-01-04", 0, 1],
    ]);
    expect(filtered.selectRate).toBe(1 / 2);
    expect(filtered.topAssets.find((a) => a.ref === "b//skills/a")?.searchHits).toBe(2);
  });
});

describe("feedback section", () => {
  const rows = [
    usage({
      event_type: "feedback",
      created_at: "2026-01-02 00:00:00",
      entry_ref: "b//skills/a",
      signal: "positive",
      metadata: '{"tags":["x"]}',
    }),
    usage({
      event_type: "feedback",
      created_at: "2026-01-03 00:00:00",
      entry_ref: "b//skills/a",
      signal: "negative",
      metadata: '{"reason":"old","tags":["x","y"]}',
    }),
    usage({ event_type: "feedback", created_at: "2026-01-04 00:00:00", entry_ref: "b//skills/b", signal: "negative" }),
  ];
  const feedback = buildMetricsResult(input({ usage: rows })).feedback;

  test("totals, valence per asset and tag counts", () => {
    expect(feedback.totals).toEqual({ positive: 1, negative: 2 });
    expect(feedback.byAsset.map((a) => [a.ref, a.positive, a.negative, a.valence])).toEqual([
      ["b//skills/a", 1, 1, 0],
      ["b//skills/b", 0, 1, -1],
    ]);
    expect(feedback.byTag).toEqual({ x: { positive: 1, negative: 1 }, y: { positive: 0, negative: 1 } });
  });

  test("recent negatives are newest first and carry reason and tags", () => {
    expect(feedback.recentNegative).toEqual([
      { ref: "b//skills/b", at: "2026-01-04T00:00:00.000Z" },
      { ref: "b//skills/a", at: "2026-01-03T00:00:00.000Z", reason: "old", tags: ["x", "y"] },
    ]);
  });
});

describe("utility section", () => {
  const utility = [
    { ref: "b//a", score: { utility: 0.05, showCount: 1, searchCount: 2, selectRate: 0.5 } },
    { ref: "b//b", score: { utility: 0.5, showCount: 0, searchCount: 0, selectRate: 0 } },
    {
      ref: "b//c",
      score: { utility: 1, showCount: 9, searchCount: 9, selectRate: 1, lastUsedAt: "2026-01-02T00:00:00Z" },
    },
    { ref: "b//d" },
    { ref: "other//e" },
  ];

  test("histogram has ten buckets, 1.0 lands in the last, unscored entries are never-used", () => {
    const section = buildMetricsResult(input({ utility })).utility;
    expect(section.count).toBe(3);
    expect(section.neverUsed).toBe(2);
    expect(section.histogram).toHaveLength(10);
    expect(section.histogram[0]).toEqual({ bucket: "0.0-0.1", count: 1 });
    expect(section.histogram[5]).toEqual({ bucket: "0.5-0.6", count: 1 });
    expect(section.histogram[9]).toEqual({ bucket: "0.9-1.0", count: 1 });
    expect(section.lowest.map((a) => a.ref)).toEqual(["b//a", "b//b", "b//c"]);
    expect(section.highest[0]).toMatchObject({ ref: "b//c", lastUsedAt: "2026-01-02T00:00:00Z" });
  });

  test("filters apply to the utility rows", () => {
    const section = buildMetricsResult(input({ utility, filters: { source: "user", bundles: ["other"] } })).utility;
    expect(section.count).toBe(0);
    expect(section.neverUsed).toBe(1);
    expect(
      buildMetricsResult(input({ utility, filters: { source: "user", bundles: [], ref: "b//c" } })).utility.count,
    ).toBe(1);
  });

  test("a missing index gives an empty section", () => {
    const section = buildMetricsResult(input()).utility;
    expect(section).toMatchObject({ count: 0, neverUsed: 0, lowest: [], highest: [] });
    expect(section.histogram.every((bucket) => bucket.count === 0)).toBe(true);
  });
});

describe("llm section", () => {
  test("is health's aggregate unchanged", () => {
    const llm = { ...emptyLlmUsageAggregate(), calls: 3 };
    expect(buildMetricsResult(input({ llm })).llm).toEqual(llm);
  });
});

describe("tasks, index and rows", () => {
  test("task fail rate matches health's failed-over-all definition", () => {
    const tasks = buildMetricsResult(
      input({
        tasks: [
          task("a", "completed", 100),
          task("a", "failed", 300),
          task("a", "completed", 200),
          task("b", "failed", 5),
        ],
      }),
    ).tasks;
    expect(tasks.runs).toBe(4);
    expect(tasks.failed).toBe(2);
    expect(tasks.failRate).toBe(0.5);
    expect(tasks.byTask).toEqual([
      { taskId: "a", runs: 3, failed: 1, medianMs: 200 },
      { taskId: "b", runs: 1, failed: 1, medianMs: 5 },
    ]);
    expect(buildMetricsResult(input()).tasks.failRate).toBeNull();
  });

  test("index runs come from index_completed events and skip rows without a duration", () => {
    const runs = indexRunsFromEvents([
      { ts: "2026-01-02T00:00:00.000Z", metadata_json: '{"mode":"full","totalMs":900}' },
      { ts: "2026-01-03T00:00:00.000Z", metadata_json: '{"mode":"incremental","totalMs":100}' },
      { ts: "2026-01-04T00:00:00.000Z", metadata_json: '{"mode":"full"}' },
    ]);
    expect(runs).toHaveLength(2);
    const section = buildMetricsResult(input({ indexRuns: runs })).index;
    expect(section.runs).toBe(2);
    expect(section.recent[0]).toEqual({ at: "2026-01-03T00:00:00.000Z", mode: "incremental", totalMs: 100 });
  });

  test("rows are attached only when asked", () => {
    const usageRows = [usage({ event_type: "show", created_at: "2026-01-02 00:00:00", entry_ref: "b//a" })];
    expect(buildMetricsResult(input({ usage: usageRows })).rows).toBeUndefined();
    const withRows = buildMetricsResult(input({ usage: usageRows, includeRows: true }));
    expect(withRows.rows?.usage).toHaveLength(1);
    expect(withRows.rows?.llm).toEqual([]);
  });
});

describe("llmRowsFromEvents", () => {
  const call = (ts: string, metadata: Record<string, unknown>) =>
    ({ ts, eventType: "llm_usage", metadata }) as unknown as EventEnvelope;

  test("sums calls, time and tokens per day x stage x process x engine x model x outcome", () => {
    const base = { stage: "distill", process: "improve", engine: "local", model: "m" };
    const events = [
      call("2026-10-01T01:00:00.000Z", {
        ...base,
        outcome: "success",
        durationMs: 100,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
      call("2026-10-01T23:00:00.000Z", {
        ...base,
        outcome: "success",
        durationMs: 300,
        promptTokens: 20,
        completionTokens: 10,
      }),
      call("2026-10-01T23:30:00.000Z", { ...base, outcome: "error", durationMs: 50 }),
      call("2026-10-02T00:00:00.000Z", {
        ...base,
        outcome: "success",
        durationMs: 200,
        totalTokens: 7,
        reasoningTokens: 2,
      }),
      call("2026-10-02T00:00:01.000Z", { durationMs: 1 }),
      call("2026-10-02T00:00:02.000Z", { outcome: "success" }),
    ];
    const rows = llmRowsFromEvents(events);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      day: "2026-10-01",
      ...base,
      outcome: "success",
      calls: 2,
      durationMs: 400,
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
      reasoningTokens: 0,
    });
    expect(rows[3]).toMatchObject({ day: "2026-10-02", outcome: "success", calls: 1, durationMs: 1 });
    expect(rows[3]?.stage).toBeUndefined();
    // The rows add up to the window totals the JSON report carries.
    const totals = summarizeLlmUsage(events as never);
    expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(totals.calls);
    expect(rows.reduce((n, r) => n + r.durationMs, 0)).toBe(totals.totalDurationMs);
    expect(rows.filter((r) => r.outcome === "error").reduce((n, r) => n + r.calls, 0)).toBe(totals.failures);
  });
});

describe("retention notes", () => {
  const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
  const base = { nowMs, usageRetentionDays: 90, eventRetentionDays: 90 };

  test("a window inside both retentions has no notes", () => {
    expect(retentionNotes({ ...base, sinceIso: "2026-05-01T00:00:00.000Z" })).toEqual([]);
  });

  test("each shorter store is named with its retention and effective start", () => {
    const notes = retentionNotes({ ...base, sinceIso: "2026-01-01T00:00:00.000Z", eventRetentionDays: 30 });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("usage_events");
    expect(notes[0]).toContain("keeps 90 days");
    expect(notes[0]).toContain("2026-03-03T00:00:00.000Z");
    expect(notes[1]).toContain("keeps 30 days");
    expect(notes[1]).toContain("2026-05-02T00:00:00.000Z");
  });

  test("0 means never purged", () => {
    expect(
      retentionNotes({ ...base, sinceIso: "2020-01-01T00:00:00.000Z", usageRetentionDays: 0, eventRetentionDays: 0 }),
    ).toEqual([]);
  });
});

describe("refMatchesFilters", () => {
  test("ref wins, then bundle prefix, then everything", () => {
    expect(refMatchesFilters("b//x", { bundles: [] })).toBe(true);
    expect(refMatchesFilters("b//x", { bundles: ["b"] })).toBe(true);
    expect(refMatchesFilters("bb//x", { bundles: ["b"] })).toBe(false);
    expect(refMatchesFilters("b//x", { bundles: ["z"], ref: "b//x" })).toBe(true);
    expect(refMatchesFilters("b//y", { bundles: [], ref: "b//x" })).toBe(false);
  });
});
