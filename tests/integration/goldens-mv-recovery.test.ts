// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: `akm mv` SIGKILL crash-recovery outcomes (WI-04, plan §11
 * Chunk 0a / R3, engine 3 of 3). Integration scope (crash windows only —
 * brief §3.4): parameterizes the existing, UNMODIFIED
 * `tests/integration/_helpers/mv-crash-runner.ts` subprocess harness — the
 * exact pattern `tests/integration/mv-durable-recovery.test.ts` already
 * establishes (no `src/` or runner changes needed for this chunk).
 *
 * Pins: SIGKILL at `"applying"` (before any citer/source rename has
 * happened — `setMoveJournalPhase(transaction, "applying")` runs before the
 * citers ownership-taking loop, `mv-cli.ts:628-631`) -> full rollback,
 * byte-identical tree (`recoverInterruptedMoveTransactions` ->
 * `rollbackMoveJournal`, `:401-451`); SIGKILL at each of
 * `filesystem-committed` / `index-finalized` / `state-finalized` /
 * `event-finalized` -> roll forward via `finalizeMoveTransaction`
 * (`:1020-1080`), exactly-one `mv` event
 * (`idempotencyMetadataKey:"mutationTransactionId"`, `:1009-1012`), index +
 * state rows re-keyed; the FOUR independent recovery entry points pinned
 * individually — `akm mv`'s own pre-flight recovery (`mv-cli.ts:1237`),
 * proposal promotion (`repository.ts:1702`), the full indexer
 * (`indexer.ts:558`), and the targeted write-path indexer
 * (`index-written-assets.ts:72`) — each independently discovers and
 * finishes the SAME kind of interrupted mv journal, which pins the dual
 * journal-home semantics Chunk 6 could silently change: the mv journal
 * lives IN-STASH (`<stashDir>/.akm/mv-transactions`), unlike the proposal
 * journals which live in `getDataDir()`.
 *
 * Encoding (brief §3.2): journal phase sequences are informational data only
 * (`journalPhasesObserved`); events are golden as exactly-once counts, never
 * a raw id-keyed map; refs are fixture-local
 * (`tests/fixtures/goldens/journal/fixture-refs.ts`, shared with WI-03).
 *
 * Designation: `frozen-migration-input` (DESIGNATIONS.json) — preservation
 * oracle through Chunk 6.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept } from "../../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { readEvents } from "../../src/core/events";
import { txnNamespaceDir } from "../../src/core/fs-txn";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { indexWrittenAssets } from "../../src/indexer/index-written-assets";
import { akmIndex } from "../../src/indexer/indexer";
import { insertUsageEvent } from "../../src/indexer/usage/usage-events";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { expectGolden, fileTreeManifest } from "../_helpers/golden";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";
import {
  MV_RECOVERY_ENTRY_INDEXER_FULL_NAME,
  MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME,
  MV_RECOVERY_ENTRY_MVRUN_NAME,
  MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME,
  MV_RECOVERY_ENTRY_PROMOTE_NAME,
  MV_RECOVERY_FORWARD_PHASES,
  MV_RECOVERY_FORWARD_PREFIX,
  MV_RECOVERY_FORWARD_TRIGGER_PREFIX,
  MV_RECOVERY_ROLLBACK_NAME,
  MV_RECOVERY_ROLLBACK_TARGET_REL,
  memoryRef,
  mvSourceBody,
} from "../fixtures/goldens/journal/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/journal/move-recovery.json";
const HEAD_SHA = "90640d4103ab4024ab0bf8b0705bd54d847c9a4a";
const RUNNER = path.join(import.meta.dir, "_helpers", "mv-crash-runner.ts");

let storage: IsolatedAkmStorage;
let markers: ReturnType<typeof makeSandboxDir>;
const children: ChildProcess[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  markers = makeSandboxDir("akm-goldens-mv-crash");
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

/** Hold the crash runner at `phase`, then SIGKILL it. Mirrors mv-durable-recovery.test.ts. */
async function crashAt(phase: string, fromRef: string, toName: string): Promise<void> {
  const marker = path.join(markers.dir, `${phase}-${fromRef.replace(/[^a-z0-9]/gi, "_")}.ready`);
  const child = spawn("bun", [RUNNER, phase, marker, fromRef, toName], {
    env: { ...process.env },
    stdio: "ignore",
  });
  children.push(child);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`mv crash runner did not reach ${phase}`);
    }
    await Bun.sleep(10);
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function seedStateRows(ref: string): void {
  const db = openStateDatabase();
  db.prepare(
    `INSERT INTO asset_salience
     (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ref, 0.8, 0, 0, 0.7, 0, Date.now(), "content");
  db.prepare(
    `INSERT INTO asset_outcome
     (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate, negative_feedback_count, accepted_change_count, outcome_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ref, Date.now(), 7, 1, 0, 2, 0.5, Date.now());
  db.close();
}

function stateRowsFor(ref: string): { salience?: string; outcomeRetrievalCount?: number } {
  const db = openStateDatabase();
  const salience = db.prepare("SELECT asset_ref FROM asset_salience WHERE asset_ref = ?").get(ref) as
    | { asset_ref: string }
    | undefined;
  const outcome = db.prepare("SELECT asset_ref, retrieval_count FROM asset_outcome WHERE asset_ref = ?").get(ref) as
    | { asset_ref: string; retrieval_count: number }
    | undefined;
  db.close();
  return { salience: salience?.asset_ref, outcomeRetrievalCount: outcome?.retrieval_count };
}

/** Count of `mv` events matching `ref`, plus the distinct-idempotency-key shape (brief §3.2). */
function mvEventOutcome(ref: string): { matchingCount: number; distinctIdempotencyKeyCount: number } {
  const events = readEvents({ type: "mv", ref }).events;
  const keys = new Set(events.map((e) => String(e.metadata?.mutationTransactionId ?? "")));
  return { matchingCount: events.length, distinctIdempotencyKeyCount: keys.size };
}

function transactionsRootIsClean(stashDir: string): boolean {
  // WI-6.3 mechanical repoint: the mv journal home moved from the in-stash
  // `.akm/mv-transactions` to the unified engine namespace for the stash.
  // (The serialized `notes` strings describing the old dual-home are fixture
  // bytes and re-capture at WI-6.5 with the rest of this re-baseline asset.)
  const root = txnNamespaceDir(stashDir);
  if (!fs.existsSync(root)) return true;
  return fs.readdirSync(root).length === 0;
}

describe("goldens: mv SIGKILL rollback at the applying phase (WI-04, R3, integration)", () => {
  test("crash before any citer/source rename -> full rollback, byte-identical tree", async () => {
    const sourceBody = mvSourceBody("rollback");
    seed(`memories/${MV_RECOVERY_ROLLBACK_NAME}.md`, sourceBody);
    const citer = seed(
      `knowledge/${MV_RECOVERY_ROLLBACK_NAME}-citer.md`,
      `Cites ${memoryRef(MV_RECOVERY_ROLLBACK_NAME)}\n`,
    );
    const treeBeforeCrash = fileTreeManifest(storage.stashDir);

    await crashAt("applying", memoryRef(MV_RECOVERY_ROLLBACK_NAME), MV_RECOVERY_ROLLBACK_TARGET_REL);

    // The interrupted "applying" journal rolls back on the very next mutation.
    const trigger = seed(`memories/${MV_RECOVERY_ROLLBACK_NAME}-trigger.md`, mvSourceBody("rollback-trigger"));
    const recovered = await runCliCapture([
      "mv",
      memoryRef(`${MV_RECOVERY_ROLLBACK_NAME}-trigger`),
      `${MV_RECOVERY_ROLLBACK_NAME}-trigger-new`,
    ]);
    expect(recovered.code).toBe(0);
    expect(fs.existsSync(trigger)).toBe(false);
    expect(fs.existsSync(path.join(storage.stashDir, "memories", `${MV_RECOVERY_ROLLBACK_NAME}-trigger-new.md`))).toBe(
      true,
    );

    // The rolled-back-to state matches exactly what existed before the crash
    // (source + citer untouched; nothing landed at the target).
    expect(fs.readFileSync(path.join(storage.stashDir, `memories/${MV_RECOVERY_ROLLBACK_NAME}.md`), "utf8")).toBe(
      sourceBody,
    );
    expect(fs.readFileSync(citer, "utf8")).toBe(`Cites ${memoryRef(MV_RECOVERY_ROLLBACK_NAME)}\n`);
    expect(fs.existsSync(path.join(storage.stashDir, "memories", `${MV_RECOVERY_ROLLBACK_TARGET_REL}.md`))).toBe(false);
    expect(transactionsRootIsClean(storage.stashDir)).toBe(true);

    const treeMinusTrigger = fileTreeManifest(storage.stashDir);
    delete (treeMinusTrigger as Record<string, string>)[`memories/${MV_RECOVERY_ROLLBACK_NAME}-trigger-new.md`];
    expect(treeMinusTrigger).toEqual(treeBeforeCrash);
  });
});

describe("goldens: mv SIGKILL roll-forward phases (WI-04, R3, integration)", () => {
  for (const phase of MV_RECOVERY_FORWARD_PHASES) {
    test(`crash at ${phase} recovers forward: exactly one mv event, index + state re-keyed`, async () => {
      const name = `${MV_RECOVERY_FORWARD_PREFIX}-${phase}`;
      const ref = memoryRef(name);
      seed(`memories/${name}.md`, mvSourceBody(phase));
      seedStateRows(ref);
      const triggerName = `${MV_RECOVERY_FORWARD_TRIGGER_PREFIX}-${phase}`;
      seed(`memories/${triggerName}.md`, mvSourceBody(`${phase}-trigger`));
      const indexed = await runCliCapture(["index"]);
      expect(indexed.code).toBe(0);

      let db = openExistingDatabase(getDbPath());
      const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${ref}`) as
        | { id: number }
        | undefined;
      closeDatabase(db);

      await crashAt(phase, ref, `${name}-new`);
      const trigger = await runCliCapture(["mv", memoryRef(triggerName), `${triggerName}-new`]);
      expect(trigger.stderr).toBe("");
      expect(trigger.code).toBe(0);

      const toRef = memoryRef(`${name}-new`);
      expect(fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`))).toBe(true);
      db = openExistingDatabase(getDbPath());
      const after = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${toRef}`) as
        | { id: number }
        | undefined;
      closeDatabase(db);
      expect(after?.id).toBe(before?.id);

      const state = stateRowsFor(toRef);
      expect(state.salience).toBe(toRef);
      expect(state.outcomeRetrievalCount).toBe(7);

      const mvEvent = mvEventOutcome(toRef);
      expect(mvEvent.matchingCount).toBe(1);
      expect(mvEvent.distinctIdempotencyKeyCount).toBe(1);
      expect(transactionsRootIsClean(storage.stashDir)).toBe(true);
    });
  }
});

describe("goldens: mv recovery entry points, pinned individually (WI-04, R3, integration)", () => {
  test("mv run's own pre-flight recovery finishes a pending committed move (mv-cli.ts:1237)", async () => {
    const ref = memoryRef(MV_RECOVERY_ENTRY_MVRUN_NAME);
    seed(`memories/${MV_RECOVERY_ENTRY_MVRUN_NAME}.md`, mvSourceBody("mvrun-entry"));
    seed(`memories/${MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME}.md`, mvSourceBody("mvrun-entry-trigger"));
    await crashAt("filesystem-committed", ref, `${MV_RECOVERY_ENTRY_MVRUN_NAME}-new`);

    const trigger = await runCliCapture([
      "mv",
      memoryRef(MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME),
      `${MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME}-new`,
    ]);
    expect(trigger.code).toBe(0);
    expect(fs.existsSync(path.join(storage.stashDir, "memories", `${MV_RECOVERY_ENTRY_MVRUN_NAME}-new.md`))).toBe(true);
    const events = readEvents({ type: "mv", ref: memoryRef(`${MV_RECOVERY_ENTRY_MVRUN_NAME}-new`) }).events;
    expect(events).toHaveLength(1);
  });

  test("proposal promotion's pre-flight recovery finishes a pending committed move (repository.ts:1702)", async () => {
    const ref = memoryRef(MV_RECOVERY_ENTRY_PROMOTE_NAME);
    seed(`memories/${MV_RECOVERY_ENTRY_PROMOTE_NAME}.md`, mvSourceBody("promote-entry"));
    await crashAt("filesystem-committed", ref, `${MV_RECOVERY_ENTRY_PROMOTE_NAME}-new`);

    const proposal = createProposal(storage.stashDir, {
      ref: "lesson:mv-recovery-entry-promote-trigger",
      source: "propose",
      force: true,
      payload: {
        content:
          "---\ndescription: Trigger pending mv-journal recovery via proposal promotion.\nwhen_to_use: Finalizing a pending committed mv journal.\n---\n\nTrigger recovery.\n",
      },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    const accepted = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id });
    expect(accepted.ok).toBe(true);

    expect(fs.existsSync(path.join(storage.stashDir, "memories", `${MV_RECOVERY_ENTRY_PROMOTE_NAME}-new.md`))).toBe(
      true,
    );
    const events = readEvents({ type: "mv", ref: memoryRef(`${MV_RECOVERY_ENTRY_PROMOTE_NAME}-new`) }).events;
    expect(events).toHaveLength(1);
  });

  test("the full indexer's pre-flight recovery finishes a pending committed move (indexer.ts:558)", async () => {
    // A full reindex's own upsert path does not guarantee the SAME raw
    // `entries.id` survives a full walk (mv-durable-recovery.test.ts's own
    // "full index recovers a committed move..." test proves preservation
    // indirectly via a usage_events junction row rather than a direct id
    // comparison) -- this test follows the same proven technique.
    const ref = memoryRef(MV_RECOVERY_ENTRY_INDEXER_FULL_NAME);
    seed(`memories/${MV_RECOVERY_ENTRY_INDEXER_FULL_NAME}.md`, mvSourceBody("indexfull-entry"));
    await akmIndex({ stashDir: storage.stashDir, full: true });
    let db = openExistingDatabase(getDbPath());
    const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${ref}`) as
      | { id: number }
      | undefined;
    if (!before) throw new Error("missing indexed source row");
    insertUsageEvent(db, { event_type: "show", entry_id: before.id, entry_ref: ref });
    closeDatabase(db);

    await crashAt("filesystem-committed", ref, `${MV_RECOVERY_ENTRY_INDEXER_FULL_NAME}-new`);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(
      fs.existsSync(path.join(storage.stashDir, "memories", `${MV_RECOVERY_ENTRY_INDEXER_FULL_NAME}-new.md`)),
    ).toBe(true);
    db = openExistingDatabase(getDbPath());
    const after = db
      .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
      .get(`%:${memoryRef(`${MV_RECOVERY_ENTRY_INDEXER_FULL_NAME}-new`)}`) as { id: number } | undefined;
    const usage = db.prepare("SELECT entry_ref, entry_id FROM usage_events WHERE event_type = 'show'").get() as
      | { entry_ref: string; entry_id: number }
      | undefined;
    closeDatabase(db);
    if (!after) throw new Error("recovered row missing");
    expect(usage).toEqual({ entry_ref: memoryRef(`${MV_RECOVERY_ENTRY_INDEXER_FULL_NAME}-new`), entry_id: after.id });
    expect(transactionsRootIsClean(storage.stashDir)).toBe(true);
  });

  test("the targeted write-path indexer's pre-flight recovery finishes a pending committed move (index-written-assets.ts:72)", async () => {
    const ref = memoryRef(MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME);
    seed(`memories/${MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME}.md`, mvSourceBody("indextargeted-entry"));
    await akmIndex({ stashDir: storage.stashDir, full: true });
    let db = openExistingDatabase(getDbPath());
    const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${ref}`) as
      | { id: number }
      | undefined;
    closeDatabase(db);

    await crashAt("filesystem-committed", ref, `${MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME}-new`);
    expect(await indexWrittenAssets(storage.stashDir, [])).toBe(true);

    expect(
      fs.existsSync(path.join(storage.stashDir, "memories", `${MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME}-new.md`)),
    ).toBe(true);
    db = openExistingDatabase(getDbPath());
    const after = db
      .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
      .get(`%:${memoryRef(`${MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME}-new`)}`) as { id: number } | undefined;
    closeDatabase(db);
    expect(after?.id).toBe(before?.id);
    expect(transactionsRootIsClean(storage.stashDir)).toBe(true);
  });
});

// ── Golden fixture capture ──────────────────────────────────────────────────
describe("golden fixture: serialize mv SIGKILL crash-recovery outcomes (WI-04, R3)", () => {
  test("golden fixture: move-recovery.json", async () => {
    const rollbackOutcome = await (async () => {
      const name = `${MV_RECOVERY_FORWARD_PREFIX}-golden-rollback`;
      const sourceBody = mvSourceBody("golden-rollback");
      seed(`memories/${name}.md`, sourceBody);
      const treeBeforeCrash = fileTreeManifest(storage.stashDir);
      await crashAt("applying", memoryRef(name), `${name}-new`);
      const triggerName = `${name}-trigger`;
      seed(`memories/${triggerName}.md`, mvSourceBody("golden-rollback-trigger"));
      const recovered = await runCliCapture(["mv", memoryRef(triggerName), `${triggerName}-new`]);
      const treeMinusTrigger = fileTreeManifest(storage.stashDir);
      delete (treeMinusTrigger as Record<string, string>)[`memories/${triggerName}-new.md`];
      return {
        recoveredMoveSucceeded: recovered.code === 0,
        targetCreated: fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`)),
        sourceStillAtOriginalPath:
          fs.readFileSync(path.join(storage.stashDir, `memories/${name}.md`), "utf8") === sourceBody,
        treeByteIdenticalToPreCrash: JSON.stringify(treeMinusTrigger) === JSON.stringify(treeBeforeCrash),
        transactionsRootClean: transactionsRootIsClean(storage.stashDir),
      };
    })();

    const forwardOutcomes: Record<string, unknown> = {};
    for (const phase of MV_RECOVERY_FORWARD_PHASES) {
      const name = `${MV_RECOVERY_FORWARD_PREFIX}-golden-${phase}`;
      const ref = memoryRef(name);
      seed(`memories/${name}.md`, mvSourceBody(phase));
      seedStateRows(ref);
      const triggerName = `${MV_RECOVERY_FORWARD_TRIGGER_PREFIX}-golden-${phase}`;
      seed(`memories/${triggerName}.md`, mvSourceBody(`${phase}-trigger`));
      await runCliCapture(["index"]);
      let db = openExistingDatabase(getDbPath());
      const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${ref}`) as
        | { id: number }
        | undefined;
      closeDatabase(db);

      await crashAt(phase, ref, `${name}-new`);
      const trigger = await runCliCapture(["mv", memoryRef(triggerName), `${triggerName}-new`]);
      const toRef = memoryRef(`${name}-new`);
      db = openExistingDatabase(getDbPath());
      const after = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${toRef}`) as
        | { id: number }
        | undefined;
      closeDatabase(db);
      const state = stateRowsFor(toRef);

      forwardOutcomes[phase] = {
        recoveredMoveSucceeded: trigger.code === 0,
        targetCreated: fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`)),
        indexRowIdPreserved: after?.id === before?.id,
        stateSalienceRekeyed: state.salience === toRef,
        stateOutcomeRekeyed: state.outcomeRetrievalCount === 7,
        mvEvent: mvEventOutcome(toRef),
        journalPhasesObserved: [phase],
      };
    }

    const entryPointOutcomes = await (async () => {
      // mv run
      const mvRunOutcome = await (async () => {
        const name = MV_RECOVERY_ENTRY_MVRUN_NAME;
        const ref = memoryRef(name);
        seed(`memories/${name}.md`, mvSourceBody("mvrun-entry-golden"));
        seed(`memories/${MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME}.md`, mvSourceBody("mvrun-entry-trigger-golden"));
        await crashAt("filesystem-committed", ref, `${name}-new`);
        const trigger = await runCliCapture([
          "mv",
          memoryRef(MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME),
          `${MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME}-new`,
        ]);
        return {
          recovered: trigger.code === 0 && fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`)),
          mvEvent: mvEventOutcome(memoryRef(`${name}-new`)),
        };
      })();

      // proposal promote
      const promoteOutcome = await (async () => {
        const name = MV_RECOVERY_ENTRY_PROMOTE_NAME;
        const ref = memoryRef(name);
        seed(`memories/${name}.md`, mvSourceBody("promote-entry-golden"));
        await crashAt("filesystem-committed", ref, `${name}-new`);
        const proposal = createProposal(storage.stashDir, {
          ref: "lesson:mv-recovery-entry-promote-trigger-golden",
          source: "propose",
          force: true,
          payload: {
            content:
              "---\ndescription: Trigger pending mv-journal recovery via proposal promotion (golden capture).\nwhen_to_use: Finalizing a pending committed mv journal.\n---\n\nTrigger recovery.\n",
          },
        });
        if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
        const accepted = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id });
        return {
          recovered: accepted.ok && fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`)),
          mvEvent: mvEventOutcome(memoryRef(`${name}-new`)),
        };
      })();

      // full indexer -- see the assertion suite's comment: a full reindex's
      // own upsert path does not guarantee the SAME raw entries.id survives
      // a full walk, so preservation is captured indirectly via a
      // usage_events junction row (the technique mv-durable-recovery.test.ts
      // already establishes), not a direct id comparison.
      const indexerFullOutcome = await (async () => {
        const name = MV_RECOVERY_ENTRY_INDEXER_FULL_NAME;
        const ref = memoryRef(name);
        seed(`memories/${name}.md`, mvSourceBody("indexfull-entry-golden"));
        await akmIndex({ stashDir: storage.stashDir, full: true });
        let db = openExistingDatabase(getDbPath());
        const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${ref}`) as
          | { id: number }
          | undefined;
        if (!before) throw new Error("missing indexed source row");
        insertUsageEvent(db, { event_type: "show", entry_id: before.id, entry_ref: ref });
        closeDatabase(db);
        await crashAt("filesystem-committed", ref, `${name}-new`);
        await akmIndex({ stashDir: storage.stashDir, full: true });
        db = openExistingDatabase(getDbPath());
        const after = db
          .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
          .get(`%:${memoryRef(`${name}-new`)}`) as { id: number } | undefined;
        const usage = db.prepare("SELECT entry_ref, entry_id FROM usage_events WHERE event_type = 'show'").get() as
          | { entry_ref: string; entry_id: number }
          | undefined;
        closeDatabase(db);
        return {
          recovered: fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`)),
          usageEventReKeyedOntoRecoveredRow:
            usage?.entry_ref === memoryRef(`${name}-new`) && usage?.entry_id === after?.id,
        };
      })();

      // targeted write-path indexer
      const indexerTargetedOutcome = await (async () => {
        const name = MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME;
        const ref = memoryRef(name);
        seed(`memories/${name}.md`, mvSourceBody("indextargeted-entry-golden"));
        await akmIndex({ stashDir: storage.stashDir, full: true });
        let db = openExistingDatabase(getDbPath());
        const before = db.prepare("SELECT id FROM entries WHERE entry_key LIKE ?").get(`%:${ref}`) as
          | { id: number }
          | undefined;
        closeDatabase(db);
        await crashAt("filesystem-committed", ref, `${name}-new`);
        const indexed = await indexWrittenAssets(storage.stashDir, []);
        db = openExistingDatabase(getDbPath());
        const after = db
          .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
          .get(`%:${memoryRef(`${name}-new`)}`) as { id: number } | undefined;
        closeDatabase(db);
        return {
          indexWrittenAssetsReturnedTrue: indexed,
          recovered: fs.existsSync(path.join(storage.stashDir, "memories", `${name}-new.md`)),
          indexRowIdPreserved: after?.id === before?.id,
        };
      })();

      return {
        mvRun: mvRunOutcome,
        proposalPromote: promoteOutcome,
        indexerFull: indexerFullOutcome,
        indexerTargeted: indexerTargetedOutcome,
      };
    })();

    expectGolden(GOLDEN_PATH, {
      scenario: "mv SIGKILL crash-recovery outcomes (WI-04, R3, integration scope)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "Crash windows only (brief §3.4) — parameterizes the existing, unmodified " +
          "tests/integration/_helpers/mv-crash-runner.ts subprocess harness.",
        "journalPhasesObserved is informational only (brief §3.2 rule 4): the single phase name the runner was " +
          "told to hold at, never journal bytes/paths. Re-captured at Chunk 6 (WI-6.5): the mv journal now " +
          "rides the unified FileChange transaction engine (src/core/fs-txn.ts) — phase vocabulary and every " +
          "recovery outcome preserved through the swap.",
        "'applying' rolls back in full (no partial state survives) because it is held right after the " +
          "prepared->applying journal transition, before any citer/source rename has happened " +
          "(mv-cli.ts:598); every later named phase rolls forward via finalizeMoveTransaction " +
          "(mv-cli.ts:991) to the same accepted end state with exactly-one mv event and re-keyed index + " +
          "state rows.",
        "The four recovery entry points (mv run's own pre-flight recovery mv-cli.ts:486, proposal promotion " +
          "repository.ts:1791, the full indexer indexer.ts:560, the targeted write-path indexer " +
          "index-written-assets.ts:74) each independently discover and finish the SAME kind of interrupted mv " +
          "journal via recoverTxnsForRoot with a kind === 'mv' filter. The old dual journal-home story " +
          "(in-stash .akm/mv-transactions vs getDataDir() proposal journals) is GONE: every kind's journal " +
          "lives in the engine's per-root namespace (getDataDir()/txn/<hash(canonical stash root)>), and the " +
          "four entry points pin that mv recovery still fires from all four call sites after the collapse.",
      ],
      rollback: { applying: rollbackOutcome },
      rollForward: forwardOutcomes,
      recoveryEntryPoints: entryPointOutcomes,
    });
  }, 60_000);
});
