// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: consolidate journal round-trip + hot-capture guard (WI-06,
 * plan §11 Chunk 0a / R5; re-keyed at Chunk 6 WI-6.3e).
 *
 * ## Harness — real `akmConsolidate` runs; interrupted state via crafted journals
 *
 * Since WI-6.3e the consolidate CHECKLIST journal rides the unified fs-txn
 * engine (src/core/fs-txn.ts): kind `consolidate`, root = the stash, backups
 * under the transaction directory in getDataDir()/txn/<ns>/<id>/. The
 * full-run lifecycle and all-hot scenarios drive the REAL `akmConsolidate`
 * (stubbed LLM transport via `_setChatCompletionForTests`); the write-time
 * journal shape is observed via `spyOn(fs.writeFileSync/copyFileSync)`
 * interception of the engine's durable `journal.json.tmp` writes. The
 * recovery-mode scenarios craft an INTERRUPTED engine journal directly on
 * disk and let `checkForIncompleteJournal` (run-entry, unchanged
 * abort/clean semantics) observe it — no process spawns needed.
 *
 * ## Code-organization note
 *
 * Each `capture*` helper is a single, fully self-contained function (fresh
 * sandbox in, torn down on exit, idempotent) called by BOTH the assertion
 * `test()` blocks and the final golden-serializing tests — so the golden can
 * never depend on test execution order.
 *
 * ## Designation
 *
 * All three fixtures are registry-designated `re-baseline @6`
 * (DESIGNATIONS.json) and were re-captured at WI-6.3e with the engine port
 * (reviewed diff + ledger entry). The legacy characterization surprise (the
 * completed-journal orphaned-backup leak) is deliberately FIXED by the
 * per-transaction-dir scheme and documented in the re-captured fixture
 * notes. Journal phase/shape details remain INFORMATIONAL data only (brief
 * §3.2 rule 4); the observable outcomes (abort/clean verdicts, file/dir
 * existence, op counts, error classification) are the preserved contract.
 */

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmConsolidate,
  type ConsolidateDeleteOp,
  type ConsolidateOperation,
} from "../../../src/commands/improve/consolidate";
import { consolidateGuardStatus } from "../../../src/commands/improve/consolidate/eligibility";
import { assembleAsset } from "../../../src/core/asset/asset-serialize";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { canonicalTxnRoot, txnNamespaceDir } from "../../../src/core/fs-txn";
import { _setChatCompletionForTests } from "../../../src/llm/client";
import { expectGolden } from "../../_helpers/golden";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";
import {
  GUARD_HOT_NAME,
  GUARD_MISSING_NAME,
  GUARD_SAFE_NAME,
  GUARD_UNPARSEABLE_NAME,
  JOURNAL_ALLHOT_A_NAME,
  JOURNAL_ALLHOT_B_NAME,
  JOURNAL_LIFECYCLE_NAME,
  JOURNAL_SILENT_LEAK_NAME,
  JOURNAL_STALE_OP_REF_NAME,
  memoryRef,
} from "../../fixtures/goldens/consolidate/fixture-refs";

const GOLDEN_LIFECYCLE_PATH = "tests/fixtures/goldens/consolidate/journal-lifecycle.json";
const GOLDEN_RECOVERY_PATH = "tests/fixtures/goldens/consolidate/journal-recovery.json";
const GOLDEN_GUARD_PATH = "tests/fixtures/goldens/consolidate/journal-guard-verdicts.json";
const HEAD_SHA = "6dc0354cd0ad5638ea06904bad5720f24b8eca54";

// Consolidation enabled, embeddings off (clustering is a no-op), and a real
// LLM engine SLOT configured (so resolveConsolidateLlmConfig resolves truthy
// and the stubbed chatCompletion transport is actually reachable) — mirrors
// tests/commands/consolidate/consolidate-judged-cache.test.ts's CONFIG.
//
// Any scenario below whose stub returns >=1 op MUST also pass `assumeYes` to
// akmConsolidate(): a truthy llmConfig makes `isHttpPath` true, and with
// `allOps.length > 0` and `assumeYes` unset akmConsolidateInner reaches the
// REAL interactive `promptConfirm` path — this hangs/flakes under bun:test's
// non-tty stdin (not a `src/` bug this chunk may touch; existing behavior).
// `assumeYes: true` bypasses that branch entirely, matching what a real
// programmatic batch caller does (replaced the deleted autoAccept:100 bypass).
const CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: {
    default: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
  },
  improve: { strategies: { judged: { processes: { consolidate: { enabled: true } } } } },
  defaults: { llmEngine: "default", improveStrategy: "judged" },
} as unknown as AkmConfig;

// ── Path helpers (WI-6.3e re-key: the checklist journal rides the unified ──
// fs-txn engine — kind `consolidate`, root = stash; backups live under the
// transaction directory. Crafted journals are engine envelopes.)

const CRAFTED_TXN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function craftedTxnDir(stashDir: string): string {
  return path.join(txnNamespaceDir(stashDir), CRAFTED_TXN_ID);
}

function craftedJournalPath(stashDir: string): string {
  return path.join(craftedTxnDir(stashDir), "journal.json");
}

function craftedBackupDir(stashDir: string): string {
  return path.join(craftedTxnDir(stashDir), "backup");
}

function namespaceIsClean(stashDir: string): boolean {
  const ns = txnNamespaceDir(stashDir);
  if (!fs.existsSync(ns)) return true;
  return fs.readdirSync(ns).length === 0;
}

function writeRawJournalFile(stashDir: string, payload: unknown): void {
  const p = craftedJournalPath(stashDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        version: 1,
        kind: "consolidate",
        phase: "applying",
        transactionId: CRAFTED_TXN_ID,
        root: canonicalTxnRoot(stashDir),
        changes: [],
        decidedAt: "2026-05-01T00:00:00.000Z",
        payload,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function memoryPath(root: string, name: string): string {
  return path.join(root, "memories", `${name}.md`);
}

function writeMemory(root: string, name: string, fm: Record<string, unknown> = {}): { ref: string; filePath: string } {
  const filePath = memoryPath(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    assembleAsset(
      { description: `${name} description`, ...fm },
      "This is a substantive memory body with enough distinct content to be a realistic fixture.",
    ),
    "utf8",
  );
  return { ref: memoryRef(name), filePath };
}

// ── Capture: full-run journal lifecycle ─────────────────────────────────────

async function captureFullRunLifecycle(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const { ref } = writeMemory(root, JOURNAL_LIFECYCLE_NAME);

    let chatCalls = 0;
    overrideSeam(_setChatCompletionForTests, async () => {
      chatCalls++;
      return JSON.stringify({ operations: [{ op: "delete", ref, reason: "redundant" }] });
    });

    const journalWrites: Array<{ phase: unknown; operations: unknown; completed: unknown }> = [];
    const backupCopyBasenames: string[] = [];

    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      const result = originalWriteFileSync(file, data, ...(args as [fs.WriteFileOptions?]));
      // Engine journals are written durably: journal.json.tmp then renamed.
      if (path.basename(String(file)) === "journal.json.tmp") {
        const envelope = JSON.parse(String(data)) as {
          kind?: string;
          phase?: unknown;
          payload?: { operations?: unknown; completed?: unknown };
        };
        if (envelope.kind === "consolidate") {
          journalWrites.push({
            phase: envelope.phase,
            operations: envelope.payload?.operations,
            completed: envelope.payload?.completed,
          });
        }
      }
      return result;
    }) as typeof fs.writeFileSync);

    const originalCopyFileSync = fs.copyFileSync;
    const copySpy = spyOn(fs, "copyFileSync").mockImplementation(((
      src: fs.PathLike,
      dest: fs.PathLike,
      mode?: number,
    ) => {
      const result = originalCopyFileSync(src, dest, mode);
      if (String(dest).includes(`${path.sep}backup${path.sep}`)) {
        backupCopyBasenames.push(path.basename(String(dest)));
      }
      return result;
    }) as typeof fs.copyFileSync);

    let result: Awaited<ReturnType<typeof akmConsolidate>>;
    try {
      result = await akmConsolidate({ stashDir: root, target: root, config: CONFIG, assumeYes: true });
    } finally {
      writeSpy.mockRestore();
      copySpy.mockRestore();
    }

    return {
      chatCompletionCallCount: chatCalls,
      deleted: result.deleted,
      ok: result.ok,
      journalWriteCount: journalWrites.length,
      firstJournalWrite: journalWrites[0],
      lastJournalWrite: journalWrites[journalWrites.length - 1],
      backupCopyBasenames,
      // The journal and its run's backups share the transaction dir; a clean
      // finish sweeps it (and the namespace dir when empty).
      namespaceCleanAfterRun: namespaceIsClean(root),
    };
  } finally {
    storage.cleanup();
  }
}

describe("full-run journal lifecycle (beginConsolidateTxn/backupFile/markJournalCompleted/cleanupTxn)", () => {
  test("real akmConsolidate run: journal shape, backup copy, and end-state removal", async () => {
    const captured = await captureFullRunLifecycle();

    expect(captured.chatCompletionCallCount).toBe(1);
    expect(captured.deleted).toBe(1);
    expect(captured.ok).toBe(true);

    // Engine checklist journal: begin (applying, empty completed) →
    // markJournalCompleted (applying, completed appended) → committed.
    expect(captured.journalWriteCount).toBe(3);
    const first = captured.firstJournalWrite as { phase: string; operations: unknown[]; completed: unknown[] };
    const last = captured.lastJournalWrite as { phase: string; operations: unknown[]; completed: string[] };
    expect(first.phase).toBe("applying");
    expect(first.operations).toHaveLength(1);
    expect(first.completed).toEqual([]);
    expect(last.phase).toBe("committed");
    expect(last.operations).toEqual(first.operations);
    expect(last.completed).toEqual([memoryRef(JOURNAL_LIFECYCLE_NAME)]);

    // backupFile: the deleted memory's content is copied into the transaction
    // dir's backup/ before the archive+hard-delete.
    expect(captured.backupCopyBasenames).toEqual([`${JOURNAL_LIFECYCLE_NAME}.md`]);

    // A clean finish sweeps the transaction dir (journal + backups together).
    expect(captured.namespaceCleanAfterRun).toBe(true);
  });
});

// ── Capture: all-hot chunk -> zero LLM calls + judgedNoAction ───────────────

async function captureAllHotZeroLlm(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    writeMemory(root, JOURNAL_ALLHOT_A_NAME, { captureMode: "hot" });
    writeMemory(root, JOURNAL_ALLHOT_B_NAME, { captureMode: "hot" });

    let chatCalls = 0;
    overrideSeam(_setChatCompletionForTests, async () => {
      chatCalls++;
      return JSON.stringify({ operations: [] });
    });

    const result = await akmConsolidate({ stashDir: root, target: root, config: CONFIG, assumeYes: true });

    return {
      chatCompletionCallCount: chatCalls,
      processed: result.processed,
      judgedNoAction: result.judgedNoAction,
      merged: result.merged,
      deleted: result.deleted,
      failedChunkMemories: result.failedChunkMemories,
      failedChunks: result.failedChunks,
    };
  } finally {
    storage.cleanup();
  }
}

describe("all-hot chunk early-exit (:1617-1636)", () => {
  test("every memory captureMode:hot -> zero LLM calls, all judgedNoAction", async () => {
    const captured = await captureAllHotZeroLlm();

    expect(captured.chatCompletionCallCount).toBe(0);
    expect(captured.processed).toBe(2);
    expect(captured.judgedNoAction).toBe(2);
    expect(captured.merged).toBe(0);
    expect(captured.deleted).toBe(0);
    expect(captured.failedChunkMemories).toBe(0);
    expect(captured.failedChunks).toBe(0);
  });
});

// ── Capture: incomplete journal + recoveryMode "abort" (default) ───────────

async function captureAbortIncomplete(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const opA: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(JOURNAL_STALE_OP_REF_NAME), reason: "x" };
    const opB: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(`${JOURNAL_STALE_OP_REF_NAME}-2`), reason: "x" };
    writeRawJournalFile(root, {
      startedAt: "2026-05-01T00:00:00.000Z",
      operations: [opA, opB] satisfies ConsolidateOperation[],
      completed: [opA.ref], // 1 of 2 completed -> incomplete
    });
    fs.mkdirSync(craftedBackupDir(root), { recursive: true });
    fs.writeFileSync(path.join(craftedBackupDir(root), "placeholder.md"), "x", "utf8");

    let caught: unknown;
    try {
      await akmConsolidate({ stashDir: root, target: root, config: CONFIG });
    } catch (e) {
      caught = e;
    }
    const err = caught as ConfigError | undefined;

    return {
      threw: caught !== undefined,
      isConfigError: err instanceof ConfigError,
      code: err?.code,
      messageContainsIncompleteDetected: (err?.message ?? "").includes("Incomplete consolidation run detected"),
      messageContainsBackupHint: (err?.message ?? "").includes("Backup dir:"),
      journalStillExists: fs.existsSync(craftedJournalPath(root)),
      backupDirStillExists: fs.existsSync(craftedBackupDir(root)),
    };
  } finally {
    storage.cleanup();
  }
}

// ── Capture: unreadable (malformed JSON) journal, default "abort" mode ─────

async function captureAbortUnreadable(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const p = craftedJournalPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not valid json", "utf8");

    let caught: unknown;
    try {
      await akmConsolidate({ stashDir: root, target: root, config: CONFIG });
    } catch (e) {
      caught = e;
    }
    const err = caught as ConfigError | undefined;

    return {
      threw: caught !== undefined,
      isConfigError: err instanceof ConfigError,
      code: err?.code,
      messageContainsUnreadable: (err?.message ?? "").includes("unreadable journal"),
      journalStillExists: fs.existsSync(p),
    };
  } finally {
    storage.cleanup();
  }
}

// ── Capture: recoveryMode "clean" on an incomplete journal ──────────────────
//
// The journal and its backups share the transaction directory, so "clean"
// removes both in one sweep (the legacy scheme's two backup-timestamp
// derivations collapsed with the timestamped backup dirs themselves).

async function captureCleanIncomplete(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const op: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(JOURNAL_STALE_OP_REF_NAME), reason: "x" };
    writeRawJournalFile(root, {
      startedAt: "2026-05-01T00:00:00.000Z",
      operations: [op] satisfies ConsolidateOperation[],
      completed: [],
    });
    fs.mkdirSync(craftedBackupDir(root), { recursive: true });

    const result = await akmConsolidate({
      stashDir: root,
      target: root,
      config: CONFIG,
      recoveryMode: "clean",
    });

    return {
      ok: result.ok,
      processed: result.processed,
      journalRemoved: !fs.existsSync(craftedJournalPath(root)),
      backupDirRemoved: !fs.existsSync(craftedBackupDir(root)),
    };
  } finally {
    storage.cleanup();
  }
}

// ── Capture: completed >= operations -> committed leftover swept quietly ────

async function captureCompletedSwept(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const { ref } = writeMemory(root, JOURNAL_SILENT_LEAK_NAME);

    const staleOp: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(JOURNAL_STALE_OP_REF_NAME), reason: "stale" };
    writeRawJournalFile(root, {
      startedAt: "2020-01-01T00:00:00.000Z",
      operations: [staleOp] satisfies ConsolidateOperation[],
      completed: [staleOp.ref], // completed === operations.length -> NOT incomplete
    });
    fs.mkdirSync(craftedBackupDir(root), { recursive: true });
    fs.writeFileSync(path.join(craftedBackupDir(root), "orphaned.md"), "orphaned backup content", "utf8");

    overrideSeam(_setChatCompletionForTests, async () =>
      JSON.stringify({ operations: [{ op: "delete", ref, reason: "redundant" }] }),
    );

    const result = await akmConsolidate({ stashDir: root, target: root, config: CONFIG, assumeYes: true });

    return {
      ok: result.ok,
      deleted: result.deleted,
      // The legacy engine's "silent leak" (a completed-but-never-cleaned
      // journal's backup dir was never reclaimed) is GONE: per-transaction
      // dirs let the run-entry check sweep committed leftovers whole.
      staleCommittedLeftoverSwept: !fs.existsSync(craftedTxnDir(root)),
      namespaceCleanAfterRun: namespaceIsClean(root),
    };
  } finally {
    storage.cleanup();
  }
}

describe("checkForIncompleteJournal recovery-mode matrix (run-entry, abort|clean)", () => {
  test('incomplete journal + recoveryMode "abort" (default) -> throws with backup-dir hint; nothing removed', async () => {
    const captured = await captureAbortIncomplete();
    expect(captured.threw).toBe(true);
    expect(captured.isConfigError).toBe(true);
    expect(captured.code).toBe("INVALID_CONFIG_FILE");
    expect(captured.messageContainsIncompleteDetected).toBe(true);
    expect(captured.messageContainsBackupHint).toBe(true);
    expect(captured.journalStillExists).toBe(true);
    expect(captured.backupDirStillExists).toBe(true);
  });

  test("unreadable (malformed JSON) journal, default abort mode -> ConfigError INVALID_CONFIG_FILE", async () => {
    const captured = await captureAbortUnreadable();
    expect(captured.threw).toBe(true);
    expect(captured.isConfigError).toBe(true);
    expect(captured.code).toBe("INVALID_CONFIG_FILE");
    expect(captured.messageContainsUnreadable).toBe(true);
    expect(captured.journalStillExists).toBe(true);
  });

  test('recoveryMode "clean" on an incomplete journal -> the transaction dir (journal AND backups) is removed', async () => {
    const captured = await captureCleanIncomplete();
    expect(captured.ok).toBe(true);
    expect(captured.processed).toBe(0);
    expect(captured.journalRemoved).toBe(true);
    expect(captured.backupDirRemoved).toBe(true);
  });

  test("completed >= operations -> committed leftover swept quietly (the legacy orphaned-backup leak is gone)", async () => {
    const captured = await captureCompletedSwept();
    expect(captured.ok).toBe(true);
    expect(captured.deleted).toBe(1);
    expect(captured.staleCommittedLeftoverSwept).toBe(true);
    expect(captured.namespaceCleanAfterRun).toBe(true);
  });
});

// ── Capture: consolidateGuardStatus verdict matrix ──────────────────────────

function captureGuardVerdicts(root: string): Record<string, string> {
  const hot = writeMemory(root, GUARD_HOT_NAME, { captureMode: "hot" });
  const safe = writeMemory(root, GUARD_SAFE_NAME, {});
  const unparseablePath = memoryPath(root, GUARD_UNPARSEABLE_NAME);
  fs.mkdirSync(path.dirname(unparseablePath), { recursive: true });
  fs.writeFileSync(unparseablePath, "Just a body, no frontmatter delimiters at all.\n", "utf8");
  const missingPath = memoryPath(root, GUARD_MISSING_NAME); // deliberately never written

  return {
    hot: consolidateGuardStatus(hot.filePath),
    safe: consolidateGuardStatus(safe.filePath),
    unparseable: consolidateGuardStatus(unparseablePath),
    missing: consolidateGuardStatus(missingPath),
  };
}

describe("consolidateGuardStatus verdict matrix (consolidate/eligibility.ts:60)", () => {
  // Prompt-level hot-list annotation (a different concern from this pure
  // predicate) is already covered by tests/commands/consolidate/consolidate-chunks.test.ts
  // -- referenced here, not duplicated.
  test("hot / safe / unparseable / missing", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const verdicts = captureGuardVerdicts(storage.stashDir);
      expect(verdicts.hot).toBe("hot");
      expect(verdicts.safe).toBe("safe");
      expect(verdicts.unparseable).toBe("unparseable");
      expect(verdicts.missing).toBe("missing");
    } finally {
      storage.cleanup();
    }
  });
});

// ── Golden fixtures: serialize every scenario above ─────────────────────────

test("golden fixture: journal-lifecycle.json (full-run lifecycle + all-hot zero-LLM)", async () => {
  const fullRunLifecycle = await captureFullRunLifecycle();
  const allHotZeroLlm = await captureAllHotZeroLlm();

  expectGolden(GOLDEN_LIFECYCLE_PATH, {
    scenario: "consolidate journal round-trip: full-run lifecycle + all-hot chunk early-exit (WI-06, R5)",
    capturedAtHead: HEAD_SHA,
    notes: [
      "Re-captured at WI-6.3e: the consolidate checklist journal rides the unified fs-txn engine (kind `consolidate`, " +
        "root = stash; backups under the transaction dir). Write-time shape observed via " +
        "spyOn(fs.writeFileSync/copyFileSync) interception of the engine's durable journal.json.tmp writes around a " +
        "REAL akmConsolidate run.",
      "Only the write COUNT and each write's parsed phase/checklist shape are recorded as informational data " +
        "(brief §3.2 rule 4) -- never raw journal bytes or directory layout.",
      "fullRunLifecycle.firstJournalWrite/lastJournalWrite.operations[].ref embeds a fixture-local ref " +
        "(tests/fixtures/goldens/consolidate/fixture-refs.ts) -- re-baseline @ 5 caveat on that field only.",
    ],
    cases: { fullRunLifecycle, allHotZeroLlm },
  });
});

test("golden fixture: journal-recovery.json (checkForIncompleteJournal recovery-mode matrix)", async () => {
  const abortIncomplete = await captureAbortIncomplete();
  const abortUnreadable = await captureAbortUnreadable();
  const cleanIncomplete = await captureCleanIncomplete();
  const completedSwept = await captureCompletedSwept();

  expectGolden(GOLDEN_RECOVERY_PATH, {
    scenario: "consolidate journal recovery-mode matrix: checkForIncompleteJournal (WI-06, R5)",
    capturedAtHead: HEAD_SHA,
    notes: [
      "Re-captured at WI-6.3e (unified fs-txn engine). Recovery stays a run-entry decision: abort (default) refuses " +
        "the run with the same ConfigError guidance; clean removes the stale transaction dir (journal + backups " +
        "together -- the legacy scheme's two backup-timestamp derivations collapsed with the timestamped backup " +
        "dirs). The legacy characterization surprise (a completed-but-never-cleaned journal's backup dir leaking " +
        "forever) is GONE: committed leftovers are swept whole at the run-entry check.",
      "No ref literals appear anywhere in this fixture: every case here reports only booleans, counts, and the " +
        "ConfigError code string -- no ref-grammar re-baseline caveat applies.",
    ],
    cases: {
      abortIncomplete,
      abortUnreadable,
      cleanIncomplete,
      completedSwept,
    },
  });
});

test("golden fixture: journal-guard-verdicts.json (consolidateGuardStatus verdict matrix)", () => {
  const storage = withIsolatedAkmStorage();
  let verdicts: Record<string, string>;
  try {
    verdicts = captureGuardVerdicts(storage.stashDir);
  } finally {
    storage.cleanup();
  }

  expectGolden(GOLDEN_GUARD_PATH, {
    scenario: "consolidateGuardStatus verdict matrix (consolidate/eligibility.ts:60) (WI-06, R5)",
    capturedAtHead: HEAD_SHA,
    notes: [
      "Prompt-level hot-list annotation is a different concern, covered by consolidate-chunks.test.ts -- referenced, " +
        "not duplicated here. No ref literals appear in this fixture (verdict strings only).",
    ],
    verdicts,
  });
});
