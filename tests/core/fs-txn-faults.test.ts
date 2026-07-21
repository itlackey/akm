// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-6.7 — the plan's Chunk-6 gate "one-transaction fault tests green"
 * (§15.7): fault-injection suite for the unified filesystem-transaction
 * engine (src/core/fs-txn.ts).
 *
 * Uses a synthetic kind that implements the SAME multi-file batch apply
 * discipline the domain kinds use (per-file before-hash verification →
 * displace-to-backup inside the transaction dir → durable write → commit
 * phase → finalize), and proves:
 *
 *   1. a fault injected at EVERY index of a multi-file FileChange[] batch,
 *      before the kind's commit phase, leaves NO partial write once recovery
 *      runs — every update target byte-identical to its pre-transaction
 *      content and the create target absent;
 *   2. a fault after the commit phase rolls FORWARD: the whole batch lands
 *      (all targets carry their new content) and the journal is retired;
 *   3. a before-hash mismatch detected mid-batch aborts the WHOLE batch —
 *      files applied earlier in the batch are rolled back, the diverged
 *      file keeps the concurrent editor's bytes, nothing else is written;
 *   4. every fault path ends with the engine namespace clean (no leaked
 *      transaction dirs, journals, or backups).
 *
 * Domain-kind semantics stay pinned by their own suites + the frozen
 * outcome oracles (journal/proposal-txn.json, journal/move-txn.json); this
 * suite exercises the ENGINE's batch story with synthetic kinds only, like
 * tests/core/fs-txn.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  _setTxnMutationHookForTests,
  advanceTxn,
  beginTxn,
  cleanupTxn,
  type JournaledFileChange,
  recoverTxnsForRoot,
  registerTxnKind,
  type Txn,
  txnFileHash,
  txnMutationHook,
  txnNamespaceDir,
  writeTxnFileDurably,
} from "../../src/core/fs-txn";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  _setTxnMutationHookForTests(undefined);
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshRoot(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

// ── Synthetic batch kind ─────────────────────────────────────────────────────
//
// Payload records, per change, where its displaced backup lives (null for a
// create) and where the staged "after" content lives — both INSIDE the
// transaction dir, so rollback and roll-forward need nothing but the journal.

interface BatchEntry {
  target: string;
  backupName: string | null;
  contentName: string;
}

interface BatchPayload {
  entries: BatchEntry[];
}

type BatchTxn = Txn<BatchPayload>;

const BATCH_PHASES = ["prepared", "files-published", "state-persisted", "committed"] as const;

function restoreBatch(txn: BatchTxn): void {
  // Rollback: walk the batch and put every target back to its
  // pre-transaction state. Applied-then-faulted entries have a backup (or
  // were creates); untouched entries' backups simply don't exist yet.
  for (const entry of txn.journal.payload.entries) {
    if (entry.backupName !== null) {
      const backupPath = path.join(txn.dir, entry.backupName);
      if (fs.existsSync(backupPath)) {
        writeTxnFileDurably(entry.target, fs.readFileSync(backupPath));
      }
    } else if (fs.existsSync(entry.target)) {
      // A create that had already been applied: undo it entirely.
      fs.rmSync(entry.target, { force: true });
    }
  }
}

function finishBatch(txn: BatchTxn): void {
  // Roll-forward: re-apply every change from the staged content (idempotent
  // — durable rewrite of the same bytes), then walk the remaining phases.
  if (txn.journal.phase === "files-published") {
    for (const entry of txn.journal.payload.entries) {
      const staged = fs.readFileSync(path.join(txn.dir, entry.contentName));
      writeTxnFileDurably(entry.target, staged);
    }
    advanceTxn(txn, "state-persisted");
  }
  if (txn.journal.phase === "state-persisted") {
    advanceTxn(txn, "committed");
  }
}

function registerBatchKind(kind: string): void {
  registerTxnKind<BatchPayload>(kind, {
    phases: [...BATCH_PHASES],
    commitPhase: "files-published",
    rollback: restoreBatch,
    finalize: finishBatch,
  });
}

interface BatchTarget {
  rel: string;
  after: string;
}

/**
 * The apply procedure under test — the same shape the domain kinds use:
 * journal first, stage content + verify before-hash + displace + write per
 * file (with a mutation-hook fault point after each file), then advance to
 * the commit phase and finalize.
 *
 * On a mid-batch abort (before-hash divergence) the batch rolls itself back
 * in-process and rethrows, exactly like the domain kinds' abort windows.
 */
function applyBatch(kind: string, root: string, targets: BatchTarget[]): void {
  const changes: JournaledFileChange[] = [];
  const entries: BatchEntry[] = [];
  for (const [i, t] of targets.entries()) {
    const abs = path.join(root, t.rel);
    const exists = fs.existsSync(abs);
    changes.push({
      path: abs,
      op: exists ? "update" : "create",
      beforeHash: exists ? txnFileHash(abs) : null,
      afterHash: null,
    });
    entries.push({
      target: abs,
      backupName: exists ? `backup-${i}` : null,
      contentName: `content-${i}`,
    });
  }

  const txn = beginTxn<BatchPayload>({ kind, root, changes, payload: { entries } });

  // Stage every "after" body inside the transaction dir before touching any
  // target, so roll-forward can finish the batch from the journal alone.
  for (const [i, t] of targets.entries()) {
    writeTxnFileDurably(path.join(txn.dir, `content-${i}`), t.after);
  }

  try {
    for (const [i, change] of txn.journal.changes.entries()) {
      const entry = entries[i] as BatchEntry;
      // Before-hash verification at the displace window (same rule the
      // domain kinds enforce): a diverged target aborts the WHOLE batch.
      if (change.beforeHash !== null) {
        const now = fs.existsSync(change.path) ? txnFileHash(change.path) : null;
        if (now !== change.beforeHash) {
          throw new Error(`Cannot apply batch transaction: ${change.path} diverged.`);
        }
        fs.copyFileSync(change.path, path.join(txn.dir, entry.backupName as string));
      }
      writeTxnFileDurably(change.path, targets[i]?.after ?? "");
      txnMutationHook(`batch-file-applied:${i}`);
    }
  } catch (error) {
    // Known aborts (before-hash divergence) roll back in-process, like the
    // domain kinds' abort windows. Anything else models a HARD crash
    // mid-batch: the journal must stay on disk for recovery to finish the
    // story, exactly as after a SIGKILL.
    if (error instanceof Error && /diverged/.test(error.message)) {
      restoreBatch(txn);
      cleanupTxn(txn.dir);
    }
    throw error;
  }

  advanceTxn(txn, "files-published");
  txnMutationHook("batch-committed");
  finishBatch(txn);
  cleanupTxn(txn.dir);
}

function seed(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function faultAt(point: string): void {
  _setTxnMutationHookForTests((p) => {
    if (p === point) throw new Error(`injected fault at ${p}`);
  });
}

const ORIGINALS: Record<string, string> = {
  "lessons/batch-a.md": "original A\n",
  "lessons/batch-b.md": "original B\n",
};
const BATCH: BatchTarget[] = [
  { rel: "lessons/batch-a.md", after: "rewritten A\n" },
  { rel: "lessons/batch-b.md", after: "rewritten B\n" },
  { rel: "lessons/batch-new.md", after: "brand new C\n" },
];

function seedBatch(root: string): void {
  for (const [rel, body] of Object.entries(ORIGINALS)) seed(root, rel, body);
}

function readOrNull(root: string, rel: string): string | null {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

describe("fs-txn fault injection (WI-6.7, plan Chunk-6 gate)", () => {
  test.each([0, 1, 2])("mid-apply fault after file %i: recovery leaves NO partial write", async (faultIndex) => {
    const root = freshRoot();
    const kind = `fault-batch-mid-${faultIndex}`;
    registerBatchKind(kind);
    seedBatch(root);

    faultAt(`batch-file-applied:${faultIndex}`);
    expect(() => applyBatch(kind, root, BATCH)).toThrow(/injected fault/);
    _setTxnMutationHookForTests(undefined);

    // The fault genuinely left the batch mid-flight: the faulted file (and
    // any earlier ones) already carry new content on disk.
    expect(readOrNull(root, BATCH[faultIndex]?.rel as string)).toBe(BATCH[faultIndex]!.after);

    // Recovery (journal still before the commit phase) rolls the WHOLE
    // batch back: updates byte-identical to their originals, create gone.
    const recovered = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(1);
    expect(readOrNull(root, "lessons/batch-a.md")).toBe(ORIGINALS["lessons/batch-a.md"] as string);
    expect(readOrNull(root, "lessons/batch-b.md")).toBe(ORIGINALS["lessons/batch-b.md"] as string);
    expect(readOrNull(root, "lessons/batch-new.md")).toBeNull();
    expect(fs.existsSync(txnNamespaceDir(root))).toBe(false);
  });

  test("fault after the commit phase: recovery rolls the whole batch FORWARD", async () => {
    const root = freshRoot();
    registerBatchKind("fault-batch-forward");
    seedBatch(root);

    faultAt("batch-committed");
    expect(() => applyBatch("fault-batch-forward", root, BATCH)).toThrow(/injected fault/);
    _setTxnMutationHookForTests(undefined);

    // Destroy one already-applied target before recovery runs, so finalize's
    // forward work is OBSERVED (it must re-materialize the file from the
    // staged content), not inferred from bytes the apply loop already wrote.
    fs.rmSync(path.join(root, "lessons/batch-b.md"));

    const recovered = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(1);
    expect(readOrNull(root, "lessons/batch-a.md")).toBe(BATCH[0]!.after);
    expect(readOrNull(root, "lessons/batch-b.md")).toBe(BATCH[1]!.after);
    expect(readOrNull(root, "lessons/batch-new.md")).toBe(BATCH[2]!.after);
    expect(fs.existsSync(txnNamespaceDir(root))).toBe(false);
  });

  test("before-hash mismatch mid-batch aborts the WHOLE batch (earlier files rolled back)", () => {
    const root = freshRoot();
    registerBatchKind("fault-batch-diverged");
    seedBatch(root);

    // A concurrent editor rewrites file B between journal mint and its
    // displace window: intercept after file A applies, then mutate B.
    const editorBytes = "concurrent editor won\n";
    _setTxnMutationHookForTests((p) => {
      if (p === "batch-file-applied:0") {
        fs.writeFileSync(path.join(root, "lessons/batch-b.md"), editorBytes);
      }
    });

    expect(() => applyBatch("fault-batch-diverged", root, BATCH)).toThrow(/diverged/);
    _setTxnMutationHookForTests(undefined);

    // File A (already applied when the divergence surfaced) is restored;
    // the diverged file keeps the editor's bytes; the create never landed.
    expect(readOrNull(root, "lessons/batch-a.md")).toBe(ORIGINALS["lessons/batch-a.md"] as string);
    expect(readOrNull(root, "lessons/batch-b.md")).toBe(editorBytes);
    expect(readOrNull(root, "lessons/batch-new.md")).toBeNull();
    // The abort cleaned its own transaction dir — nothing left to recover.
    expect(fs.existsSync(txnNamespaceDir(root))).toBe(false);
  });

  test("a fresh batch on the same root succeeds after a rolled-back fault", async () => {
    const root = freshRoot();
    registerBatchKind("fault-batch-retry");
    seedBatch(root);

    faultAt("batch-file-applied:1");
    expect(() => applyBatch("fault-batch-retry", root, BATCH)).toThrow(/injected fault/);
    _setTxnMutationHookForTests(undefined);
    await recoverTxnsForRoot(root);

    applyBatch("fault-batch-retry", root, BATCH);
    expect(readOrNull(root, "lessons/batch-a.md")).toBe(BATCH[0]!.after);
    expect(readOrNull(root, "lessons/batch-b.md")).toBe(BATCH[1]!.after);
    expect(readOrNull(root, "lessons/batch-new.md")).toBe(BATCH[2]!.after);
    expect(fs.existsSync(txnNamespaceDir(root))).toBe(false);
  });
});
