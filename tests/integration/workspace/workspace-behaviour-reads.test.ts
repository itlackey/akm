// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The read operations of `src/workspace` against a real sandbox stash (integration: opens state.db and index.db and
 * runs git). Ported from the retired `akm ui` server tests with the HTTP layer removed: each operation is called
 * directly, and a refusal is the `AkmError` the transport used to map to a status.
 *
 * What it pins: the shape of every read, that search matches `akmSearch`, that no result carries a planted secret,
 * and that a browse session leaves both databases byte-for-byte as they were.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Proposal } from "../../../src/commands/proposal/proposal-types";
import { createProposal } from "../../../src/commands/proposal/repository";
import { akmSearch } from "../../../src/commands/read/search";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { listStateProposals, upsertProposal } from "../../../src/storage/repositories/proposals-repository";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { activity, assets, bundles, config, proposals } from "../../../src/workspace";
import { weekOf } from "../../../src/workspace/derive";
import { DIFF_SIDE_MAX_CHARS } from "../../../src/workspace/readers";
import { runCliCapture } from "../../_helpers/cli";
import { makeConfig } from "../../_helpers/factories";
import { git } from "../../_helpers/git";
import { writeSandboxConfig } from "../../_helpers/sandbox";
import {
  countRows,
  ctx,
  dbSnapshot,
  expectAkmError,
  expectUsage,
  GUIDE,
  type Json,
  LESSON,
  NOTES_REWRITE,
  out,
  PLANTED,
  PLANTED_ENV_VALUE,
  PLANTED_SECRET_FILE,
  propose,
  seed,
  useSandbox,
} from "./workspace-behaviour-helpers";

useSandbox();

describe("reads", () => {
  test("meta", async () => {
    await seed();
    const meta = await out(activity.meta());
    expect(typeof meta.version).toBe("string");
    expect(meta.hostname).toBe(os.hostname());
    expect(["bun", "node"]).toContain(meta.runtime);
  });

  test("overview: health, metrics, last improve runs and canonical user usage", async () => {
    await seed();
    const overview = await out(activity.overview());
    expect(overview.errors).toBeUndefined();
    expect(overview.health.hardChecks.length).toBeGreaterThan(0);
    expect(overview.health.windows).toHaveLength(2);
    // The round-trip probe writes a row; a read-only run reports it skipped, which proved nothing (F9).
    const roundTrip = overview.health.hardChecks.find((c: { name: string }) => c.name === "state-db-round-trip");
    expect(roundTrip.message).toContain("skipped");
    expect(roundTrip.status).toBe("unknown");
    expect(overview.metrics.schemaVersion).toBeDefined();

    expect(overview.improveRuns).toHaveLength(1);
    expect(overview.improveRuns[0]).toMatchObject({
      id: "run-1",
      ok: true,
      strategy: "default",
      triage: { promoted: 2, rejected: 1 },
      sync: { committed: true },
      preRunSync: { skipped: true },
      modelCalls: { total: 5, failures: 1, byProcess: { reflect: { calls: 3, failures: 1 } } },
    });
    expect(overview.improveRuns[0].durationMs).toBeGreaterThan(0);

    expect(overview.usageByDay).toBeUndefined();
    const today = overview.metrics.usage.daily.at(-1);
    // User-attributed only: the improve-sourced search is not counted.
    expect(today).toMatchObject({ search: 1, show: 1, feedback: 2, curate: 0 });
    expect((await out(activity.retrievalTrend({ since: "30d" }))).daily.at(-1)).toMatchObject({
      searches: 1,
      zeroResults: 0,
      medianMs: null,
    });
    expect(overview.taskFailures).toEqual([]);
    expect(overview.metrics.rows).toBeUndefined();
  });

  test("improveRun reads one run by id with its recorded usage, errors and termination", async () => {
    await seed();
    const run = await out(activity.improveRun({ id: "run-1" }));
    expect(run).toMatchObject({
      id: "run-1",
      usage: [
        { process: "reflect", engine: "default", model: "chat-model", calls: 3, failures: 1, totalTokens: 1200 },
        { process: "triage.judgment", model: "chat-model", calls: 2 },
      ],
      noCalls: [{ process: "distill", reason: "no_signal" }],
      terminated: null,
      errors: { count: 1, shown: [{ ref: "memory:a", mode: "reflect-failed", error: "model timed out" }] },
    });
    const db = openStateDatabase();
    try {
      recordImproveRun(db, {
        id: "run-old",
        startedAt: "2020-01-01T00:00:00.000Z",
        completedAt: "2020-01-01T00:01:00.000Z",
        stashDir: ctx.storage.stashDir,
        dryRun: false,
        strategy: "default",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: false,
        result: {
          schemaVersion: 2,
          ok: false,
          dryRun: false,
          plannedRefs: [],
          scope: { mode: "all" },
          memorySummary: { eligible: 0, derived: 0 },
          strategy: "default",
          terminated: { reason: "SIGTERM", at: "2020-01-01T00:01:00.000Z", errorMessage: "stopped" },
        } as never,
      });
    } finally {
      db.close();
    }
    expect(await out(activity.improveRun({ id: "run-old" }))).toMatchObject({
      ok: false,
      usage: [],
      terminated: { reason: "SIGTERM", errorMessage: "stopped" },
    });
    await expectAkmError(() => activity.improveRun({ id: "nope" }), {
      kind: "not-found",
      code: "IMPROVE_RUN_NOT_FOUND",
    });
  });

  test("overview counts search summaries, not hits, and retains missing latency as unknown", async () => {
    await seed();
    const db = openStateDatabase();
    const today = new Date().toISOString().slice(0, 10);
    try {
      const insert = db.prepare(
        "INSERT INTO usage_events (event_type, query, entry_ref, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const at = `${today} 00:00:00`;
      insert.run("search", "empty result", null, JSON.stringify({ resultCount: 0, totalMs: 120 }), "user", at);
      insert.run("search", "empty result", null, JSON.stringify({ resultCount: 0 }), "user", at);
      insert.run("search", "found", null, JSON.stringify({ resultCount: 2, totalMs: 40 }), "user", at);
      for (const ref of ["stash//knowledge/guide", "stash//knowledge/notes"]) {
        insert.run("search", "found", ref, JSON.stringify({ resultCount: 2, totalMs: 40 }), "user", at);
        insert.run("curate", "found", ref, null, "user", at);
      }
      insert.run("curate", "found", null, null, "user", at);
      insert.run("search", "internal", null, JSON.stringify({ resultCount: 0, totalMs: 900 }), "task", at);
    } finally {
      db.close();
    }
    const overview = await out(activity.overview({ metricsSince: "7d" }));
    expect(overview.metrics.usage.daily.at(-1)).toMatchObject({ search: 4, curate: 1 });
    expect((await out(activity.retrievalTrend({ since: "7d" }))).daily).toEqual([
      {
        date: today,
        searches: 4,
        zeroResults: 2,
        medianMs: 120,
        partial: true,
      },
    ]);
  });

  test("the dashboard reads answer with their documented shape, and a missing ref is a usage error", async () => {
    await seed();
    const accepted = propose("lessons/rg");
    await proposals.accept({ id: accepted });
    propose("lessons/two");

    const health = await out(activity.health());
    expect(health).toMatchObject({ hardChecks: expect.any(Array), advisories: expect.any(Array) });

    const pulse = await out(activity.pulse());
    expect(pulse.tiles.foundNothing).toMatchObject({ n: expect.any(Number) });
    expect(pulse.tiles.foundNothing.usual.state).toBe("low-data");
    expect(pulse.improveLine).toMatchObject({ weeks: 4, proposed: 2, accepted: 1, waiting: 1 });
    expect(pulse.attention.pending.count).toBe(1);

    const impact = await out(activity.improveImpact());
    expect(impact.available).toBe(true);
    expect(impact.summary.kept).toBe(1);
    expect(impact.outcomes.map((o: { source: string }) => o.source)).toEqual(["reflect"]);
    expect(impact.reviewFlow.at(-1)).toMatchObject({ created: 2, decided: 1, waiting: 1 });
    expect(impact.changedAssets[0]).toMatchObject({ ref: "stash//lessons/rg", complete: false });
    // Accepted through the workspace, so the decision is the person's.
    expect(impact.judgeAndYou).toEqual({ you: { accepted: 1, rejected: 0, reverted: 0 } });

    const misses = await out(assets.searchMisses());
    expect(misses).toMatchObject({ searches: expect.any(Number), misses: expect.any(Array) });

    const improve = await out(assets.improvement({ ref: "stash//lessons/rg" }));
    expect(improve.proposals).toHaveLength(1);
    expect(improve.usageByWeek.length).toBeGreaterThan(10);
    await expectUsage(() => assets.improvement({ ref: "" }));
    // A chart's drill-down: the proposals decided in a week, or of one class.
    const week = impact.weeks.at(-1);
    expect((await out(proposals.list({ status: "recent", week }))).proposals.map((p: { id: string }) => p.id)).toEqual([
      accepted,
    ]);
    expect((await out(proposals.list({ status: "recent", class: "rejected" }))).proposals).toHaveLength(0);
    await expectUsage(() => proposals.list({ status: "recent", class: "nope" }));
  });

  test("a reverted proposal is dated and attributed by its accept, and still counts as accepted", async () => {
    await seed();
    const id = propose("knowledge/notes", NOTES_REWRITE);
    await proposals.accept({ id });
    // Move the accept three weeks back, so the accept and the revert fall in different weeks.
    const day = 86_400_000;
    const acceptedAt = new Date(Date.now() - 21 * day).toISOString();
    const db = openStateDatabase();
    try {
      const accepted = listStateProposals(db, { stashDir: ctx.storage.stashDir, status: "accepted" })[0] as Proposal;
      upsertProposal(
        db,
        {
          ...accepted,
          createdAt: new Date(Date.now() - 22 * day).toISOString(),
          updatedAt: acceptedAt,
          acceptedAt,
          review: { ...accepted.review, decidedAt: acceptedAt },
        } as Proposal,
        ctx.storage.stashDir,
      );
    } finally {
      db.close();
    }
    await proposals.revert({ id });

    const impact = await out(activity.improveImpact());
    expect(impact.changedAssets[0]).toMatchObject({ outcome: "reverted", decidedAt: acceptedAt });
    const reverted = Object.fromEntries(impact.outcomes[0].weeks.map((w: Json) => [w.week, w.reverted]));
    expect(reverted[weekOf(acceptedAt)]).toBe(1);
    expect(reverted[impact.weeks.at(-1)]).toBe(0);
    // Waiting from creation until the accept, not until the revert.
    expect(impact.reviewFlow.at(-1)).toMatchObject({ waiting: 0 });
    expect(impact.reviewFlow.find((w: Json) => w.week === weekOf(acceptedAt))).toMatchObject({ decided: 1 });
    // The revert kept who accepted: a person, not "unknown".
    expect(impact.judgeAndYou).toEqual({ you: { accepted: 0, rejected: 0, reverted: 1 } });
    expect(impact.harm.some((item: Json) => item.kind === "reverted" && item.proposalId === id)).toBe(true);
    // The summary counts the reverts the harm log lists.
    expect(impact.summary.reverted).toBe(1);
    // The list that drills into the week shows the accept time, the date that put it in that week.
    const drilled = await out(proposals.list({ status: "recent", week: weekOf(acceptedAt), class: "reverted" }));
    expect(drilled.proposals[0]).toMatchObject({ id, decidedAt: acceptedAt });

    // Accepted first, so it counts as accepted, and "since reverted" is a part of that figure.
    const pulse = await out(activity.pulse());
    expect(pulse.improveLine).toMatchObject({
      proposed: 1,
      accepted: 1,
      acceptedThenReverted: 1,
      rejected: 0,
      waiting: 0,
    });
    expect(pulse.attention.harm.reverted).toBe(1);
  });

  test("an unreadable proposals table degrades the impact page's proposal cards, not the page", async () => {
    await seed();
    const db = openStateDatabase();
    try {
      db.exec("DROP TABLE proposals");
    } finally {
      db.close();
    }
    const impact = await out(activity.improveImpact());
    expect(impact.available).toBe(true);
    expect(Object.keys(impact.errors)).toEqual(["proposals"]);
    expect(impact.outcomes).toEqual([]);
    expect(impact.cost).toHaveLength(impact.weeks.length);
    expect(impact.library).toHaveLength(impact.weeks.length);
  });

  test("retrievalTrend returns the per-day search series for the requested window", async () => {
    await seed();
    const db = openStateDatabase();
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    try {
      const insert = db.prepare(
        "INSERT INTO usage_events (event_type, query, entry_ref, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("search", "old miss", null, JSON.stringify({ resultCount: 0 }), "user", `${day(60)} 00:00:00`);
      insert.run("search", "old hit", null, JSON.stringify({ resultCount: 3 }), "user", `${day(60)} 00:00:00`);
      insert.run("search", "new hit", null, JSON.stringify({ resultCount: 1 }), "user", `${day(1)} 00:00:00`);
    } finally {
      db.close();
    }
    const trend = await out(activity.retrievalTrend());
    // Seeding may record a search of its own today; only the planted days are compared.
    const planted = trend.daily
      .filter((d: { date: string }) => d.date === day(60) || d.date === day(1))
      .map((d: { date: string; searches: number; zeroResults: number }) => [d.date, d.searches, d.zeroResults]);
    expect(planted).toEqual([
      [day(60), 2, 1],
      [day(1), 1, 0],
    ]);
    const short = await out(activity.retrievalTrend({ since: "30d" }));
    expect(short.daily.map((d: { date: string }) => d.date)).not.toContain(day(60));
    await expectUsage(() => activity.retrievalTrend({ since: "nonsense" }));
  });

  test("task failure ranking includes rare failures beyond busiest 20; history is bounded, read-only and truthful", async () => {
    await seed();
    const db = openStateDatabase();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    try {
      for (let i = 0; i < 21; i++) {
        for (let n = 0; n < 2; n++)
          upsertTaskHistory(db, {
            task_id: `busy-${i}`,
            status: "completed",
            started_at: new Date(Date.now() - 120_000 - n * 1000).toISOString(),
            completed_at: startedAt,
            failed_at: null,
            log_path: null,
            target_kind: null,
            target_ref: null,
            metadata_json: JSON.stringify({ durationMs: 10 }),
          });
      }
      upsertTaskHistory(db, {
        task_id: "rare-failure",
        status: "failed",
        started_at: startedAt,
        completed_at: null,
        failed_at: startedAt,
        log_path: "/must-not-read/task.log",
        target_kind: null,
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 50, detail: { reason: "timeout", error: "Timed out" } }),
      });
      upsertTaskHistory(db, {
        task_id: "unknown-detail",
        status: "active",
        started_at: startedAt,
        completed_at: null,
        failed_at: null,
        log_path: null,
        target_kind: null,
        target_ref: null,
        metadata_json: "{}",
      });
    } finally {
      db.close();
    }
    const before = dbSnapshot(getStateDbPath());
    const overview = await out(activity.overview());
    expect(overview.metrics.tasks.byTask.some((t: { taskId: string }) => t.taskId === "rare-failure")).toBe(false);
    expect(overview.taskFailures).toEqual([{ taskId: "rare-failure", runs: 1, failed: 1, medianMs: 50 }]);
    const detail = await out(activity.taskHistory({ taskId: "rare-failure", limit: 1 }));
    expect(detail).toMatchObject({
      available: true,
      totalCount: 1,
      count: 1,
      runs: [{ status: "failed", durationMs: 50, detail: { reason: "timeout", error: "Timed out" } }],
    });
    expect(detail.runs[0].logPath).toBeUndefined();
    expect((await out(activity.taskHistory({ taskId: "unknown-detail" }))).runs[0]).toMatchObject({
      status: "active",
      durationMs: null,
      detail: null,
    });
    expect(
      (await out(activity.taskHistory({ taskId: "unknown-detail", since: String(Date.now() - 1000) }))).count,
    ).toBe(0);
    await expectUsage(() => activity.taskHistory({}));
    await expectUsage(() => activity.taskHistory({ taskId: "x", since: "not-a-date" }));
    expect(dbSnapshot(getStateDbPath())).toBe(before);
  });

  test("proposal counts and age/source filters use the whole queue and respect reopening", async () => {
    await seed();
    const original = createProposal(ctx.storage.stashDir, {
      ref: "lessons/rg",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: LESSON, frontmatter: { description: "Use ripgrep" } },
    });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const week = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const db = openStateDatabase();
    try {
      for (let i = 0; i < 201; i++)
        upsertProposal(db, { ...original, id: `old-${i}`, createdAt: old, updatedAt: old }, ctx.storage.stashDir);
      upsertProposal(
        db,
        { ...original, id: "reopened", createdAt: old, reviewHistory: [{ reopenedAt: now }] },
        ctx.storage.stashDir,
      );
      upsertProposal(db, { ...original, id: "week", source: "feedback", createdAt: week }, ctx.storage.stashDir);
      upsertProposal(db, { ...original, id: "unknown", createdAt: "invalid" }, ctx.storage.stashDir);
    } finally {
      db.close();
    }
    const all = await out(proposals.list({ limit: 200 }));
    expect(all.totalCount).toBe(205);
    expect(all.fullCount).toBe(205);
    expect(all.proposals).toHaveLength(200);
    expect(all.backlog).toEqual([
      { source: "feedback", underDay: 0, underWeek: 1, older: 0, unknown: 0 },
      { source: "reflect", underDay: 2, underWeek: 0, older: 201, unknown: 1 },
    ]);
    const filtered = await out(proposals.list({ source: "reflect", age: "underDay", limit: 1 }));
    expect(filtered).toMatchObject({ totalCount: 2, fullCount: 205, bySource: { reflect: 204, feedback: 1 } });
    expect(filtered.proposals).toHaveLength(1);
    expect((await out(proposals.list({ age: "unknown" }))).proposals[0].id).toBe("unknown");
    await expectUsage(() => proposals.list({ age: "invalid" }));
  });

  test("pulse's pending count is this stash's whole queue, not windowed, like the proposals list", async () => {
    await seed();
    const original = createProposal(ctx.storage.stashDir, {
      ref: "lessons/rg",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: LESSON, frontmatter: { description: "Use ripgrep" } },
    });
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const db = openStateDatabase();
    try {
      for (let i = 0; i < 3; i++)
        upsertProposal(db, { ...original, id: `old-${i}`, createdAt: old, updatedAt: old }, ctx.storage.stashDir);
      upsertProposal(db, { ...original, id: "elsewhere", createdAt: old, updatedAt: old }, "/other/stash");
    } finally {
      db.close();
    }
    const pulse = await out(activity.pulse());
    const list = await out(proposals.list({ limit: 200 }));
    expect(pulse.attention.pending.count).toBe(list.totalCount);
    expect(pulse.attention.pending.count).toBe(4);
  });

  test("task failures rank in the order of the bars: failed runs over runs, then failures", async () => {
    await seed();
    const db = openStateDatabase();
    const base = Date.now() - 60_000;
    const run = (taskId: string, status: string, n: number) =>
      upsertTaskHistory(db, {
        task_id: taskId,
        status,
        started_at: new Date(base - n * 1000).toISOString(),
        completed_at: status === "completed" ? new Date(base).toISOString() : null,
        failed_at: status === "failed" ? new Date(base).toISOString() : null,
        log_path: null,
        target_kind: null,
        target_ref: null,
        metadata_json: "{}",
      });
    try {
      // busy: 3 of 10 failed (0.3); flaky: 3 of 5 (0.6); few: 2 of 2 (1.0); clean: no failures, so not listed.
      for (let n = 0; n < 10; n++) run("busy", n < 3 ? "failed" : "completed", n);
      for (let n = 0; n < 5; n++) run("flaky", n < 3 ? "failed" : "completed", n);
      for (let n = 0; n < 2; n++) run("few", "failed", n);
      run("clean", "completed", 0);
    } finally {
      db.close();
    }
    const overview = await out(activity.overview());
    expect(overview.taskFailures.map((t: { taskId: string }) => t.taskId)).toEqual(["few", "flaky", "busy"]);
  });

  test("bundles: cards with git status and asset counts, plus the index state", async () => {
    await seed();
    const listed = await out(bundles.list());
    expect(listed.defaultBundle).toBe("stash");
    expect(listed.bundles).toHaveLength(1);
    const card = listed.bundles[0];
    expect(card).toMatchObject({ name: "stash", kind: "filesystem", default: true, writable: true, exists: true });
    expect(card.byType.knowledge).toBeGreaterThanOrEqual(2);
    expect(card.git).toMatchObject({ upstream: null, ahead: null, behind: null });
    expect(card.git.branch).toBeTruthy();
    expect(card.git.lastCommit.subject).toStartWith("akm save");
    expect(listed.index.entryCount).toBeGreaterThanOrEqual(2);
    expect(listed.index).toMatchObject({ hasEmbeddings: false, embeddingCount: 0 });
    expect(listed.index.lastBuiltAt).toBeTruthy();
  });

  test("bundles reports ahead and behind against the remote-tracking branch without fetching", async () => {
    await seed();
    const remote = fs.mkdtempSync(path.join(ctx.storage.root, "remote-"));
    git(remote, ["init", "-q", "--bare"]);
    const stash = ctx.storage.stashDir;
    git(stash, ["remote", "add", "origin", remote]);
    git(stash, ["push", "-q", "-u", "origin", "HEAD"]);
    fs.writeFileSync(path.join(stash, "knowledge", "ahead.md"), "# ahead\n");
    git(stash, ["add", "knowledge"]);
    git(stash, ["commit", "-q", "-m", "local only"]);
    const fetchHead = path.join(stash, ".git", "FETCH_HEAD");
    const before = fs.existsSync(fetchHead);

    const { git: status } = (await out(bundles.list())).bundles[0];

    expect(status).toMatchObject({ upstream: expect.stringContaining("origin/"), ahead: 1, behind: 0 });
    expect(status.lastCommit.subject).toBe("local only");
    expect(fs.existsSync(fetchHead)).toBe(before);
  });

  test("config: effective config with provenance, connections, and no secret values", async () => {
    await seed();
    const view = await out(config.get());
    expect(view.exists).toBe(true);
    const sources = Object.fromEntries(view.entries.map((e: { path: string; source: string }) => [e.path, e.source]));
    expect(sources.semanticSearchMode).toBe("file");
    expect(sources["connections.default.models.fast"]).toBe("file");
    expect(view.engines).toBeUndefined();
    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]).toMatchObject({ name: "default", models: { fast: "chat-model" } });
    expect(view.connections[0].kind).toBeUndefined();
    expect(view.connections[0].endpoint).toContain("token=%5Bredacted%5D");
    expect(view.connections[0].apiKey).toBeUndefined();
    expect(view.harnesses).toEqual([]);
    expect(view.config.someToken).toBe("[redacted]");
  });

  test("config: harnesses are listed by name with their own keys", async () => {
    await seed();
    const current = loadConfig();
    writeSandboxConfig({
      ...current,
      harnesses: {
        default: { platform: "claude" },
        codex: {},
        "claude-work": { platform: "claude", bin: "/opt/claude-work/bin/claude" },
      },
    });
    resetConfigCache();
    const { harnesses } = await out(config.get());
    expect(harnesses).toEqual([
      { name: "default", platform: "claude" },
      { name: "codex" },
      { name: "claude-work", platform: "claude", bin: "/opt/claude-work/bin/claude" },
    ]);
  });

  test("proposals list and get", async () => {
    await seed();
    const created = createProposal(ctx.storage.stashDir, {
      ref: "lessons/rg",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: LESSON, frontmatter: { description: "Use ripgrep" } },
    });

    const pending = await out(proposals.list({ status: "pending" }));
    expect(pending).toMatchObject({ status: "pending", totalCount: 1, bySource: { reflect: 1 } });
    expect(pending.proposals[0]).toMatchObject({
      id: created.id,
      source: "reflect",
      ref: "stash//lessons/rg",
      status: "pending",
    });
    expect(pending.proposals[0].waitingSince).toBeTruthy();

    expect((await out(proposals.list({ status: "recent" }))).totalCount).toBe(0);

    const detail = await out(proposals.get({ id: created.id }));
    expect(detail.proposal).toMatchObject({ id: created.id, ref: "stash//lessons/rg" });
    expect(detail.proposal.backupContent).toBeUndefined();
    expect(detail.proposal.changes).toEqual([{ op: expect.any(String), path: expect.any(String) }]);
    expect(detail.validation).toMatchObject({ ok: true });
    expect(detail.diffError).toBeNull();
    expect(detail.diff.isNew).toBe(true);
    expect(detail.diff.unified).toContain("Prefer rg over grep.");
    // A new asset has no earlier text; the proposed text comes back whole.
    expect(detail.diff).toMatchObject({ before: null, truncated: false, redacted: false });
    expect(detail.diff.after).toContain("Prefer rg over grep.");
    // A ref resolves to its newest pending proposal, like `akm proposal show`.
    expect((await out(proposals.get({ id: "stash//lessons/rg" }))).proposal.id).toBe(created.id);
    // An id prefix resolves like `akm proposal show`.
    expect((await out(proposals.get({ id: created.id.slice(0, 8) }))).proposal.id).toBe(created.id);

    await expectAkmError(() => proposals.get({ id: "does-not-exist" }), {
      kind: "not-found",
      code: "PROPOSAL_NOT_FOUND",
    });
    await expectUsage(() => proposals.list({ status: "bogus" }));
  });

  test("a proposal returns both sides of an update, and nothing for an env or secret target", async () => {
    await seed();
    const proposed = GUIDE.replace("description: Deploy guide\n", "description: Deploy guide\nwhen_to_use: Shipping\n");
    const update = createProposal(ctx.storage.stashDir, {
      ref: "knowledge/guide",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: proposed, frontmatter: { when_to_use: "Shipping" } },
    });
    const envProposal = createProposal(ctx.storage.stashDir, {
      ref: "env/prod",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: "API_TOKEN=proposed-env-value-0006\n" },
    });
    const secretProposal = createProposal(ctx.storage.stashDir, {
      ref: "secrets/deploy-key",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: "proposed-secret-value-0007" },
    });
    const stateBefore = dbSnapshot(getStateDbPath());

    const detail = await out(proposals.get({ id: update.id }));
    expect(detail.diffError).toBeNull();
    expect(detail.diff).toMatchObject({ isNew: false, before: GUIDE, truncated: false, redacted: false });
    // The stored proposal is the payload with akm's frontmatter normalisation, so `after` is what accept would write.
    expect(detail.diff.after).toContain("when_to_use: Shipping");
    expect(detail.diff.after).toContain("Run the deploy script.");
    expect(detail.diff.unified).toContain("+when_to_use: Shipping");

    for (const [id, leaked] of [
      [envProposal.id, ["proposed-env-value-0006", PLANTED_ENV_VALUE]],
      [secretProposal.id, ["proposed-secret-value-0007", PLANTED_SECRET_FILE]],
    ] as const) {
      const sensitive = await out(proposals.get({ id }));
      expect(sensitive.diff).toMatchObject({ before: null, after: null, redacted: true, truncated: false });
      const text = JSON.stringify(sensitive);
      for (const value of leaked) expect(text).not.toContain(value);
    }
    // Reading wrote nothing.
    expect(dbSnapshot(getStateDbPath())).toBe(stateBefore);
  });

  test("a proposal cuts a very large side and says so", async () => {
    await seed();
    const huge = `---\ndescription: Big\n---\n${"x".repeat(DIFF_SIDE_MAX_CHARS + 10)}\n`;
    const created = createProposal(ctx.storage.stashDir, {
      ref: "knowledge/big",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: ctx.storage.stashDir },
      payload: { content: huge },
    });
    const detail = await out(proposals.get({ id: created.id }));
    expect(detail.diff.truncated).toBe(true);
    expect(detail.diff.after).toHaveLength(DIFF_SIDE_MAX_CHARS);
    expect(detail.diff.unified).toContain("xxxx");
  });

  test("recentChanges: recent commits of the write-target stash, classified by origin", async () => {
    await seed();
    const changes = await out(proposals.recentChanges({ limit: 10 }));
    expect(changes).toMatchObject({ bundle: "stash", git: true });
    const origins = changes.commits.map((c: { origin: string }) => c.origin);
    expect(origins.slice(0, 3)).toEqual(["sync", "accept", "improve-sync"]);
    expect(changes.commits[0]).toMatchObject({ subject: expect.stringContaining("akm save"), author: "akm-test" });
    expect(changes.commits[0].paths).toEqual(["knowledge/more.md"]);
    expect((await out(proposals.recentChanges({ limit: 1 }))).commits).toHaveLength(1);
  });

  test("search returns what akmSearch returns, with bundle and type filters", async () => {
    await seed();
    const viaOp = await out(assets.search({ q: "deploy", limit: 10 }));
    const direct = await akmSearch({ query: "deploy", limit: 10, readOnly: true });
    expect(viaOp.hits.map((h: { ref: string }) => h.ref)).toEqual(direct.hits.map((h) => (h as { ref: string }).ref));
    expect(viaOp.hits.length).toBeGreaterThanOrEqual(2);

    // ...and the same refs `akm search` prints.
    const cli = await runCliCapture(["search", "deploy", "--limit", "10", "--format", "json"]);
    const cliRefs = (JSON.parse(cli.stdout) as { hits: Array<{ ref: string }> }).hits.map((h) => h.ref);
    expect(viaOp.hits.map((h: { ref: string }) => h.ref)).toEqual(cliRefs);

    // A blank scope value is omitted, not "without the key".
    const blank = await out(assets.search({ q: "deploy", limit: 10, scope: { channel: "" } }));
    expect(blank.hits.map((h: { ref: string }) => h.ref)).toEqual(viaOp.hits.map((h: { ref: string }) => h.ref));

    // A non-string value is omitted too, never thrown on.
    const odd = await out(assets.search({ q: "deploy", limit: 10, scope: { channel: 5, user: [null, " "] } as never }));
    expect(odd.hits.map((h: { ref: string }) => h.ref)).toEqual(viaOp.hits.map((h: { ref: string }) => h.ref));

    const typed = await out(assets.search({ q: "deploy", type: "knowledge" }));
    expect(typed.hits.every((h: { type: string }) => h.type === "knowledge")).toBe(true);
    const named = await out(assets.search({ q: "deploy", bundle: "stash" }));
    expect(named.hits.length).toBeGreaterThan(0);
    await expectUsage(() => assets.search({ q: "deploy", bundle: "nope" }));
  });

  test("show returns what akm show returns, plus feedback counts and history", async () => {
    await seed();
    const result = await out(assets.show({ ref: "knowledge/guide" }));
    expect(result.redacted).toBe(false);
    expect(result.durableRef).toBe("stash//knowledge/guide");
    expect(result.asset).toMatchObject({ type: "knowledge", name: "guide" });
    expect(result.asset.content).toContain("Run the deploy script.");
    expect(result.feedback.counts).toEqual({ positive: 1, negative: 1 });
    expect(result.feedback.history).toHaveLength(2);
    expect(result.feedback.history.find((h: { signal: string }) => h.signal === "positive").reason).toBe("clear");

    await expectUsage(() => assets.show({ ref: "" }));
    await expectAkmError(() => assets.show({ ref: "knowledge/absent" }), { kind: "not-found" });
  });
});

describe("secrets and read-only guarantees", () => {
  /** Every read the browse session makes; each settles to the text a host would hand its client. */
  const READS: Array<[string, () => unknown]> = [
    ["meta", () => activity.meta()],
    ["overview", () => activity.overview()],
    ["task history", () => activity.taskHistory({ taskId: "missing" })],
    ["bundles", () => bundles.list()],
    ["config", () => config.get()],
    ["proposals pending", () => proposals.list({ status: "pending" })],
    ["proposals recent", () => proposals.list({ status: "recent" })],
    ["changes", () => proposals.recentChanges()],
    ["search deploy", () => assets.search({ q: "deploy" })],
    ["search prod", () => assets.search({ q: "prod" })],
    ["search deploy-key", () => assets.search({ q: "deploy-key" })],
    ["show guide", () => assets.show({ ref: "knowledge/guide" })],
    ["show env", () => assets.show({ ref: "env/prod" })],
    ["show secret", () => assets.show({ ref: "secrets/deploy-key" })],
    ["show env with bundle", () => assets.show({ ref: "stash//env/prod" })],
  ];

  /** The result, or the error, as the text a client would see. */
  async function settle(read: () => unknown): Promise<string> {
    try {
      return JSON.stringify(await out(read() as Promise<Json>));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  test("no result carries a planted config, env or secret value; env and secret assets are stubs", async () => {
    await seed();
    for (const [name, read] of READS) {
      const text = await settle(read);
      for (const planted of PLANTED) expect(`${name} ${text}`).not.toContain(planted);
    }
    for (const ref of ["env/prod", "secrets/deploy-key"]) {
      const stub = await out(assets.show({ ref }));
      expect(stub).toMatchObject({ redacted: true, ref });
      expect(stub.asset).toBeUndefined();
    }
  });

  test("a browse session writes no usage events and leaves state.db and index.db unchanged", async () => {
    await seed();
    const before = {
      usage: countRows("usage_events"),
      events: countRows("events"),
      state: dbSnapshot(getStateDbPath()),
      index: dbSnapshot(getDbPath()),
    };

    for (const [, read] of READS) await settle(read);
    await settle(() => assets.search({ q: "deploy", type: "knowledge" }));
    await settle(() => assets.show({ ref: "knowledge/notes" }));
    await settle(() => activity.overview({ probe: false }));

    expect(countRows("usage_events")).toBe(before.usage);
    expect(countRows("events")).toBe(before.events);
    expect(dbSnapshot(getStateDbPath())).toBe(before.state);
    expect(dbSnapshot(getDbPath())).toBe(before.index);
  });

  test("with no state.db yet, the overview reports it and does not create it", async () => {
    const stash = ctx.storage.stashDir;
    writeSandboxConfig({ ...makeConfig(stash), semanticSearchMode: "off" });
    resetConfigCache();
    expect(fs.existsSync(getStateDbPath())).toBe(false);

    const overview = await out(activity.overview());
    expect(overview.health.status).toBe("fail");
    expect(overview.health.hardChecks[0].name).toBe("state-db-readable");
    // The remedy is one the person can take from the app, not only a CLI command (F8).
    expect(overview.health.hardChecks[0].message).toContain("Index the library");
    expect(overview.improveRuns).toEqual([]);
    expect(await out(proposals.list())).toMatchObject({ totalCount: 0 });
    expect(fs.existsSync(getStateDbPath())).toBe(false);
  });
});
