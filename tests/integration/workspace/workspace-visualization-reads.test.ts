// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workspace reads Desktop's visualizations draw from, against a real sandbox stash: the whole library as a graph,
 * every task run of a window, workflow runs and one run's trace, and the event stream. Each is read-only.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { activity, assets } from "../../../src/workspace";
import { ctx, dbSnapshot, expectUsage, out, seed, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();

describe("visualization reads", () => {
  test("graph: every asset of the enabled bundles, its declared links by index, and no protected asset", async () => {
    await seed();
    const stash = ctx.storage.stashDir;
    fs.writeFileSync(
      path.join(stash, "knowledge", "index-page.md"),
      "---\ndescription: A page of links\nxrefs:\n  - knowledge/guide\n  - knowledge/not-written\n---\n# Index page\n",
    );
    resetConfigCache();
    await akmIndex({ stashDir: stash });
    const before = dbSnapshot(getDbPath());
    const graph = await out(assets.graph());
    expect(graph.available).toBe(true);
    const refs: string[] = graph.nodes.ref;
    const at = (suffix: string) => refs.findIndex((ref) => ref.endsWith(suffix));
    expect(at("knowledge/guide")).toBeGreaterThanOrEqual(0);
    expect(refs.some((ref) => ref.includes("env/") || ref.includes("secrets/"))).toBe(false);
    for (const column of ["title", "type", "bundle", "shows", "searches", "lastUsedAt"])
      expect(graph.nodes[column]).toHaveLength(refs.length);
    expect(graph.types[graph.nodes.type[at("knowledge/guide")]]).toBe("knowledge");
    expect(graph.nodes.title[at("knowledge/index-page")]).toBe("Index page");
    // The one resolved link; the link to a page nobody wrote is left out.
    expect(
      graph.links.from.map((from: number, i: number) => [
        refs[from],
        refs[graph.links.to[i]],
        graph.kinds[graph.links.kind[i]],
      ]),
    ).toEqual([[refs[at("knowledge/index-page")], refs[at("knowledge/guide")], "xref"]]);
    // No embeddings in this sandbox: no positions by meaning.
    expect(graph.meaning).toBeNull();
    expect(dbSnapshot(getDbPath())).toBe(before);
  });

  test("taskRuns: every task's runs of the window, newest first, with what started each", async () => {
    await seed();
    const db = openStateDatabase();
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const row = (task: string, startedAt: string, status: string, metadata: object) => ({
      task_id: task,
      status,
      started_at: startedAt,
      completed_at: status === "failed" ? null : startedAt,
      failed_at: status === "failed" ? startedAt : null,
      log_path: null,
      target_kind: "workflow",
      target_ref: "workflows/nightly",
      metadata_json: JSON.stringify(metadata),
    });
    try {
      upsertTaskHistory(
        db,
        row("tasks/a", ago(10), "completed", { metadataVersion: 2, durationMs: 5, trigger: "schedule" }),
      );
      upsertTaskHistory(db, row("tasks/b", ago(5), "failed", { metadataVersion: 2, durationMs: 7, trigger: "manual" }));
      upsertTaskHistory(db, row("tasks/a", ago(60 * 24 * 40), "completed", { durationMs: 1 }));
      upsertTaskHistory(db, row("tasks/c", ago(2), "completed", { durationMs: 1, trigger: "cron?" }));
    } finally {
      db.close();
    }
    const before = dbSnapshot(getStateDbPath());
    const result = await out(activity.taskRuns({ since: "30d" }));
    expect(result).toMatchObject({ available: true, truncated: false });
    expect(result.runs.map((run: { taskId: string; trigger: string | null }) => [run.taskId, run.trigger])).toEqual([
      ["tasks/c", null],
      ["tasks/b", "manual"],
      ["tasks/a", "schedule"],
    ]);
    expect(result.runs[1]).toMatchObject({
      status: "failed",
      durationMs: 7,
      targetKind: "workflow",
      targetRef: "workflows/nightly",
    });
    expect((await out(activity.taskHistory({ taskId: "tasks/a" }))).runs[0].trigger).toBe("schedule");
    await expectUsage(() => activity.taskRuns({ since: "not-a-date" }));
    expect(dbSnapshot(getStateDbPath())).toBe(before);
  });

  test("events: the window's rows from every source, oldest first, with the agent when recorded", async () => {
    await seed();
    const db = openStateDatabase();
    const at = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
    try {
      const insert = db.prepare(
        "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "show",
        null,
        "stash//knowledge/guide",
        null,
        JSON.stringify({ agent: { harness: "claude", session: "s-1" } }),
        "user",
        at(3),
      );
      insert.run("search", "deploy", null, null, JSON.stringify({ resultCount: 0 }), "improve", at(2));
    } finally {
      db.close();
    }
    const result = await out(activity.events({ since: "1h" }));
    // Oldest first: the two rows above come before the ones the seed wrote just now.
    const mine = result.events.slice(0, 2);
    expect(mine).toEqual([
      expect.objectContaining({
        eventType: "show",
        ref: "stash//knowledge/guide",
        source: "user",
        agent: { harness: "claude", session: "s-1" },
      }),
      expect.objectContaining({ eventType: "search", query: "deploy", source: "improve", resultCount: 0 }),
    ]);
    expect(mine[1].agent).toBeUndefined();
    await expectUsage(() => activity.events({ since: "1h", until: "2000-01-01T00:00:00Z" }));
  });

  test("workflowRuns and workflowRun: the run list, and one run's steps, units and attempts", async () => {
    await seed();
    const runId = "55555555-5555-4555-8555-555555555555";
    const now = new Date().toISOString();
    const db = openStateDatabase();
    try {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json,
           current_step_id, created_at, updated_at, agent_harness, agent_session_id)
         VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{"token":"x"}', 'work', ?, ?, 'claude', 's-9')`,
      ).run(runId, now, now);
    } finally {
      db.close();
    }
    await withWorkflowRunsRepo((repo) => {
      const reserve = () =>
        repo.reserveUnitAttempt({
          runId,
          unitId: "work:one",
          stepId: "work",
          nodeId: "work.unit",
          parentUnitId: null,
          phase: "unit",
          runner: "agent",
          engine: null,
          model: "deep",
          inputHash: "hash",
          now,
        }).attempt;
      const first = reserve();
      repo.finishUnitAttempt({
        runId,
        unitId: first.unit_id,
        attempt: first.attempt,
        dispatchId: first.dispatch_id,
        status: "failed",
        resultJson: JSON.stringify("timed out"),
        tokens: 3,
        failureReason: "timeout",
        sessionId: null,
        finishedAt: now,
      });
    });
    const list = await out(activity.workflowRuns({ since: "7d" }));
    expect(list.runs).toEqual([
      expect.objectContaining({
        id: runId,
        workflowRef: "workflows/demo",
        title: "Demo",
        status: "active",
        harness: "claude",
        session: "s-9",
      }),
    ]);
    const trace = await out(activity.workflowRun({ id: runId }));
    expect(trace.run.id).toBe(runId);
    expect(trace.run.params).toBeUndefined();
    expect(trace.units).toEqual([
      expect.objectContaining({
        unitId: "work:one",
        stepId: "work",
        status: "failed",
        failureReason: "timeout",
        attempts: [expect.objectContaining({ attempt: 1, status: "failed", tokens: 3, failureReason: "timeout" })],
      }),
    ]);
    await expectUsage(() => activity.workflowRun({ id: " " }));
  });
});
