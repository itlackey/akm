// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: consolidate journal round-trip + hot-capture guard (WI-06,
 * plan §11 Chunk 0a / R5). Chunk 0a brief §2.3, `anchors.md`
 * `consolidate.ts:657` (`getJournalPath`), `:661` (`getBackupDir`), `:665-690`
 * (`removeStaleJournal`), `:692-735` (`checkForIncompleteJournal`, invoked at
 * `:1012`), `:737-747` (`writeJournal`), `:749-759` (`markJournalCompleted`),
 * `:761-774` (`cleanupJournal`), `:776-783` (`backupFile`), `:1617-1636`
 * (all-hot chunk early-exit); `consolidate/eligibility.ts:60`
 * (`consolidateGuardStatus`).
 *
 * ## Harness — real `akmConsolidate` runs; interrupted state via crafted journal files
 *
 * Per brief step 1: the full-run lifecycle and all-hot scenarios drive the
 * REAL `akmConsolidate` (stubbed LLM transport via `_setChatCompletionForTests`)
 * so `writeJournal`/`backupFile`/`markJournalCompleted`/`cleanupJournal` all
 * execute for real. Since none of those journal helpers are exported (they are
 * module-private to `consolidate.ts`), the write-time SHAPE of the journal is
 * observed via `spyOn(fs, "writeFileSync"/"copyFileSync")` interception — the
 * same `src/`-change-free technique WI-04's `goldens-mv-txn.test.ts` uses for
 * its stage/replace-divergence scenarios (see that suite's header comment).
 * The recovery-mode scenarios (abort/clean/unreadable/completed) instead craft
 * an INTERRUPTED journal fixture directly on disk (JSON, hand-written) and let
 * `checkForIncompleteJournal` (invoked at the very top of `akmConsolidate`,
 * before any memory pool work) observe it — this keeps the suite unit-scope
 * (no process spawns / SIGKILL timing needed).
 *
 * ## Characterization warning (brief step 2, Risk 8)
 *
 * Journal recovery paths have ZERO existing test coverage at HEAD. The
 * `completed >= operations` "silent cleanup" scenario below captures a
 * genuinely surprising outcome: `checkForIncompleteJournal` treats a
 * fully-completed-but-never-cleaned-up journal as NOT incomplete and does
 * nothing to it (no throw, no removal) — the stale journal file only gets
 * swept away as a SIDE EFFECT of the next run's own `writeJournal` overwrite +
 * `cleanupJournal`, and that next run's `cleanupJournal` only removes the
 * timestamp it itself used. The STALE journal's own backup directory (a
 * different timestamp) is an ORPHAN that is never reclaimed by any code path
 * this suite can find. This is captured AS-IS, not fixed — see the scenario's
 * `notes` field in the fixture and the WI-08 report.
 *
 * ## Code-organization note (deviation from WI-03/04/05's literal-duplication style)
 *
 * WI-03/04/05 re-run each scenario's setup TWICE — once inline inside an
 * assertion `test()`, once again (separately written) inside a final
 * "golden fixture: serialize" test — explicitly so the golden capture does
 * not depend on which subset of tests bun:test happened to execute. This
 * suite achieves the same order-independence a different way: each `capture*`
 * helper below is a single, fully self-contained function (fresh sandbox
 * in, fresh sandbox torn down on exit, no shared mutable state) that is
 * idempotent and side-effect-free across repeated invocations. Assertion
 * `test()` blocks and the final golden-serializing tests both call the SAME
 * `capture*` helper — never a hand-duplicated copy of its body — so there is
 * no risk of the two diverging, and no risk of the golden depending on test
 * execution order (every call constructs its own isolated world).
 *
 * ## Designation
 *
 * `frozen-migration-input` (`DESIGNATIONS.json`) for all three fixtures this
 * suite writes. `journal-lifecycle.json`'s captured journal `operations[].ref`
 * embeds a fixture-local ref string (`tests/fixtures/goldens/consolidate/fixture-refs.ts`)
 * — noted as a re-baseline-@-5 caveat on that one field, same convention as
 * WI-03/04's fileTree-key caveats, WITHOUT changing the asset's overall
 * designation. `journal-recovery.json` and `journal-guard-verdicts.json`
 * contain no ref literals at all (only booleans/counts/verdict strings).
 *
 * Journal phase/shape details are recorded as INFORMATIONAL data only (brief
 * §3.2 rule 4) — Chunk 6 replaces these journals wholesale; only the
 * observable outcomes (file/dir existence, op counts, error classification)
 * are the preserved contract.
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
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

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

// ── Path helpers (mirror the module-private getJournalPath/getBackupDir) ───

function journalFilePath(stashDir: string): string {
  return path.join(stashDir, ".akm", "consolidate-journal.json");
}

function backupDirFor(stashDir: string, timestamp: string): string {
  return path.join(stashDir, ".akm", "consolidate-backup", timestamp);
}

function writeRawJournalFile(stashDir: string, journal: unknown): void {
  const p = journalFilePath(stashDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(journal, null, 2), "utf8");
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

    const journalWrites: Array<{
      startedAt: unknown;
      operations: unknown;
      completed: unknown;
      backupTimestamp: unknown;
    }> = [];
    const backupCopyBasenames: string[] = [];

    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      ...args: unknown[]
    ) => {
      const result = originalWriteFileSync(file, data, ...(args as [fs.WriteFileOptions?]));
      if (path.basename(String(file)) === "consolidate-journal.json") {
        journalWrites.push(JSON.parse(String(data)));
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
      if (String(dest).includes(`${path.sep}consolidate-backup${path.sep}`)) {
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

    const capturedBackupTimestamp = journalWrites[0]?.backupTimestamp as string | undefined;

    return {
      chatCompletionCallCount: chatCalls,
      deleted: result.deleted,
      ok: result.ok,
      journalWriteCount: journalWrites.length,
      firstJournalWrite: journalWrites[0],
      lastJournalWrite: journalWrites[journalWrites.length - 1],
      backupCopyBasenames,
      journalExistsAfterRun: fs.existsSync(journalFilePath(root)),
      backupDirExistsAfterRun: capturedBackupTimestamp
        ? fs.existsSync(backupDirFor(root, capturedBackupTimestamp))
        : undefined,
    };
  } finally {
    storage.cleanup();
  }
}

describe("full-run journal lifecycle (writeJournal/backupFile/markJournalCompleted/cleanupJournal)", () => {
  test("real akmConsolidate run: journal shape, backup copy, and end-state removal", async () => {
    const captured = await captureFullRunLifecycle();

    expect(captured.chatCompletionCallCount).toBe(1);
    expect(captured.deleted).toBe(1);
    expect(captured.ok).toBe(true);

    // writeJournal (:737-747): started empty-completed; markJournalCompleted
    // (:749-759): a second write appends the completed op ref.
    expect(captured.journalWriteCount).toBe(2);
    const first = captured.firstJournalWrite as { operations: unknown[]; completed: unknown[] };
    const last = captured.lastJournalWrite as { operations: unknown[]; completed: string[] };
    expect(first.operations).toHaveLength(1);
    expect(first.completed).toEqual([]);
    expect(last.operations).toEqual(first.operations);
    expect(last.completed).toEqual([memoryRef(JOURNAL_LIFECYCLE_NAME)]);

    // backupFile (:776-783): the deleted memory's content is copied into the
    // backup dir before the archive+hard-delete.
    expect(captured.backupCopyBasenames).toEqual([`${JOURNAL_LIFECYCLE_NAME}.md`]);

    // cleanupJournal (:761-774): both the journal file and its run's backup
    // dir are gone once the run completes successfully.
    expect(captured.journalExistsAfterRun).toBe(false);
    expect(captured.backupDirExistsAfterRun).toBe(false);
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
    const ts = "2026-05-01T00-00-00-000Z";
    const opA: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(JOURNAL_STALE_OP_REF_NAME), reason: "x" };
    const opB: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(`${JOURNAL_STALE_OP_REF_NAME}-2`), reason: "x" };
    writeRawJournalFile(root, {
      startedAt: "2026-05-01T00:00:00.000Z",
      operations: [opA, opB] satisfies ConsolidateOperation[],
      completed: [opA.ref], // 1 of 2 completed -> incomplete
      backupTimestamp: ts,
    });
    fs.mkdirSync(backupDirFor(root, ts), { recursive: true });
    fs.writeFileSync(path.join(backupDirFor(root, ts), "placeholder.md"), "x", "utf8");

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
      journalStillExists: fs.existsSync(journalFilePath(root)),
      backupDirStillExists: fs.existsSync(backupDirFor(root, ts)),
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
    const p = journalFilePath(root);
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
// Covers both derivations of the backup-dir timestamp (:673-678): an explicit
// `backupTimestamp` field, and the `startedAt` fallback (`[:.]` -> `-`) used
// when `backupTimestamp` is absent.

async function captureCleanIncomplete(useStartedAtFallback: boolean): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const startedAtIso = "2026-05-01T00:00:00.000Z";
    const explicitTs = "2026-05-01T01-00-00-000Z";
    const expectedBackupTs = useStartedAtFallback ? startedAtIso.replace(/[:.]/g, "-") : explicitTs;
    const op: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(JOURNAL_STALE_OP_REF_NAME), reason: "x" };
    writeRawJournalFile(root, {
      startedAt: startedAtIso,
      operations: [op] satisfies ConsolidateOperation[],
      completed: [],
      ...(useStartedAtFallback ? {} : { backupTimestamp: explicitTs }),
    });
    fs.mkdirSync(backupDirFor(root, expectedBackupTs), { recursive: true });

    const result = await akmConsolidate({
      stashDir: root,
      target: root,
      config: CONFIG,
      recoveryMode: "clean",
    });

    return {
      ok: result.ok,
      processed: result.processed,
      journalRemoved: !fs.existsSync(journalFilePath(root)),
      backupDirRemoved: !fs.existsSync(backupDirFor(root, expectedBackupTs)),
    };
  } finally {
    storage.cleanup();
  }
}

// ── Capture: completed >= operations -> silently passed through (surprise) ─

async function captureCompletedSilentLeak(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const root = storage.stashDir;
    const { ref } = writeMemory(root, JOURNAL_SILENT_LEAK_NAME);

    const staleTs = "2020-01-01T00-00-00-000Z";
    const staleOp: ConsolidateDeleteOp = { op: "delete", ref: memoryRef(JOURNAL_STALE_OP_REF_NAME), reason: "stale" };
    writeRawJournalFile(root, {
      startedAt: "2020-01-01T00:00:00.000Z",
      operations: [staleOp] satisfies ConsolidateOperation[],
      completed: [staleOp.ref], // completed === operations.length -> NOT incomplete
      backupTimestamp: staleTs,
    });
    const staleBackupDir = backupDirFor(root, staleTs);
    fs.mkdirSync(staleBackupDir, { recursive: true });
    fs.writeFileSync(path.join(staleBackupDir, "orphaned.md"), "orphaned backup content", "utf8");

    overrideSeam(_setChatCompletionForTests, async () =>
      JSON.stringify({ operations: [{ op: "delete", ref, reason: "redundant" }] }),
    );

    const result = await akmConsolidate({ stashDir: root, target: root, config: CONFIG, assumeYes: true });

    return {
      ok: result.ok,
      deleted: result.deleted,
      journalGoneAfterFreshRun: !fs.existsSync(journalFilePath(root)),
      // CHARACTERIZATION SURPRISE (do not fix): checkForIncompleteJournal never
      // flagged the stale "completed" journal as incomplete, so it never called
      // removeStaleJournal on it -- the stale journal's OWN backup dir is an
      // orphan this run's cleanupJournal (which only knows its OWN fresh
      // timestamp) cannot and does not reach.
      staleOrphanedBackupDirStillPresent: fs.existsSync(staleBackupDir),
    };
  } finally {
    storage.cleanup();
  }
}

describe("checkForIncompleteJournal recovery-mode matrix (:692-735, invoked at :1012)", () => {
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

  test('recoveryMode "clean" on an incomplete journal -> removeStaleJournal removes journal AND backup dir (explicit backupTimestamp)', async () => {
    const captured = await captureCleanIncomplete(false);
    expect(captured.ok).toBe(true);
    expect(captured.processed).toBe(0);
    expect(captured.journalRemoved).toBe(true);
    expect(captured.backupDirRemoved).toBe(true);
  });

  test('recoveryMode "clean" on an incomplete journal -> backup dir derived from startedAt fallback ([:.]->-) is also removed', async () => {
    const captured = await captureCleanIncomplete(true);
    expect(captured.ok).toBe(true);
    expect(captured.journalRemoved).toBe(true);
    expect(captured.backupDirRemoved).toBe(true);
  });

  test("completed >= operations -> treated as not-incomplete; silently overwritten/cleaned by the NEXT successful run, but its own stale backup dir leaks", async () => {
    const captured = await captureCompletedSilentLeak();
    expect(captured.ok).toBe(true);
    expect(captured.deleted).toBe(1);
    expect(captured.journalGoneAfterFreshRun).toBe(true);
    expect(captured.staleOrphanedBackupDirStillPresent).toBe(true);
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
      "Journal helpers (getJournalPath/writeJournal/markJournalCompleted/cleanupJournal/backupFile) are module-private " +
        "to consolidate.ts -- their write-time shape is observed via spyOn(fs.writeFileSync/copyFileSync) interception " +
        "around a REAL akmConsolidate run (src/-change-free technique, same as WI-04's goldens-mv-txn.test.ts).",
      "journalPhasesObserved encoding (brief §3.2 rule 4): only the write COUNT and each write's parsed shape are " +
        "recorded as informational data -- never asserted against raw journal bytes or directory layout.",
      "fullRunLifecycle.firstJournalWrite/lastJournalWrite.operations[].ref embeds a fixture-local ref " +
        "(tests/fixtures/goldens/consolidate/fixture-refs.ts) -- re-baseline @ 5 caveat on that field only; the asset " +
        "as a whole stays frozen-migration-input (same convention as the WI-03/04 fileTree-key caveats).",
    ],
    cases: { fullRunLifecycle, allHotZeroLlm },
  });
});

test("golden fixture: journal-recovery.json (checkForIncompleteJournal recovery-mode matrix)", async () => {
  const abortIncomplete = await captureAbortIncomplete();
  const abortUnreadable = await captureAbortUnreadable();
  const cleanIncompleteExplicitBackupTimestamp = await captureCleanIncomplete(false);
  const cleanIncompleteStartedAtFallback = await captureCleanIncomplete(true);
  const completedSilentLeak = await captureCompletedSilentLeak();

  expectGolden(GOLDEN_RECOVERY_PATH, {
    scenario: "consolidate journal recovery-mode matrix: checkForIncompleteJournal (WI-06, R5)",
    capturedAtHead: HEAD_SHA,
    notes: [
      "CHARACTERIZATION WARNING (brief step 2, Risk 8): journal recovery paths have ZERO existing test coverage at " +
        "HEAD. completedSilentLeak.staleOrphanedBackupDirStillPresent=true is a genuinely surprising outcome -- a " +
        "fully-completed-but-never-cleaned-up journal's OWN backup directory is never reclaimed by any code path this " +
        "suite can find (checkForIncompleteJournal silently no-ops on it; the NEXT run's cleanupJournal only removes " +
        "its OWN fresh timestamp's backup dir). Captured as-is per plan §15.5 -- never fixed by this chunk.",
      "No ref literals appear anywhere in this fixture: every case here reports only booleans, counts, and the " +
        "ConfigError code string -- no ref-grammar re-baseline caveat applies.",
    ],
    cases: {
      abortIncomplete,
      abortUnreadable,
      cleanIncompleteExplicitBackupTimestamp,
      cleanIncompleteStartedAtFallback,
      completedSilentLeak,
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
