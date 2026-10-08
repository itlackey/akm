// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics` against a real state.db (integration: opens the database).
 * Rows are written with explicit `created_at` values in the table's own
 * `YYYY-MM-DD HH:MM:SS` form so the window arithmetic is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmMetricsResult } from "../../src/commands/metrics/types";
import { appendEvent } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { runCliStatus } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

/** `created_at` as SQLite writes it: UTC, space-separated, no zone. */
function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const HOUR = 3_600_000;

interface SeedUsage {
  type: "search" | "show" | "curate" | "feedback";
  at: string;
  ref?: string;
  query?: string;
  signal?: "positive" | "negative";
  metadata?: Record<string, unknown>;
  source?: string;
}

function seedUsage(rows: SeedUsage[]): void {
  const db: Database = openStateDatabase();
  try {
    const insert = db.prepare(
      `INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.type,
        row.query ?? null,
        row.ref ?? null,
        row.signal ?? null,
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.source ?? "user",
        row.at,
      );
    }
  } finally {
    db.close();
  }
}

async function metrics(...args: string[]): Promise<{ status: number; result: AkmMetricsResult; stderr: string }> {
  const { status, stdout, stderr } = await runCliStatus(["metrics", ...args]);
  return { status, stderr, result: status === 0 ? (JSON.parse(stdout) as AkmMetricsResult) : ({} as AkmMetricsResult) };
}

describe("akm metrics", () => {
  test("a data dir with no state.db gives an empty report and exit 0", async () => {
    const { status, result } = await metrics();
    expect(status).toBe(0);
    expect(result.schemaVersion).toBe(1);
    expect(result.usage.totals).toEqual({
      searches: 0,
      shows: 0,
      curates: 0,
      selects: 0,
      zeroResultSearches: 0,
      distinctAssets: 0,
      distinctQueries: 0,
    });
    expect(result.usage.selectRate).toBeNull();
    expect(result.tasks.failRate).toBeNull();
    expect(result.notes.some((note) => note.includes("state.db was not found"))).toBe(true);
    expect(result.notes.some((note) => note.includes("index.db was not found"))).toBe(true);
    expect(result.rows).toBeUndefined();
  });

  test("aggregates usage, selects, feedback and zero-result queries", async () => {
    const now = Date.now();
    const at = (hoursAgo: number) => sqliteTs(now - hoursAgo * HOUR);
    seedUsage([
      { type: "search", at: at(5), query: "deploy", metadata: { resultCount: 2, totalMs: 40 } },
      { type: "search", at: at(5), query: "deploy", ref: "main//skills/deploy", metadata: {} },
      { type: "search", at: at(4), query: "nothing here", metadata: { resultCount: 0, totalMs: 20 } },
      { type: "show", at: at(4), ref: "main//skills/deploy" },
      {
        type: "feedback",
        at: at(3),
        ref: "main//skills/deploy",
        signal: "negative",
        metadata: { signal: "negative", reason: "out of date", tags: ["stale"] },
      },
    ]);
    appendEvent({ eventType: "select", ref: "main//skills/deploy", metadata: { query: "deploy" } });

    const { status, result } = await metrics("--since", "1d");
    expect(status).toBe(0);
    expect(result.usage.totals).toMatchObject({
      searches: 2,
      shows: 1,
      selects: 1,
      zeroResultSearches: 1,
      distinctAssets: 1,
      distinctQueries: 2,
    });
    expect(result.usage.selectRate).toBe(1);
    expect(result.usage.searchMedianMs).toBe(40);
    expect(result.usage.topAssets[0]).toMatchObject({
      ref: "main//skills/deploy",
      shows: 1,
      searchHits: 1,
      selects: 1,
      negative: 1,
    });
    expect(result.usage.zeroResultQueries.map((q) => q.query)).toEqual(["nothing here"]);
    expect(result.feedback.totals).toEqual({ positive: 0, negative: 1 });
    expect(result.feedback.byTag).toEqual({ stale: { positive: 0, negative: 1 } });
    expect(result.feedback.recentNegative[0]).toMatchObject({ ref: "main//skills/deploy", reason: "out of date" });
    expect(result.feedback.byAsset[0]).toMatchObject({ ref: "main//skills/deploy", valence: -1 });
  });

  test("the window compares created_at as a timestamp, not as text", async () => {
    // A raw string compare of '2026-01-10 13:00:00' against an ISO bound
    // '2026-01-10T12:00:00.000Z' puts the row BEFORE the bound (space < 'T').
    seedUsage([
      { type: "show", at: "2026-01-10 11:00:00", ref: "main//skills/before" },
      { type: "show", at: "2026-01-10 13:00:00", ref: "main//skills/inside" },
      { type: "show", at: "2026-01-11 01:00:00", ref: "main//skills/after" },
    ]);
    const { result } = await metrics("--since", "2026-01-10T12:00:00Z", "--until", "2026-01-11T00:00:00Z");
    expect(result.usage.topAssets.map((asset) => asset.ref)).toEqual(["main//skills/inside"]);
    expect(result.window).toEqual({ since: "2026-01-10T12:00:00.000Z", until: "2026-01-11T00:00:00.000Z" });
  });

  test("--source defaults to user and all removes the filter", async () => {
    const at = sqliteTs(Date.now() - HOUR);
    seedUsage([
      { type: "show", at, ref: "main//skills/a", source: "user" },
      { type: "show", at, ref: "main//skills/b", source: "improve" },
    ]);
    const user = await metrics();
    expect(user.result.usage.totals.shows).toBe(1);
    expect(user.result.filters.source).toBe("user");
    const all = await metrics("--source", "all");
    expect(all.result.usage.totals.shows).toBe(2);
    expect(all.result.usage.bySource).toEqual({ improve: 1, user: 1 });
    const improve = await metrics("--source", "improve");
    expect(improve.result.usage.totals.shows).toBe(1);
  });

  test("--bundle and --ref narrow the usage sections", async () => {
    const at = sqliteTs(Date.now() - HOUR);
    seedUsage([
      { type: "show", at, ref: "main//skills/a" },
      { type: "show", at, ref: "other//skills/a" },
      { type: "show", at, ref: "other//skills/b" },
    ]);
    const bundle = await metrics("--bundle", "other");
    expect(bundle.result.usage.totals.shows).toBe(2);
    expect(bundle.result.filters.bundles).toEqual(["other"]);
    const both = await metrics("--bundle", "main", "--bundle", "other");
    expect(both.result.usage.totals.shows).toBe(3);
    const ref = await metrics("--ref", "other//skills/b");
    expect(ref.result.usage.totals.shows).toBe(1);
    expect(ref.result.filters.ref).toBe("other//skills/b");
  });

  test("an unqualified --ref the index cannot resolve is not found", async () => {
    const { status, stderr } = await metrics("--ref", "skills/missing");
    expect(status).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ ok: false, code: "ASSET_NOT_FOUND" });
  });

  test("--since later than --until is a usage error", async () => {
    const { status, stderr } = await metrics("--since", "2026-02-01", "--until", "2026-01-01");
    expect(status).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
  });

  test("a window longer than a store's retention says so, a shorter one does not", async () => {
    const long = await metrics("--since", "180d");
    const notes = long.result.notes.filter((note) => note.includes("keeps 90 days"));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("usage_events");
    expect(notes[1]).toContain("events (");
    const short = await metrics("--since", "7d");
    expect(short.result.notes.some((note) => note.includes("keeps"))).toBe(false);
  });

  test("improve.eventRetentionDays moves the events note, 0 removes it", async () => {
    writeSandboxConfig({ improve: { eventRetentionDays: 30 } });
    const shorter = await metrics("--since", "60d");
    const notes = shorter.result.notes.filter((note) => note.includes("keeps"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("keeps 30 days");
    writeSandboxConfig({ improve: { eventRetentionDays: 0 } });
    const never = await metrics("--since", "180d");
    expect(never.result.notes.filter((note) => note.includes("keeps"))).toHaveLength(1);
  });

  test("llm.cost prices only the engines that have pricing", async () => {
    writeSandboxConfig({
      engines: {
        paid: {
          kind: "llm",
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          model: "m",
          pricing: { inputPerMillion: 2, outputPerMillion: 10, currency: "EUR" },
        },
        free: { kind: "llm", endpoint: "http://127.0.0.1:2/v1/chat/completions", model: "m" },
      },
    });
    for (const engine of ["paid", "free"]) {
      appendEvent({
        eventType: "llm_usage",
        metadata: {
          engine,
          model: "m",
          outcome: "success",
          durationMs: 100,
          promptTokens: 1_000_000,
          completionTokens: 500_000,
          reasoningTokens: 200_000,
          totalTokens: 1_500_000,
        },
      });
    }
    const { result } = await metrics();
    expect(result.llm.calls).toBe(2);
    // 1M prompt * 2 + 0.5M completion * 10 per million; reasoning is inside completion.
    expect(result.llm.cost).toEqual([
      { engine: "paid", currency: "EUR", promptTokens: 1_000_000, completionTokens: 500_000, cost: 7 },
    ]);
  });

  test("rows ride along with --detail full and --format html, not by default", async () => {
    const at = sqliteTs(Date.now() - HOUR);
    seedUsage([{ type: "search", at, query: "needle-query", metadata: { resultCount: 1 } }]);
    appendEvent({
      eventType: "llm_usage",
      metadata: { engine: "e", outcome: "success", durationMs: 5, promptTokens: 1 },
    });
    expect((await metrics()).result.rows).toBeUndefined();
    const full = (await metrics("--detail", "full")).result;
    expect(full.rows?.usage).toHaveLength(1);
    expect(full.rows?.usage[0]).toMatchObject({ eventType: "search", query: "needle-query", resultCount: 1 });
    expect(full.rows?.usage[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(full.rows?.llm).toHaveLength(1);
    const html = await runCliStatus(["metrics", "--format", "html"]);
    expect(html.status).toBe(0);
    expect(html.stdout).toContain("needle-query");
  });

  test("utility, outcomes and ref resolution read index.db and state.db", async () => {
    const index = openIndexDatabase(getDbPath());
    try {
      const entry = index.prepare(
        `INSERT INTO entries (item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, document_json)
         VALUES (?, ?, 'c', ?, 'a', 'skill', ?, '{}')`,
      );
      entry.run("main//skills/low", "main", "skills/low", "/x/low");
      entry.run("main//skills/high", "main", "skills/high", "/x/high");
      entry.run("main//skills/idle", "main", "skills/idle", "/x/idle");
      const score = index.prepare(
        "INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate) SELECT id, ?, ?, ?, ? FROM entries WHERE item_ref = ?",
      );
      score.run(0.1, 1, 4, 0.25, "main//skills/low");
      score.run(0.9, 7, 8, 0.75, "main//skills/high");
    } finally {
      closeDatabase(index);
    }
    const state = openStateDatabase();
    try {
      state
        .prepare(
          `INSERT INTO asset_outcome (asset_ref, retrieval_count, negative_feedback_count, accepted_change_count, outcome_score)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("main//skills/low", 5, 2, 0, -0.5);
    } finally {
      state.close();
    }

    const { result } = await metrics();
    expect(result.utility.count).toBe(2);
    expect(result.utility.neverUsed).toBe(1);
    expect(result.utility.lowest[0]).toMatchObject({ ref: "main//skills/low", utility: 0.1, showCount: 1 });
    expect(result.utility.highest[0]).toMatchObject({ ref: "main//skills/high", selectRate: 0.75 });
    expect(result.outcomes.lowestOutcome).toEqual([
      {
        ref: "main//skills/low",
        outcomeScore: -0.5,
        retrievalCount: 5,
        negativeFeedbackCount: 2,
        acceptedChangeCount: 0,
      },
    ]);
    expect(result.notes.some((note) => note.includes("index.db"))).toBe(false);

    // A short ref resolves through the index to the durable one.
    const byRef = await metrics("--ref", "skills/high");
    expect(byRef.status).toBe(0);
    expect(byRef.result.filters.ref).toBe("main//skills/high");
    expect(byRef.result.utility.count).toBe(1);
    expect(byRef.result.outcomes.lowestOutcome).toEqual([]);
  });

  test("tasks, proposals, workflows and index runs come from state.db", async () => {
    const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
    const state = openStateDatabase();
    try {
      const task = state.prepare(
        "INSERT INTO task_history (task_id, status, started_at, completed_at, metadata_json) VALUES (?, ?, ?, ?, ?)",
      );
      task.run("t-ok", "completed", iso(3), iso(3), JSON.stringify({ durationMs: 1000, detail: null }));
      task.run("t-bad", "failed", iso(2), iso(2), JSON.stringify({ durationMs: 500, detail: null }));
      const proposal = state.prepare(
        "INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at) VALUES (?, '/s', ?, ?, 'reflect', ?, ?)",
      );
      proposal.run("p1", "main//skills/a", "pending", iso(5), iso(5));
      proposal.run("p2", "main//skills/b", "accepted", iso(5), iso(1));
      state
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_ref, workflow_title, status, created_at, updated_at)
           VALUES ('r1', 'main//workflows/w', 'W', 'completed', ?, ?)`,
        )
        .run(iso(4), iso(4));
      state
        .prepare(
          `INSERT INTO workflow_run_unit_attempts
             (run_id, unit_id, attempt, dispatch_id, step_id, node_id, phase, model, input_hash, status, tokens, started_at, claim_holder, claim_expires_at)
           VALUES ('r1', 'u1', ?, ?, 's', 'n', 'unit', ?, 'h', 'completed', ?, ?, 'x', ?)`,
        )
        .run(1, "d1", "big", 300, iso(4), iso(4));
      state
        .prepare(
          `INSERT INTO workflow_run_unit_attempts
             (run_id, unit_id, attempt, dispatch_id, step_id, node_id, phase, model, input_hash, status, tokens, started_at, claim_holder, claim_expires_at)
           VALUES ('r1', 'u1', ?, ?, 's', 'n', 'unit', ?, 'h', 'completed', ?, ?, 'x', ?)`,
        )
        .run(2, "d2", "big", 200, iso(4), iso(4));
    } finally {
      state.close();
    }
    appendEvent({ eventType: "index_completed", metadata: { mode: "full", totalMs: 1200 } });
    appendEvent({ eventType: "index_completed", metadata: { mode: "incremental", totalMs: 400 } });

    const { result } = await metrics();
    expect(result.tasks).toMatchObject({ runs: 2, failed: 1, failRate: 0.5 });
    expect(result.tasks.byTask.map((t) => t.taskId)).toEqual(["t-bad", "t-ok"]);
    expect(result.proposals.byStatus).toEqual({ accepted: 1, pending: 1 });
    expect(result.workflows).toEqual({ runs: 1, byStatus: { completed: 1 }, tokens: 500, byModel: { big: 500 } });
    expect(result.index.runs).toBe(2);
    expect(result.index.medianMs).toBe(1200);
    expect(result.index.recent.map((run) => run.mode)).toEqual(["incremental", "full"]);
  });
});
