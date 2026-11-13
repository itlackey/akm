// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workspace reads Desktop's visualizations draw from, against a real sandbox stash: the whole library as a graph,
 * every task run of a window, workflow runs and one run's trace, and the event stream. Each is read-only.
 */

import { Database } from "bun:sqlite";
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
import { makeConfig } from "../../_helpers/factories";
import { writeSandboxConfig } from "../../_helpers/sandbox";
import { ctx, dbSnapshot, expectAkmError, expectUsage, out, seed, useSandbox } from "./workspace-behaviour-helpers";

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
    for (const column of ["title", "type", "bundle", "belief", "shows", "searches"])
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
    expect(graph.nodes.lastUsedAt).toBeUndefined();
    // The page the dropped link was declared on: one unresolved link, none of its own.
    expect(graph.unresolvedLinks).toBe(1);
    expect(graph.note).toContain("No assets are embedded");
    expect(dbSnapshot(getDbPath())).toBe(before);
  });

  test("graph: bundles by size, empty and disabled bundles, dropped links, proposed entries, belief states, live use", async () => {
    await seed();
    const stash = ctx.storage.stashDir;
    const dir = (name: string, files: Record<string, string>) => {
      const root = path.join(ctx.storage.stashDir, "..", `bundle-${name}`);
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
      }
      fs.mkdirSync(root, { recursive: true });
      return root;
    };
    const small = dir("small", { "knowledge/solo.md": "# Solo\n" });
    const off = dir("off", { "knowledge/hidden.md": "# Hidden\n" });
    const blank = dir("blank", {});
    fs.writeFileSync(
      path.join(stash, "knowledge", "linker.md"),
      "---\ndescription: Links out\nxrefs:\n  - knowledge/guide\n  - knowledge/missing\n  - knowledge/linker\n  - off//knowledge/hidden\n  - env/prod\n---\n# Linker\n",
    );
    fs.writeFileSync(
      path.join(stash, "knowledge", "old.md"),
      "---\ndescription: Old\nbeliefState: superseded\n---\n# Old\n",
    );
    fs.writeFileSync(
      path.join(stash, "knowledge", "doubt.md"),
      "---\ndescription: Doubt\nbeliefState: contradicted\n---\n# Doubt\n",
    );
    fs.writeFileSync(
      path.join(stash, "knowledge", "draft.md"),
      "---\ndescription: Draft\nquality: proposed\n---\n# Draft\n",
    );
    writeSandboxConfig({
      ...makeConfig(stash),
      bundles: {
        small: { path: small },
        stash: { path: stash, writable: true },
        off: { path: off },
        blank: { path: blank },
      },
      semanticSearchMode: "off",
    } as never);
    resetConfigCache();
    await akmIndex({ stashDir: stash, full: true });
    // Disable `off` after indexing: its assets stay in the index but must not be drawn or linked.
    writeSandboxConfig({
      ...makeConfig(stash),
      bundles: {
        small: { path: small },
        stash: { path: stash, writable: true },
        off: { path: off, enabled: false },
        blank: { path: blank },
      },
      semanticSearchMode: "off",
    } as never);
    resetConfigCache();

    const graph = await out(assets.graph());
    const refs: string[] = graph.nodes.ref;
    const at = (ref: string) => refs.indexOf(ref);
    // Largest bundle first, and the node column follows it.
    expect(graph.bundles).toEqual(["stash", "small"]);
    expect(graph.nodes.bundle[at("small//knowledge/solo")]).toBe(1);
    expect(graph.nodes.bundle[at("stash//knowledge/guide")]).toBe(0);
    expect(graph.emptyBundles).toEqual(["blank"]);
    expect(graph.note).toContain("No assets in: blank");
    expect(refs.some((ref) => ref.startsWith("off//"))).toBe(false);
    expect(refs.some((ref) => ref.includes("draft"))).toBe(false);
    // Three declared links leave the map: a missing page, a disabled bundle and a hidden type; the self-link is not counted.
    expect(graph.unresolvedLinks).toBe(3);
    expect(graph.note).toContain("3 declared links are not drawn");
    const kinds = (ref: string) => graph.beliefs[graph.nodes.belief[at(ref)]];
    expect(kinds("stash//knowledge/old")).toBe("superseded");
    expect(kinds("stash//knowledge/doubt")).toBe("contradicted");
    expect(graph.nodes.belief[at("stash//knowledge/guide")]).toBe(-1);

    // Use is read live: an event recorded after indexing counts without re-indexing; a non-user source does not.
    const guide = at("stash//knowledge/guide");
    const before = graph.nodes.shows[guide];
    expect(graph.use.source).toBe("user");
    expect(Date.parse(graph.use.since)).toBeLessThan(Date.now());
    const state = openStateDatabase();
    try {
      const insert = state.prepare(
        "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)",
      );
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      insert.run("show", null, "stash//knowledge/guide", "user", now);
      insert.run("show", null, "stash//knowledge/guide", "improve", now);
      insert.run("search", "deploy", "stash//knowledge/guide", "user", now);
      insert.run("show", null, "stash//knowledge/guide", "user", "2000-01-01 00:00:00");
    } finally {
      state.close();
    }
    const live = await out(assets.graph());
    expect(live.nodes.shows[at("stash//knowledge/guide")]).toBe(before + 1);
    expect(live.nodes.searches[at("stash//knowledge/guide")]).toBe(graph.nodes.searches[guide] + 1);
  });

  test("graph: without state.db the use counts are zero and the note says so", async () => {
    await seed();
    fs.rmSync(getStateDbPath(), { force: true });
    fs.rmSync(`${getStateDbPath()}-wal`, { force: true });
    fs.rmSync(`${getStateDbPath()}-shm`, { force: true });
    const graph = await out(assets.graph());
    expect(graph.nodes.shows.every((n: number) => n === 0)).toBe(true);
    expect(graph.note).toContain("Use counts are zero");
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

  test("events and taskRuns keep the newest rows past the 20,000 cap and say they were cut", async () => {
    await seed();
    const db = openStateDatabase();
    const total = 20_005;
    try {
      const insert = db.prepare(
        "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES ('search', ?, NULL, NULL, '{}', 'user', ?)",
      );
      const task = db.prepare(
        "INSERT INTO task_history (task_id, status, started_at, completed_at, target_kind, target_ref, metadata_json) VALUES ('tasks/x', 'completed', ?, ?, NULL, NULL, '{}')",
      );
      db.transaction(() => {
        for (let i = 0; i < total; i++) {
          // Second-resolution, one row per second ending a minute ago; query numbers them oldest = 0.
          const at = new Date(Date.now() - 60_000 - (total - i) * 1000).toISOString();
          insert.run(`q${i}`, at.slice(0, 19).replace("T", " "));
          task.run(at, at);
        }
      })();
    } finally {
      db.close();
    }
    const events = await out(activity.events({ since: "30d" }));
    expect(events.truncated).toBe(true);
    expect(events.events).toHaveLength(20_000);
    const queries = events.events
      .map((e: { query?: string }) => e.query)
      .filter((q: string | undefined) => q?.startsWith("q"));
    expect(queries).toContain(`q${total - 1}`);
    expect(queries).not.toContain("q0");
    const runs = await out(activity.taskRuns({ since: "30d" }));
    expect(runs.truncated).toBe(true);
    expect(runs.runs).toHaveLength(20_000);
    expect(runs.runs[0].startedAt > runs.runs[19_999].startedAt).toBe(true);
  }, 60_000);

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

  test("workflow reads never create or migrate state.db: absent is unavailable, behind on migrations is untouched", async () => {
    const file = getStateDbPath();
    fs.rmSync(file, { force: true });
    expect(await out(activity.workflowRuns())).toMatchObject({ available: false, runs: [] });
    await expectAkmError(() => activity.workflowRun({ id: "any" }), { kind: "not-found", code: "WORKFLOW_NOT_FOUND" });
    expect(fs.existsSync(file)).toBe(false);
    // A database no migration has run on yet: read as unavailable, left exactly as it was.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    new Database(file).close();
    const before = fs.readFileSync(file);
    expect(await out(activity.workflowRuns())).toMatchObject({ available: false, runs: [] });
    await expectAkmError(() => activity.workflowRun({ id: "any" }), { kind: "not-found" });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
