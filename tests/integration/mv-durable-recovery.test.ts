import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept } from "../../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { readEvents } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { closeDatabase, openExistingDatabase } from "../../src/indexer/db/db";
import { indexWrittenAssets } from "../../src/indexer/index-written-assets";
import { akmIndex } from "../../src/indexer/indexer";
import { insertUsageEvent } from "../../src/indexer/usage/usage-events";
import { runCliCapture } from "../_helpers/cli";
import { makeConfig } from "../_helpers/factories";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const RUNNER = path.join(import.meta.dir, "_helpers", "mv-crash-runner.ts");
let storage: IsolatedAkmStorage;
let markers: ReturnType<typeof makeSandboxDir>;
const children: ChildProcess[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  markers = makeSandboxDir("akm-mv-crash");
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  markers.cleanup();
  storage.cleanup();
});

function seed(relPath: string, content: string): string {
  const filePath = path.join(storage.stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await Bun.sleep(10);
  }
}

async function crashAt(phase: string, fromRef: string, toName: string): Promise<void> {
  const marker = path.join(markers.dir, `${phase}.ready`);
  const child = spawn("bun", [RUNNER, phase, marker, fromRef, toName], {
    env: { ...process.env },
    stdio: "ignore",
  });
  children.push(child);
  await waitForFile(marker);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("mv durable journal crash recovery", () => {
  test("rolls back a SIGKILL after one citer replacement, then safely retries", async () => {
    seed("memories/crash-before-commit.md", "Crash source.\n");
    const citerA = seed("knowledge/crash-a.md", "A memory:crash-before-commit\n");
    const citerB = seed("knowledge/crash-b.md", "B memory:crash-before-commit\n");
    await crashAt("applying-partial", "memory:crash-before-commit", "crash-before-commit-new");

    const retry = await runCliCapture(["mv", "memory:crash-before-commit", "crash-before-commit-new"]);
    expect(retry.code).toBe(0);
    expect(fs.readFileSync(citerA, "utf8")).toContain("memory:crash-before-commit-new");
    expect(fs.readFileSync(citerB, "utf8")).toContain("memory:crash-before-commit-new");
  });

  test("finishes state re-key after SIGKILL at the irreversible filesystem commit", async () => {
    seed("memories/crash-after-commit.md", "Committed source.\n");
    seed("memories/recovery-trigger.md", "Trigger.\n");
    const state = openStateDatabase();
    state
      .prepare(
        `INSERT INTO asset_salience
         (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("memory:crash-after-commit", 0.8, 0, 0, 0.7, 0, Date.now(), "content");
    state.close();

    await crashAt("filesystem-committed", "memory:crash-after-commit", "crash-after-commit-new");
    expect(fs.existsSync(path.join(storage.stashDir, "memories/crash-after-commit-new.md"))).toBe(true);

    const trigger = await runCliCapture(["mv", "memory:recovery-trigger", "recovery-trigger-new"]);
    expect(trigger.code).toBe(0);
    const after = openStateDatabase();
    const refs = after
      .prepare("SELECT asset_ref FROM asset_salience WHERE asset_ref LIKE 'memory:crash-after-commit%'")
      .all() as Array<{ asset_ref: string }>;
    after.close();
    expect(refs).toEqual([{ asset_ref: "memory:crash-after-commit-new" }]);
    expect(fs.existsSync(path.join(storage.stashDir, ".akm", "mv-transactions"))).toBe(false);
  });

  test("recovery after the durable state-finalized phase is idempotent", async () => {
    seed("memories/crash-after-state.md", "State-finalized source.\n");
    seed("memories/state-recovery-trigger.md", "Trigger.\n");
    const state = openStateDatabase();
    state
      .prepare(
        `INSERT INTO asset_outcome
         (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate, negative_feedback_count, accepted_change_count, outcome_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("memory:crash-after-state", Date.now(), 9, 1, 0, 2, 0.4, Date.now());
    state.close();

    await crashAt("state-finalized", "memory:crash-after-state", "crash-after-state-new");
    const trigger = await runCliCapture(["mv", "memory:state-recovery-trigger", "state-recovery-trigger-new"]);
    expect(trigger.code).toBe(0);

    const after = openStateDatabase();
    const rows = after
      .prepare("SELECT asset_ref, retrieval_count FROM asset_outcome WHERE asset_ref LIKE 'memory:crash-after-state%'")
      .all() as Array<{ asset_ref: string; retrieval_count: number }>;
    after.close();
    expect(rows).toEqual([{ asset_ref: "memory:crash-after-state-new", retrieval_count: 9 }]);
    const events = readEvents({ type: "mv", ref: "memory:crash-after-state-new" }).events;
    expect(events).toHaveLength(1);
  });

  test("recovery after mv event persistence does not duplicate the event", async () => {
    seed("memories/crash-after-mv-event.md", "Event-finalized source.\n");
    seed("memories/mv-event-recovery-trigger.md", "Trigger.\n");
    await crashAt("mv-event-persisted", "memory:crash-after-mv-event", "crash-after-mv-event-new");

    const trigger = await runCliCapture(["mv", "memory:mv-event-recovery-trigger", "mv-event-recovery-trigger-new"]);
    expect(trigger.code).toBe(0);
    const events = readEvents({ type: "mv", ref: "memory:crash-after-mv-event-new" }).events;
    expect(events).toHaveLength(1);
  });

  test("refuses forward recovery when the committed target diverged after the crash", async () => {
    seed("memories/crash-divergent.md", "Original committed bytes.\n");
    seed("memories/divergence-trigger.md", "Trigger.\n");
    await crashAt("filesystem-committed", "memory:crash-divergent", "crash-divergent-new");
    const target = path.join(storage.stashDir, "memories", "crash-divergent-new.md");
    fs.writeFileSync(target, "EXTERNAL POST-CRASH EDIT\n", "utf8");

    const trigger = await runCliCapture(["mv", "memory:divergence-trigger", "divergence-trigger-new"]);
    expect(trigger.code).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("EXTERNAL POST-CRASH EDIT\n");
    expect(fs.existsSync(path.join(storage.stashDir, ".akm", "mv-transactions"))).toBe(true);
  });

  test("proposal promotion finalizes a pending committed move before writing", async () => {
    seed("memories/crash-before-proposal.md", "Pending move.\n");
    const state = openStateDatabase();
    state
      .prepare(
        `INSERT INTO asset_outcome
         (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate, negative_feedback_count, accepted_change_count, outcome_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("memory:crash-before-proposal", Date.now(), 4, 1, 0, 1, 0.3, Date.now());
    state.close();
    await crashAt("filesystem-committed", "memory:crash-before-proposal", "crash-before-proposal-new");

    const proposal = createProposal(storage.stashDir, {
      ref: "lesson:recovery-trigger-proposal",
      source: "propose",
      force: true,
      payload: {
        content:
          "---\ndescription: Trigger pending move recovery\nwhen_to_use: Finalizing pending move journals\n---\n\nTrigger recovery.\n",
      },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config: makeConfig(storage.stashDir) });

    const after = openStateDatabase();
    const row = after
      .prepare(
        "SELECT asset_ref, retrieval_count FROM asset_outcome WHERE asset_ref LIKE 'memory:crash-before-proposal%'",
      )
      .get() as { asset_ref: string; retrieval_count: number };
    after.close();
    expect(row).toEqual({ asset_ref: "memory:crash-before-proposal-new", retrieval_count: 4 });
  });

  test("recovers SIGKILL after index row re-key but before the durable index phase", async () => {
    seed("memories/crash-during-index.md", "Index identity.\n");
    seed("memories/index-crash-trigger.md", "Trigger.\n");
    const indexed = await runCliCapture(["index"]);
    expect(indexed.code).toBe(0);
    let db = openExistingDatabase(getDbPath());
    const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%:memory:crash-during-index'").get() as {
      id: number;
    };
    closeDatabase(db);

    await crashAt("index-rekeyed", "memory:crash-during-index", "crash-during-index-new");
    const trigger = await runCliCapture(["mv", "memory:index-crash-trigger", "index-crash-trigger-new"]);
    expect(trigger.stderr).toBe("");
    expect(trigger.code).toBe(0);
    db = openExistingDatabase(getDbPath());
    const after = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%:memory:crash-during-index-new'").get() as {
      id: number;
    };
    closeDatabase(db);
    expect(after.id).toBe(before.id);
  });

  test("full index recovers a committed move before scanning and preserves utility history", async () => {
    seed("memories/crash-before-full-index.md", "Index identity before full scan.\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    let db = openExistingDatabase(getDbPath());
    const before = db
      .prepare("SELECT id FROM entries WHERE entry_key LIKE '%:memory:crash-before-full-index'")
      .get() as {
      id: number;
    };
    insertUsageEvent(db, {
      event_type: "show",
      entry_id: before.id,
      entry_ref: "memory:crash-before-full-index",
    });
    closeDatabase(db);

    await crashAt("filesystem-committed", "memory:crash-before-full-index", "crash-before-full-index-new");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    db = openExistingDatabase(getDbPath());
    const after = db
      .prepare("SELECT id FROM entries WHERE entry_key LIKE '%:memory:crash-before-full-index-new'")
      .get() as { id: number };
    const usage = db.prepare("SELECT entry_ref, entry_id FROM usage_events WHERE event_type = 'show'").get() as {
      entry_ref: string;
      entry_id: number;
    };
    closeDatabase(db);
    expect(usage).toEqual({ entry_ref: "memory:crash-before-full-index-new", entry_id: after.id });
    expect(fs.existsSync(path.join(storage.stashDir, ".akm", "mv-transactions"))).toBe(false);
  });

  test("targeted index recovers a committed move before scanning", async () => {
    seed("memories/crash-before-targeted-index.md", "Targeted index identity.\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    let db = openExistingDatabase(getDbPath());
    const before = db
      .prepare("SELECT id FROM entries WHERE entry_key LIKE '%:memory:crash-before-targeted-index'")
      .get() as { id: number };
    closeDatabase(db);

    await crashAt("filesystem-committed", "memory:crash-before-targeted-index", "crash-before-targeted-index-new");
    const targetPath = path.join(storage.stashDir, "memories", "crash-before-targeted-index-new.md");
    expect(await indexWrittenAssets(storage.stashDir, [targetPath])).toBe(true);

    db = openExistingDatabase(getDbPath());
    const after = db
      .prepare("SELECT id FROM entries WHERE entry_key LIKE '%:memory:crash-before-targeted-index-new'")
      .get() as { id: number };
    closeDatabase(db);
    expect(after.id).toBe(before.id);
  });

  test("recovers SIGKILL between salience and outcome table re-keys", async () => {
    seed("memories/crash-between-state.md", "State identity.\n");
    seed("memories/state-table-trigger.md", "Trigger.\n");
    const state = openStateDatabase();
    const now = Date.now();
    state
      .prepare(
        `INSERT INTO asset_salience
         (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("memory:crash-between-state", 0.7, 0, 0, 0.6, 0, now, "content");
    state
      .prepare(
        `INSERT INTO asset_outcome
         (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate, negative_feedback_count, accepted_change_count, outcome_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("memory:crash-between-state", now, 6, 1, 0, 2, 0.5, now);
    state.close();

    await crashAt("state-asset_salience-rekeyed", "memory:crash-between-state", "crash-between-state-new");
    const trigger = await runCliCapture(["mv", "memory:state-table-trigger", "state-table-trigger-new"]);
    expect(trigger.stderr).toBe("");
    expect(trigger.code).toBe(0);
    const after = openStateDatabase();
    const salience = after
      .prepare("SELECT asset_ref FROM asset_salience WHERE asset_ref LIKE 'memory:crash-between-state%'")
      .get() as { asset_ref: string };
    const outcome = after
      .prepare(
        "SELECT asset_ref, retrieval_count FROM asset_outcome WHERE asset_ref LIKE 'memory:crash-between-state%'",
      )
      .get() as { asset_ref: string; retrieval_count: number };
    after.close();
    expect(salience.asset_ref).toBe("memory:crash-between-state-new");
    expect(outcome).toEqual({ asset_ref: "memory:crash-between-state-new", retrieval_count: 6 });
  });
});
