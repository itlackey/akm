// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-6.3a — unit contract for the unified filesystem-transaction engine
 * (src/core/fs-txn.ts): journal home/format, durable phase progression,
 * rollback-vs-roll-forward dispatch at the kind's commit point, engine safety
 * fences, cleanup sweeping, and cross-namespace journal listing.
 *
 * Domain kinds (proposal accept/revert/reject, mv, consolidate) get their
 * semantics pinned by their own suites + the frozen outcome oracles; this
 * suite exercises the ENGINE with synthetic kinds only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  advanceTxn,
  beginTxn,
  cleanupTxn,
  isCommittedPhase,
  type JournaledFileChange,
  listTxnJournals,
  recoverTxnsForRoot,
  registerTxnKind,
  type Txn,
  type TxnJournal,
  txnNamespaceDir,
} from "../../src/core/fs-txn";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshRoot(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

/** Register a synthetic 4-phase kind recording rollback/finalize calls. */
function registerRecordingKind(kind: string, calls: string[]): void {
  registerTxnKind<{ label: string }>(kind, {
    phases: ["prepared", "files-published", "state-persisted", "committed"],
    commitPhase: "files-published",
    rollback(txn) {
      calls.push(`rollback:${txn.journal.payload.label}`);
    },
    finalize(txn) {
      calls.push(`finalize:${txn.journal.payload.label}@${txn.journal.phase}`);
      if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
      if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
    },
  });
}

function change(root: string, rel: string): JournaledFileChange {
  return { path: path.join(root, rel), op: "update", beforeHash: "b".repeat(64), afterHash: "a".repeat(64) };
}

describe("fs-txn engine core", () => {
  test("beginTxn writes the journal at the initial phase under the one home", () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-begin", calls);
    const txn = beginTxn({
      kind: "test-kind-begin",
      root,
      changes: [change(root, "lessons/a.md")],
      payload: { label: "t1" },
    });

    expect(txn.dir.startsWith(txnNamespaceDir(root))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<{ label: string }>;
    expect(onDisk.kind).toBe("test-kind-begin");
    expect(onDisk.phase).toBe("prepared");
    expect(onDisk.root).toBe(path.resolve(root));
    expect(onDisk.payload.label).toBe("t1");
    expect(onDisk.changes).toHaveLength(1);
    cleanupTxn(txn.dir);
  });

  test("advanceTxn durably records phases and refuses unknown phases", () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-advance", []);
    const txn = beginTxn({ kind: "test-kind-advance", root, changes: [], payload: { label: "t2" } });

    advanceTxn(txn, "files-published");
    expect(txn.journal.phase).toBe("files-published");
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<unknown>;
    expect(onDisk.phase).toBe("files-published");
    // No leftover .tmp — the write is rename-committed.
    expect(fs.existsSync(`${txn.journalPath}.tmp`)).toBe(false);

    expect(() => advanceTxn(txn, "not-a-phase")).toThrow(/Unknown phase/);
    cleanupTxn(txn.dir);
  });

  test("recovery rolls BACK journals before the commit point and FORWARD from it", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-recover", calls);

    const rollbackMe = beginTxn({ kind: "test-kind-recover", root, changes: [], payload: { label: "rb" } });
    void rollbackMe; // stays at "prepared" — before the commit point

    const forwardMe = beginTxn({ kind: "test-kind-recover", root, changes: [], payload: { label: "fw" } });
    advanceTxn(forwardMe, "files-published");

    const doneAlready = beginTxn({ kind: "test-kind-recover", root, changes: [], payload: { label: "done" } });
    advanceTxn(doneAlready, "committed");

    const recovered = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(3);
    expect(calls.sort()).toEqual(["finalize:fw@files-published", "rollback:rb"]);
    // Every transaction dir is swept after recovery.
    const nsDir = txnNamespaceDir(root);
    expect(fs.existsSync(nsDir)).toBe(false);
  });

  test("isCommittedPhase respects the kind's commit point", () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-commitpoint", []);
    const txn = beginTxn({ kind: "test-kind-commitpoint", root, changes: [], payload: { label: "cp" } });
    expect(isCommittedPhase(txn.journal)).toBe(false);
    advanceTxn(txn, "files-published");
    expect(isCommittedPhase(txn.journal)).toBe(true);
    cleanupTxn(txn.dir);
  });

  test("recovery refuses journals whose changes escape the root", async () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-fence", []);
    const txn = beginTxn({
      kind: "test-kind-fence",
      root,
      changes: [{ path: "/etc/passwd", op: "update", beforeHash: null, afterHash: null }],
      payload: { label: "evil" },
    });
    void txn;
    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/outside its root/);
  });

  test("recovery refuses journals bound to a different root", async () => {
    const root = freshRoot();
    const other = freshRoot();
    registerRecordingKind("test-kind-foreign", []);
    const txn = beginTxn({ kind: "test-kind-foreign", root: other, changes: [], payload: { label: "x" } });
    // Copy the foreign journal into root's namespace to simulate corruption.
    const dir = path.join(txnNamespaceDir(root), txn.journal.transactionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(txn.journalPath, path.join(dir, "journal.json"));
    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/different root/);
    cleanupTxn(txn.dir);
    cleanupTxn(dir);
  });

  test("unregistered kinds are refused loudly (never silently swept)", async () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-known", []);
    const txn = beginTxn({ kind: "test-kind-known", root, changes: [], payload: { label: "k" } });
    const raw = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as Record<string, unknown>;
    raw.kind = "test-kind-NEVER-registered";
    fs.writeFileSync(txn.journalPath, JSON.stringify(raw));
    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/No transaction handler registered/);
    cleanupTxn(txn.dir);
  });

  test("directories without a journal are swept; kind-filtered listing works", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-list", calls);
    const txn = beginTxn({ kind: "test-kind-list", root, changes: [], payload: { label: "l1" } });
    void txn;
    // A junk dir with no journal.json — backdated past the sweep grace
    // window (fresh journal-less dirs are a sibling beginTxn window and are
    // deliberately NOT swept).
    const junkDir = path.join(txnNamespaceDir(root), "junk-no-journal");
    fs.mkdirSync(junkDir, { recursive: true });
    const past = new Date(Date.now() - 600_000);
    fs.utimesSync(junkDir, past, past);

    const listed = listTxnJournals((j) => j.kind === "test-kind-list");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.payload).toEqual({ label: "l1" });

    // filter narrows recovery: nothing matches → nothing rolled back/swept.
    const none = await recoverTxnsForRoot(root, (j) => j.kind === "something-else");
    expect(none).toHaveLength(0);
    expect(fs.existsSync(txn.journalPath)).toBe(true);

    const all = await recoverTxnsForRoot(root);
    expect(all).toHaveLength(1);
    expect(calls).toEqual(["rollback:l1"]);
    expect(fs.existsSync(path.join(txnNamespaceDir(root), "junk-no-journal"))).toBe(false);
  });

  test("a finalize crash leaves the journal at its recorded phase for re-entry", async () => {
    const root = freshRoot();
    let crashOnce = true;
    const calls: string[] = [];
    registerTxnKind<{ label: string }>("test-kind-crashy", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        calls.push("rollback");
      },
      finalize(txn: Txn<{ label: string }>) {
        if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
        if (crashOnce) {
          crashOnce = false;
          throw new Error("simulated crash between steps");
        }
        if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
      },
    });
    const txn = beginTxn({ kind: "test-kind-crashy", root, changes: [], payload: { label: "c" } });
    advanceTxn(txn, "files-published");

    await expect(recoverTxnsForRoot(root)).rejects.toThrow(/simulated crash/);
    // Journal survived at the phase the crash interrupted.
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<unknown>;
    expect(onDisk.phase).toBe("state-persisted");

    const second = await recoverTxnsForRoot(root);
    expect(second).toHaveLength(1);
    expect(fs.existsSync(txn.journalPath)).toBe(false);
    expect(calls).toEqual([]);
  });
});
