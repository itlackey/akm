// INTEGRATION TEST — opens a real index.db (via akmIndex) and a real
// state.db (via openStateDatabase, directly, for seeding and assertions) to
// verify akm bundle rename's bulk rewrites across both databases plus the
// lockfile and config.

/**
 * D6 — `akm bundle rename <old> <new>`: moves the config bundles key,
 * defaultBundle/defaultWriteTarget, scheduler.enabled[].ref, the lockfile
 * entry, and the index/state rows this tool persisted under the old bundle
 * prefix; leaves bundle CONTENT refs alone and reports them; `--dry-run`
 * writes nothing; `show <new>//…` resolves while `show <old>//…` does not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Proposal } from "../../src/commands/proposal/proposal-types";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified as akmShow } from "../../src/commands/read/show";
import { akmTasksSync, type TasksSyncResult } from "../../src/commands/tasks/tasks";
import { renameBundle } from "../../src/core/bundle-rename";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { NotFoundError, UsageError } from "../../src/core/errors";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import {
  countFeedbackSignalsByRef,
  insertUsageEventStrict,
  renameUsageEventRefs,
} from "../../src/indexer/usage/usage-events";
import { readLockfile, upsertLockEntry } from "../../src/integrations/lockfile";
import type { Database } from "../../src/storage/database";
import { closeDatabase } from "../../src/storage/repositories/index-connection";
import {
  getAssetOutcome,
  renameAssetOutcomeRefs,
  upsertAssetOutcome,
} from "../../src/storage/repositories/outcome-repository";
import { renameProposalsBundleRef, upsertProposal } from "../../src/storage/repositories/proposals-repository";
import {
  getAssetSalience,
  renameAssetSalienceRefs,
  upsertAssetSalience,
} from "../../src/storage/repositories/salience-repository";
import { renameTaskHistoryTargetRefs, upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { renameWorkflowRunRefs } from "../../src/storage/repositories/workflow-runs-repository";
import { setSchedulerRefEnabled } from "../../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../../src/tasks/backends/cron";
import type { SchedulerBackend } from "../../src/tasks/backends/types";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { seedWorkflowRun } from "../_helpers/workflow";

/** In-memory `crontab -l`/`crontab -` stand-in, same shape as tests/tasks-sync.test.ts. */
function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
    write: (content: string): CronExecResult => {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

/** A real CRON_BACKEND wired to an in-memory crontab, so the rename's `akmTasksSync` call never touches the host's real crontab. */
function fakeCronBackend(exec: CronExec): SchedulerBackend {
  return CRON_BACKEND({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false,
  });
}

/** `renameBundle`'s deps for an applied (non-dry-run) rename: the real `akmTasksSync`, injected the way `bundle-cli.ts` injects it (`src/core` doesn't import `src/commands`). */
function renameDeps(backend: SchedulerBackend): {
  backend: SchedulerBackend;
  syncTasks: (newId: string, sched: SchedulerBackend) => Promise<TasksSyncResult>;
} {
  return { backend, syncTasks: (newId, sched) => akmTasksSync({ backend: sched }, newId) };
}

/** `deps` for a call expected to throw during validation, before `syncTasks` would ever run. */
const unreachableSyncTasks: { syncTasks: (newId: string, sched: SchedulerBackend) => Promise<TasksSyncResult> } = {
  syncTasks: () => {
    throw new Error("syncTasks should not run: validation should have thrown first");
  },
};

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function writeKnowledgeAsset(stashDir: string, name: string, content: string): void {
  const dir = path.join(stashDir, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

async function seedBundleWithOneEntry(): Promise<void> {
  writeKnowledgeAsset(storage.stashDir, "hello", "---\ndescription: hello doc\n---\n\n# Hello\n");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { original: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    defaultBundle: "original",
    defaultWriteTarget: "original",
  });
  await akmIndex({ stashDir: storage.stashDir });
}

function seedSalience(db: Database, ref: string, rankScore: number): void {
  upsertAssetSalience(db, ref, { encoding: 0.5, outcome: 0, retrieval: 0, rankScore });
}

function seedOutcome(db: Database, ref: string, outcomeScore: number): void {
  upsertAssetOutcome(db, {
    ref,
    lastRetrievedAt: 0,
    retrievalCount: 0,
    expectedRetrievalRate: 0,
    negativeFeedbackCount: 0,
    acceptedChangeCount: 0,
    outcomeScore,
    updatedAt: 0,
  });
}

function makeProposal(id: string, ref: string, targetSource: string): Proposal {
  const now = new Date().toISOString();
  return {
    id,
    ref,
    status: "pending",
    source: "manual",
    createdAt: now,
    updatedAt: now,
    payload: { content: `content for ${ref}` },
    changes: [{ path: `${ref}.md`, after: `content for ${ref}`, op: "create" }],
    proposedTarget: { source: targetSource, root: storage.stashDir },
  } as unknown as Proposal;
}

describe("akm bundle rename — validation", () => {
  test("rejects an unconfigured bundle", async () => {
    saveConfig({ semanticSearchMode: "off" });
    await expect(renameBundle("nope", "also-nope", {}, unreachableSyncTasks)).rejects.toThrow(NotFoundError);
  });

  test("rejects an illegal new name", async () => {
    await seedBundleWithOneEntry();
    await expect(renameBundle("original", "bad.name", {}, unreachableSyncTasks)).rejects.toThrow(UsageError);
    await expect(renameBundle("original", "bad.name", {}, unreachableSyncTasks)).rejects.toThrow(
      /not a legal bundle name/,
    );
  });

  test("rejects a new name already taken by a different bundle", async () => {
    await seedBundleWithOneEntry();
    const config = loadConfig();
    saveConfig({ ...config, bundles: { ...config.bundles, taken: { path: "/tmp/other" } } });
    await expect(renameBundle("original", "taken", {}, unreachableSyncTasks)).rejects.toThrow(/already exists/);
  });
});

describe("akm bundle rename — dry-run", () => {
  test("reports the plan and writes nothing", async () => {
    await seedBundleWithOneEntry();
    const configBefore = fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8");
    const backend = fakeCronBackend(memoryExec());

    const plan = await renameBundle("original", "renamed", { dryRun: true }, renameDeps(backend));

    expect(plan.applied).toBe(false);
    expect(plan.index.entries).toBe(1);
    expect(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8")).toBe(configBefore);
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["original"]);

    // show still resolves the OLD ref — nothing moved.
    const shown = await akmShow({ ref: "original//knowledge/hello" });
    expect(shown.ref).toBe("knowledge/hello");
  });
});

describe("akm bundle rename — applied", () => {
  test("moves config, index, lock, scheduler refs, and state rows; leaves and reports content refs", async () => {
    await seedBundleWithOneEntry();

    // A file in the bundle that still spells the ref out in prose, so the
    // rename must report it without touching it.
    writeKnowledgeAsset(
      storage.stashDir,
      "cross-ref",
      "---\ndescription: cross ref doc\n---\n\nSee `original//knowledge/hello` for details.\n",
    );
    await akmIndex({ stashDir: storage.stashDir });

    // A lock entry (as a managed install would carry).
    await upsertLockEntry({ id: "original", source: "git", ref: "https://example.test/repo.git" });

    // A scheduled ref naming the bundle, with the task file behind it.
    const tasksDir = path.join(storage.stashDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "foo.yml"),
      'version: 4\nrun: echo foo\nname: foo\nschedule:\n  - cron: "*/15 * * * *"\n',
      "utf8",
    );
    const configWithScheduler = loadConfig();
    saveConfig({
      ...configWithScheduler,
      scheduler: {
        enabled: ["original//tasks/foo"],
      },
    });

    // A pending proposal whose ref and proposedTarget.source name the bundle.
    const stateDb = openStateDatabase();
    try {
      upsertProposal(stateDb, makeProposal("p1", "original//knowledge/new-thing", "original"), storage.stashDir);
      upsertTaskHistory(stateDb, {
        task_id: "wf-run",
        status: "completed",
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
        failed_at: null,
        log_path: null,
        target_kind: "workflow",
        target_ref: "original//workflows/foo",
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 60_000, detail: null }),
      });
    } finally {
      closeDatabase(stateDb);
    }

    const backend = fakeCronBackend(memoryExec());
    const result = await renameBundle("original", "renamed", {}, renameDeps(backend));

    expect(result.applied).toBe(true);
    expect(result.taskSync?.ok).toBe(true);
    expect(result.index.entries).toBe(2);
    expect(result.config.defaultBundleChanges).toBe(true);
    expect(result.config.defaultWriteTargetChanges).toBe(true);
    expect(result.config.schedulerRefs).toEqual(["original//tasks/foo"]);
    expect(result.lock.present).toBe(true);
    expect(result.state.proposalRefs).toBe(1);
    expect(result.state.taskHistoryRefs).toBe(1);
    expect(result.contentRefs.some((f) => f.endsWith("cross-ref.md"))).toBe(true);

    // Config: bundle key, defaultBundle, defaultWriteTarget, scheduler ref.
    const configAfter = loadConfig();
    expect(Object.keys(configAfter.bundles ?? {})).toEqual(["renamed"]);
    expect(configAfter.defaultBundle).toBe("renamed");
    expect(configAfter.defaultWriteTarget).toBe("renamed");
    expect(configAfter.scheduler?.enabled?.[0]).toBe("renamed//tasks/foo");

    // Lockfile.
    expect(readLockfile().map((e) => e.id)).toEqual(["renamed"]);

    // Index: old ref gone, new ref resolves.
    await expect(akmShow({ ref: "renamed//knowledge/hello" })).resolves.toMatchObject({ ref: "knowledge/hello" });
    await expect(akmShow({ ref: "original//knowledge/hello" })).rejects.toThrow(NotFoundError);

    // Content itself was NOT rewritten — the cross-ref file still says "original//".
    const crossRefContent = fs.readFileSync(path.join(storage.stashDir, "knowledge", "cross-ref.md"), "utf8");
    expect(crossRefContent).toContain("original//knowledge/hello");

    // State.db rows.
    const readDb = openStateDatabase();
    try {
      const proposalRow = readDb.prepare("SELECT ref, metadata_json FROM proposals WHERE id = ?").get("p1") as {
        ref: string;
        metadata_json: string;
      };
      expect(proposalRow.ref).toBe("renamed//knowledge/new-thing");
      expect(JSON.parse(proposalRow.metadata_json).proposedTarget.source).toBe("renamed");

      const taskRow = readDb.prepare("SELECT target_ref FROM task_history WHERE task_id = ?").get("wf-run") as {
        target_ref: string;
      };
      expect(taskRow.target_ref).toBe("renamed//workflows/foo");
    } finally {
      closeDatabase(readDb);
    }
  });

  test("rewrites workflow_runs.workflow_ref and lists the active runs it affected (#1239)", async () => {
    await seedBundleWithOneEntry();
    const stateDb = openStateDatabase();
    try {
      seedWorkflowRun(stateDb, { runId: "run-active", steps: ["a"], workflowRef: "original//workflows/foo" });
      seedWorkflowRun(stateDb, { runId: "run-done", steps: ["a"], workflowRef: "original//workflows/foo" });
      seedWorkflowRun(stateDb, { runId: "run-blocked", steps: ["a"], workflowRef: "original//workflows/foo" });
      seedWorkflowRun(stateDb, { runId: "run-other", steps: ["a"], workflowRef: "other//workflows/foo" });
      stateDb.prepare("UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-done'").run();
      stateDb.prepare("UPDATE workflow_runs SET status = 'blocked' WHERE id = 'run-blocked'").run();
    } finally {
      closeDatabase(stateDb);
    }

    const result = await renameBundle("original", "renamed", {}, renameDeps(fakeCronBackend(memoryExec())));

    expect(result.state.workflowRunRefs).toBe(3);
    // A blocked run keeps the old refs in its frozen plan too, so it is listed with its status.
    expect([...result.activeWorkflowRuns].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "run-active", workflowRef: "original//workflows/foo", status: "active" },
      { id: "run-blocked", workflowRef: "original//workflows/foo", status: "blocked" },
    ]);

    const readDb = openStateDatabase();
    try {
      const rows = readDb.prepare("SELECT id, workflow_ref FROM workflow_runs ORDER BY id").all() as Array<{
        id: string;
        workflow_ref: string;
      }>;
      expect(rows).toEqual([
        { id: "run-active", workflow_ref: "renamed//workflows/foo" },
        { id: "run-blocked", workflow_ref: "renamed//workflows/foo" },
        { id: "run-done", workflow_ref: "renamed//workflows/foo" },
        { id: "run-other", workflow_ref: "other//workflows/foo" },
      ]);
    } finally {
      closeDatabase(readDb);
    }
  });

  test("rewrites refs of a bundle id with an astral character without eating the separator (#1239)", () => {
    // JS `.length` counts UTF-16 code units, SQLite `substr` counts characters:
    // "💼" is length 2 in JS but one character in SQL.
    const oldId = "💼";
    const stateDb = openStateDatabase();
    try {
      seedWorkflowRun(stateDb, { runId: "run-astral", steps: ["a"], workflowRef: `${oldId}//workflows/x` });
      upsertTaskHistory(stateDb, {
        task_id: "wf-astral",
        status: "completed",
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
        failed_at: null,
        log_path: null,
        target_kind: "workflow",
        target_ref: `${oldId}//workflows/x`,
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 60_000, detail: null }),
      });
      upsertProposal(stateDb, makeProposal("p-astral", `${oldId}//knowledge/x`, oldId), storage.stashDir);

      expect(renameWorkflowRunRefs(stateDb, oldId, "team")).toBe(1);
      expect(renameTaskHistoryTargetRefs(stateDb, oldId, "team")).toBe(1);
      expect(renameProposalsBundleRef(stateDb, oldId, "team").refs).toBe(1);

      const run = stateDb.prepare("SELECT workflow_ref FROM workflow_runs WHERE id = 'run-astral'").get() as {
        workflow_ref: string;
      };
      const task = stateDb.prepare("SELECT target_ref FROM task_history WHERE task_id = 'wf-astral'").get() as {
        target_ref: string;
      };
      const proposal = stateDb.prepare("SELECT ref FROM proposals WHERE id = 'p-astral'").get() as { ref: string };
      expect(run.workflow_ref).toBe("team//workflows/x");
      expect(task.target_ref).toBe("team//workflows/x");
      expect(proposal.ref).toBe("team//knowledge/x");
    } finally {
      closeDatabase(stateDb);
    }
  });

  test("feedback given before the rename still ranks the asset after it (#1250)", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      writeKnowledgeAsset(storage.stashDir, name, `---\ndescription: zebra note\n---\nzebra ${name} stripes\n`);
    }
    saveConfig({
      semanticSearchMode: "off",
      bundles: { original: { path: storage.stashDir, writable: true } },
      defaultBundle: "original",
      defaultWriteTarget: "original",
    });
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const names = async (): Promise<string[]> =>
      (await akmSearch({ query: "zebra", skipLogging: true })).hits.map((hit) => ("name" in hit ? hit.name : ""));
    const base = await names();
    const favourite = base[2] as string;
    for (let i = 0; i < 3; i++) {
      const { code, stderr } = await runCliCapture([
        "feedback",
        `knowledge/${favourite}`,
        "--positive",
        "--format=json",
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    }
    expect((await names())[0]).toBe(favourite);

    await renameBundle("original", "renamed", {}, renameDeps(fakeCronBackend(memoryExec())));

    expect((await names())[0]).toBe(favourite);
  });

  test("rewrites the usage events, salience and outcome rows of the renamed bundle only (#1250)", async () => {
    await seedBundleWithOneEntry();
    const stateDb = openStateDatabase();
    try {
      for (const [entry_ref, signal] of [
        ["original//knowledge/hello", "positive"],
        ["original//knowledge/hello", "negative"],
        ["original2//knowledge/hello", "positive"],
        ["knowledge/hello", "positive"],
      ] as const) {
        insertUsageEventStrict(stateDb, { event_type: "feedback", entry_ref, signal, source: "user" });
      }
      for (const [ref, rankScore] of [
        ["original//knowledge/hello", 0.9],
        ["original2//knowledge/hello", 0.8],
        // Left by a removed bundle that was also called "renamed": the renamed bundle's row replaces it.
        ["renamed//knowledge/hello", 0.1],
      ] as const) {
        seedSalience(stateDb, ref, rankScore);
      }
      seedOutcome(stateDb, "original//knowledge/hello", 0.7);
      seedOutcome(stateDb, "original2//knowledge/hello", 0.6);
    } finally {
      closeDatabase(stateDb);
    }

    await renameBundle("original", "renamed", {}, renameDeps(fakeCronBackend(memoryExec())));

    const readDb = openStateDatabase();
    try {
      const counts = countFeedbackSignalsByRef(readDb, [
        "original//knowledge/hello",
        "renamed//knowledge/hello",
        "original2//knowledge/hello",
      ]);
      expect(counts.has("original//knowledge/hello")).toBe(false);
      expect(counts.get("renamed//knowledge/hello")).toEqual({ pos: 1, neg: 1 });
      expect(counts.get("original2//knowledge/hello")).toEqual({ pos: 1, neg: 0 });
      expect(
        readDb.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref = 'knowledge/hello'").get(),
      ).toEqual({ n: 1 });

      expect(getAssetSalience(readDb, "original//knowledge/hello")).toBeUndefined();
      expect(getAssetSalience(readDb, "renamed//knowledge/hello")?.rank_score).toBe(0.9);
      expect(getAssetSalience(readDb, "original2//knowledge/hello")?.rank_score).toBe(0.8);
      expect(getAssetOutcome(readDb, "original//knowledge/hello")).toBeUndefined();
      expect(getAssetOutcome(readDb, "renamed//knowledge/hello")?.outcome_score).toBe(0.7);
      expect(getAssetOutcome(readDb, "original2//knowledge/hello")?.outcome_score).toBe(0.6);
    } finally {
      closeDatabase(readDb);
    }
  });

  test("a feedback event stays attached to its entry across the rename and the next index (#1250)", async () => {
    await seedBundleWithOneEntry();
    const { code, stderr } = await runCliCapture(["feedback", "knowledge/hello", "--positive", "--format=json"]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

    await renameBundle("original", "renamed", {}, renameDeps(fakeCronBackend(memoryExec())));
    await akmIndex({ stashDir: storage.stashDir });

    const readDb = openStateDatabase();
    try {
      const row = readDb
        .prepare("SELECT entry_id, entry_ref FROM usage_events WHERE event_type = 'feedback'")
        .get() as {
        entry_id: number | null;
        entry_ref: string;
      };
      expect(row.entry_ref).toBe("renamed//knowledge/hello");
      expect(row.entry_id).not.toBeNull();
    } finally {
      closeDatabase(readDb);
    }
  });

  test("a bundle id's `_` and astral characters match literally in the usage, salience and outcome rewrites (#1250)", () => {
    const stateDb = openStateDatabase();
    try {
      for (const bundle of ["my_💼", "myx💼"]) {
        insertUsageEventStrict(stateDb, {
          event_type: "feedback",
          entry_ref: `${bundle}//knowledge/x`,
          signal: "positive",
          source: "user",
        });
        seedSalience(stateDb, `${bundle}//knowledge/x`, 0.5);
        seedOutcome(stateDb, `${bundle}//knowledge/x`, 0.5);
      }

      expect(renameUsageEventRefs(stateDb, "my_💼", "team")).toBe(1);
      expect(renameAssetSalienceRefs(stateDb, "my_💼", "team")).toBe(1);
      expect(renameAssetOutcomeRefs(stateDb, "my_💼", "team")).toBe(1);

      const refs = (sql: string) => (stateDb.prepare(sql).all() as Array<{ ref: string }>).map((row) => row.ref).sort();
      const expected = ["myx💼//knowledge/x", "team//knowledge/x"];
      expect(refs("SELECT entry_ref AS ref FROM usage_events")).toEqual(expected);
      expect(refs("SELECT asset_ref AS ref FROM asset_salience")).toEqual(expected);
      expect(refs("SELECT asset_ref AS ref FROM asset_outcome")).toEqual(expected);
    } finally {
      closeDatabase(stateDb);
    }
  });

  test("a bundle with no lock entry, no scheduler grants, and no state rows renames cleanly", async () => {
    await seedBundleWithOneEntry();

    const backend = fakeCronBackend(memoryExec());
    const result = await renameBundle("original", "renamed", {}, renameDeps(backend));

    expect(result.applied).toBe(true);
    expect(result.taskSync?.ok).toBe(true);
    expect(result.lock.present).toBe(false);
    expect(result.config.schedulerRefs).toEqual([]);
    expect(result.state.proposalRefs).toBe(0);
    expect(result.state.proposalTargets).toBe(0);
    expect(result.state.taskHistoryRefs).toBe(0);
    expect(readLockfile()).toEqual([]);
  });
});

describe("akm bundle rename — native scheduler sync", () => {
  test("moves an installed native row from the old bundle name to the new one; --dry-run reports it first", async () => {
    await seedBundleWithOneEntry();
    const tasksDir = path.join(storage.stashDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "foo.yml"),
      'version: 4\nrun: echo foo\nname: foo\nschedule:\n  - cron: "*/15 * * * *"\n',
      "utf8",
    );
    setSchedulerRefEnabled("original//tasks/foo", true);

    const exec = memoryExec();
    const backend = fakeCronBackend(exec);
    // Install the native row under the OLD name first, exactly as a real
    // prior `akm task sync` would have.
    await akmTasksSync({ backend }, "original");
    expect(exec.current()).toContain("task run foo --bundle original --scheduled");

    // --dry-run reports the stale row and leaves the crontab untouched.
    const plan = await renameBundle("original", "renamed", { dryRun: true }, renameDeps(backend));
    expect(plan.nativeSchedulerRows.some((row) => row.includes("--bundle original"))).toBe(true);
    expect(exec.current()).toContain("--bundle original");

    const result = await renameBundle("original", "renamed", {}, renameDeps(backend));
    expect(result.applied).toBe(true);
    expect(result.taskSync?.ok).toBe(true);
    expect(exec.current()).toContain("task run foo --bundle renamed --scheduled");
    expect(exec.current()).not.toContain("--bundle original");
  });

  // a binding that fails to re-sync must not be reported as success —
  // its old native row is already gone (removeStaleNativeSchedulerRows runs
  // before the sync), so a silent `ok: true` would leave it unscheduled
  // until the operator happened to notice.
  test("reports taskSync.ok false when a granted binding fails to re-sync, and still removes its old native row", async () => {
    await seedBundleWithOneEntry();
    const tasksDir = path.join(storage.stashDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "foo.yml"),
      'version: 4\nrun: echo foo\nname: foo\nschedule:\n  - cron: "*/15 * * * *"\n',
      "utf8",
    );
    setSchedulerRefEnabled("original//tasks/foo", true);

    const exec = memoryExec();
    const backend = fakeCronBackend(exec);
    // Install the native row under the OLD name first, exactly as a real
    // prior `akm task sync` would have.
    await akmTasksSync({ backend }, "original");
    expect(exec.current()).toContain("task run foo --bundle original --scheduled");

    // An invalid schedule written before the rename — the same #867 shape
    // `akmTasksSync` reports as a failure rather than installing.
    fs.writeFileSync(
      path.join(tasksDir, "foo.yml"),
      'run: echo foo\nname: foo\nschedule:\n  - cron: "*/15 * * * *"\n',
      "utf8",
    );

    const result = await renameBundle("original", "renamed", {}, renameDeps(backend));

    expect(result.applied).toBe(true);
    expect(result.taskSync?.ok).toBe(false);
    const syncResult = (result.taskSync as { result?: TasksSyncResult } | undefined)?.result;
    expect(syncResult?.failures.length).toBe(1);
    expect(syncResult?.failures[0]?.reason).toMatch(/version is required and must be 4/);
    // The stale old-name row was still removed, even though the new one
    // could not be installed in its place.
    expect(exec.current()).not.toContain("--bundle original");
    expect(exec.current()).not.toContain("--bundle renamed");
  });
});
