// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-6.3a — unit contract for the unified filesystem-transaction engine
 * (src/core/fs-txn.ts): journal home/format, durable phase progression,
 * rollback-vs-roll-forward dispatch at the kind's commit point, engine safety
 * fences, cleanup sweeping, and cross-namespace journal listing.
 *
 * Domain kinds (proposal accept/revert/reject, consolidate) get their
 * semantics pinned by their own suites + the frozen outcome oracles; this
 * suite exercises the ENGINE with synthetic kinds only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { TransientError } from "../../src/core/errors";
import {
  advanceTxn,
  beginTxn,
  cleanupTxn,
  isCommittedPhase,
  type JournaledFileChange,
  listTxnJournals,
  recoverTxnsForRoot,
  registerTxnKind,
  TXN_SWEEP_GRACE_MS,
  type Txn,
  type TxnJournal,
  txnNamespaceDir,
  txnQuarantineNamespaceDir,
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

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(3);
    expect(quarantined).toHaveLength(0);
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

  test("a journal whose changes escape the root is quarantined, not thrown on", async () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-fence", []);
    const txn = beginTxn({
      kind: "test-kind-fence",
      root,
      changes: [{ path: "/etc/passwd", op: "update", beforeHash: null, afterHash: null }],
      payload: { label: "evil" },
    });
    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.transactionId).toBe(txn.journal.transactionId);
    expect(quarantined[0]?.reason).toMatch(/outside its root/);
    // The journal directory MOVED to the quarantine home — nothing deleted.
    expect(fs.existsSync(txn.dir)).toBe(false);
    const quarantineDir = path.join(txnQuarantineNamespaceDir(root), txn.journal.transactionId);
    expect(quarantined[0]?.journalPath).toBe(path.join(quarantineDir, "journal.json"));
    expect(fs.existsSync(path.join(quarantineDir, "journal.json"))).toBe(true);
    const reason = JSON.parse(fs.readFileSync(path.join(quarantineDir, "reason.json"), "utf8"));
    expect(reason.reason).toMatch(/outside its root/);
    expect(typeof reason.version).toBe("string");
    expect(typeof reason.quarantinedAt).toBe("string");
  });

  test("a journal bound to a different root is quarantined, not thrown on", async () => {
    const root = freshRoot();
    const other = freshRoot();
    registerRecordingKind("test-kind-foreign", []);
    const txn = beginTxn({ kind: "test-kind-foreign", root: other, changes: [], payload: { label: "x" } });
    // Copy the foreign journal into root's namespace to simulate corruption.
    const dir = path.join(txnNamespaceDir(root), txn.journal.transactionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(txn.journalPath, path.join(dir, "journal.json"));
    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.reason).toMatch(/different root/);
    expect(fs.existsSync(dir)).toBe(false);
    cleanupTxn(txn.dir);
  });

  // ── unknown-kind sweep (0.9.0: `akm mv` and its `kind:"mv"` handler are
  //    gone; an rc-era leftover journal must never brick a recovery scan) ──

  /**
   * Fabricate a journal for a kind that has NO registered handler, in `root`'s
   * namespace. `ageMs` backdates the transaction dir so the caller can place it
   * either side of TXN_SWEEP_GRACE_MS.
   */
  function fabricateUnknownKindTxnDir(root: string, kind: string, ageMs: number): string {
    const dir = path.join(txnNamespaceDir(root), `unknown-${kind}`);
    fs.mkdirSync(dir, { recursive: true });
    const journal: TxnJournal<{ label: string }> = {
      version: 1,
      kind,
      phase: "some-retired-phase",
      transactionId: path.basename(dir),
      root: path.resolve(root),
      changes: [],
      decidedAt: new Date().toISOString(),
      payload: { label: "rc-era-leftover" },
    };
    fs.writeFileSync(path.join(dir, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, stamp, stamp);
    return dir;
  }

  test("a stale journal of an UNREGISTERED kind is swept, not thrown on", async () => {
    const root = freshRoot();
    const dir = fabricateUnknownKindTxnDir(root, "mv", TXN_SWEEP_GRACE_MS + 60_000);

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    // Nothing was recovered (no handler could roll it back or forward) …
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(0);
    // … and the unrecoverable directory is gone rather than fencing the scan.
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("an unregistered-kind journal does not block recovery of a KNOWN-kind sibling", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-sweep-sibling", calls);
    const known = beginTxn({ kind: "test-kind-sweep-sibling", root, changes: [], payload: { label: "live" } });
    advanceTxn(known, "files-published");
    const stale = fabricateUnknownKindTxnDir(root, "mv", TXN_SWEEP_GRACE_MS + 60_000);

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered.map((j) => j.kind)).toEqual(["test-kind-sweep-sibling"]);
    expect(quarantined).toHaveLength(0);
    expect(calls).toEqual(["finalize:live@files-published"]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(known.dir)).toBe(false);
  });

  test("a FRESH unregistered-kind journal inside the grace window is left alone", async () => {
    const root = freshRoot();
    // A live kind whose registrar this process simply has not imported yet
    // looks identical to a retired one; the grace period is what tells them
    // apart, so a just-written journal must survive the scan untouched.
    const dir = fabricateUnknownKindTxnDir(root, "not-yet-imported-kind", 0);

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "journal.json"))).toBe(true);
    cleanupTxn(dir);
  });

  test("the unknown-kind sweep runs even when a filter excludes the journal", async () => {
    const root = freshRoot();
    registerRecordingKind("test-kind-sweep-filtered", []);
    const dir = fabricateUnknownKindTxnDir(root, "mv", TXN_SWEEP_GRACE_MS + 60_000);

    // A narrowly-filtered caller (the shape every pre-0.9.0 mv hook used) must
    // still clear garbage no handler can ever recover.
    const { recovered, quarantined } = await recoverTxnsForRoot(root, (j) => j.kind === "test-kind-sweep-filtered");
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
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
    expect(none.recovered).toHaveLength(0);
    expect(fs.existsSync(txn.journalPath)).toBe(true);

    const all = await recoverTxnsForRoot(root);
    expect(all.recovered).toHaveLength(1);
    expect(all.quarantined).toHaveLength(0);
    expect(calls).toEqual(["rollback:l1"]);
    expect(fs.existsSync(path.join(txnNamespaceDir(root), "junk-no-journal"))).toBe(false);
  });

  test("a finalize throw on a fenced journal defers it — reported under deferred, not quarantined — and it is retried on the next scan", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    let shouldThrow = true;
    registerTxnKind<{ label: string }>("test-kind-crashy", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        calls.push("rollback");
      },
      finalize(txn: Txn<{ label: string }>) {
        if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
        if (shouldThrow) throw new Error("simulated crash between steps");
        calls.push(`finalize:${txn.journal.payload.label}@${txn.journal.phase}`);
        if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
      },
    });
    registerRecordingKind("test-kind-crashy-sibling", calls);
    const txn = beginTxn({ kind: "test-kind-crashy", root, changes: [], payload: { label: "c" } });
    advanceTxn(txn, "files-published");
    const sibling = beginTxn({ kind: "test-kind-crashy-sibling", root, changes: [], payload: { label: "ok" } });
    advanceTxn(sibling, "files-published");

    const { recovered, quarantined, deferred } = await recoverTxnsForRoot(root);
    // The sibling recovers normally — one deferred journal does not brick
    // the scan.
    expect(recovered.map((j) => j.kind)).toEqual(["test-kind-crashy-sibling"]);
    expect(calls).toEqual(["finalize:ok@files-published"]);
    // The crashy journal's recovery ACTION failed; the journal itself is
    // still trusted, so it is deferred and left in place, not quarantined.
    expect(quarantined).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.transactionId).toBe(txn.journal.transactionId);
    expect(deferred[0]?.phase).toBe("state-persisted"); // advanced before the throw
    expect(deferred[0]?.reason).toMatch(/simulated crash/);
    expect(fs.existsSync(txn.journalPath)).toBe(true);

    // A second scan, once the recovery action succeeds, finalizes it.
    shouldThrow = false;
    const second = await recoverTxnsForRoot(root);
    expect(second.recovered.map((j) => j.kind)).toEqual(["test-kind-crashy"]);
    expect(second.quarantined).toHaveLength(0);
    expect(second.deferred).toHaveLength(0);
    expect(calls).toContain("finalize:c@state-persisted");
    expect(fs.existsSync(txn.dir)).toBe(false);
  });

  /** Write a raw journal.json under root's namespace, bypassing beginTxn. */
  function fabricateRawJournalDir(root: string, name: string, content: string): string {
    const dir = path.join(txnNamespaceDir(root), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "journal.json"), content);
    return dir;
  }

  test("a corrupt journal.json is quarantined without blocking sibling recovery", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-corrupt-sibling", calls);

    const before = beginTxn({ kind: "test-kind-corrupt-sibling", root, changes: [], payload: { label: "before" } });
    void before; // stays at "prepared" — rolls back
    const corruptDir = fabricateRawJournalDir(root, "corrupt-mid", "{ not valid json");
    const after = beginTxn({ kind: "test-kind-corrupt-sibling", root, changes: [], payload: { label: "after" } });
    advanceTxn(after, "files-published");

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    // Both readable siblings recover — the unreadable journal between them
    // does not abort the scan.
    expect(recovered).toHaveLength(2);
    expect(calls.sort()).toEqual(["finalize:after@files-published", "rollback:before"]);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.transactionId).toBe("corrupt-mid");
    expect(quarantined[0]?.reason).toMatch(/Cannot read transaction journal/);
    const quarantineDir = path.join(txnQuarantineNamespaceDir(root), "corrupt-mid");
    expect(fs.existsSync(path.join(quarantineDir, "journal.json"))).toBe(true);
    const reason = JSON.parse(fs.readFileSync(path.join(quarantineDir, "reason.json"), "utf8"));
    expect(reason.reason).toMatch(/Cannot read transaction journal/);
    expect(fs.existsSync(corruptDir)).toBe(false);
  });

  test("a journal with a refused version is quarantined, preserving readJournal's refusal reason", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    registerRecordingKind("test-kind-badversion-sibling", calls);

    const sibling = beginTxn({ kind: "test-kind-badversion-sibling", root, changes: [], payload: { label: "ok" } });
    advanceTxn(sibling, "files-published");

    const badJournal = {
      version: 2,
      kind: "test-kind-badversion-sibling",
      phase: "files-published",
      transactionId: "bad-version",
      root: path.resolve(root),
      changes: [],
      decidedAt: new Date().toISOString(),
      payload: { label: "future" },
    };
    fabricateRawJournalDir(root, "bad-version", `${JSON.stringify(badJournal, null, 2)}\n`);

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered.map((j) => j.kind)).toEqual(["test-kind-badversion-sibling"]);
    expect(calls).toEqual(["finalize:ok@files-published"]);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.transactionId).toBe("bad-version");
    expect(quarantined[0]?.reason).toMatch(/Refusing unsafe transaction journal/);
    const quarantineDir = path.join(txnQuarantineNamespaceDir(root), "bad-version");
    expect(fs.existsSync(path.join(quarantineDir, "journal.json"))).toBe(true);
  });

  test("a finalize throw of TransientError leaves the journal in place for a later retry", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    let shouldThrow = true;
    registerTxnKind<{ label: string }>("test-kind-transient", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        calls.push("rollback");
      },
      finalize(txn: Txn<{ label: string }>) {
        if (shouldThrow) throw new TransientError("state.db is busy", "STATE_DB_CONTENDED");
        calls.push(`finalize:${txn.journal.payload.label}@${txn.journal.phase}`);
        if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
        if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
      },
    });
    registerRecordingKind("test-kind-transient-sibling", calls);
    const txn = beginTxn({ kind: "test-kind-transient", root, changes: [], payload: { label: "t" } });
    advanceTxn(txn, "files-published");
    const sibling = beginTxn({ kind: "test-kind-transient-sibling", root, changes: [], payload: { label: "ok" } });
    advanceTxn(sibling, "files-published");

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    // The sibling recovers normally; the transiently-failing journal is
    // neither recovered nor quarantined — it stays at its original path
    // and phase for a later retry.
    expect(recovered.map((j) => j.kind)).toEqual(["test-kind-transient-sibling"]);
    expect(quarantined).toHaveLength(0);
    expect(fs.existsSync(txn.journalPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(txn.journalPath, "utf8")) as TxnJournal<unknown>;
    expect(onDisk.phase).toBe("files-published");

    // A second scan, once the transient condition clears, finalizes it.
    shouldThrow = false;
    const second = await recoverTxnsForRoot(root);
    expect(second.recovered.map((j) => j.kind)).toEqual(["test-kind-transient"]);
    expect(second.quarantined).toHaveLength(0);
    expect(calls).toContain("finalize:t@files-published");
    expect(fs.existsSync(txn.dir)).toBe(false);
  });

  test("a non-transient rollback throw defers the journal too — a failed recovery action never implies the journal itself is untrustworthy", async () => {
    const root = freshRoot();
    registerTxnKind<{ label: string }>("test-kind-nontransient", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        throw new Error("genuinely broken, not contention");
      },
      finalize() {},
    });
    const txn = beginTxn({ kind: "test-kind-nontransient", root, changes: [], payload: { label: "n" } });
    // Stays at "prepared" — before the commit point, so recovery rolls BACK.

    const { recovered, quarantined, deferred } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(0);
    expect(deferred).toEqual([
      {
        transactionId: txn.journal.transactionId,
        kind: "test-kind-nontransient",
        phase: "prepared",
        journalPath: txn.journalPath,
        reason: "genuinely broken, not contention",
      },
    ]);
    expect(fs.existsSync(txn.journalPath)).toBe(true);
  });

  test("a finalize throw shaped like a raw SQLite busy error defers rather than quarantines", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    let shouldThrow = true;
    registerTxnKind<{ label: string }>("test-kind-sqlite-busy", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        calls.push("rollback");
      },
      finalize(txn: Txn<{ label: string }>) {
        if (shouldThrow) {
          const error = new Error("driver error") as Error & { code?: string };
          error.code = "SQLITE_BUSY";
          throw error;
        }
        calls.push(`finalize:${txn.journal.payload.label}@${txn.journal.phase}`);
        if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
        if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
      },
    });
    const txn = beginTxn({ kind: "test-kind-sqlite-busy", root, changes: [], payload: { label: "b" } });
    advanceTxn(txn, "files-published");

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(0);
    expect(fs.existsSync(txn.journalPath)).toBe(true);

    shouldThrow = false;
    const second = await recoverTxnsForRoot(root);
    expect(second.recovered.map((j) => j.kind)).toEqual(["test-kind-sqlite-busy"]);
    expect(second.quarantined).toHaveLength(0);
    expect(calls).toContain("finalize:b@files-published");
  });

  test("a finalize throw whose message is 'database is locked' defers rather than quarantines", async () => {
    const root = freshRoot();
    const calls: string[] = [];
    let shouldThrow = true;
    registerTxnKind<{ label: string }>("test-kind-db-locked", {
      phases: ["prepared", "files-published", "state-persisted", "committed"],
      commitPhase: "files-published",
      rollback() {
        calls.push("rollback");
      },
      finalize(txn: Txn<{ label: string }>) {
        if (shouldThrow) throw new Error("database is locked");
        calls.push(`finalize:${txn.journal.payload.label}@${txn.journal.phase}`);
        if (txn.journal.phase === "files-published") advanceTxn(txn, "state-persisted");
        if (txn.journal.phase === "state-persisted") advanceTxn(txn, "committed");
      },
    });
    const txn = beginTxn({ kind: "test-kind-db-locked", root, changes: [], payload: { label: "l" } });
    advanceTxn(txn, "files-published");

    const { recovered, quarantined } = await recoverTxnsForRoot(root);
    expect(recovered).toHaveLength(0);
    expect(quarantined).toHaveLength(0);
    expect(fs.existsSync(txn.journalPath)).toBe(true);

    shouldThrow = false;
    const second = await recoverTxnsForRoot(root);
    expect(second.recovered.map((j) => j.kind)).toEqual(["test-kind-db-locked"]);
    expect(second.quarantined).toHaveLength(0);
    expect(calls).toContain("finalize:l@files-published");
  });
});
