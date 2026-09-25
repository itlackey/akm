// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate status`/`apply` for the stash root's stale durable-transaction
 * journals — the counterpart to dead-residue.test.ts's dead-`.akm/*`-path
 * coverage. `findStaleTxnEntries` is read-only; `recoverStaleTxns` is the
 * opt-in action `akm migrate apply` invokes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { findStaleTxnEntries, recoverStaleTxns } from "../../scripts/akm-migrate/migrate/stale-txn";
import {
  advanceTxn,
  beginTxn,
  registerTxnKind,
  txnNamespaceDir,
  txnQuarantineNamespaceDir,
} from "../../src/core/fs-txn";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshStash(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

/** Register a synthetic 3-phase kind recording rollback/finalize calls. */
function registerRecordingKind(kind: string, calls: string[]): void {
  registerTxnKind<{ label: string }>(kind, {
    phases: ["prepared", "files-published", "committed"],
    commitPhase: "files-published",
    rollback(txn) {
      calls.push(`rollback:${txn.journal.payload.label}`);
    },
    finalize(txn) {
      calls.push(`finalize:${txn.journal.payload.label}`);
      if (txn.journal.phase === "files-published") advanceTxn(txn, "committed");
    },
  });
}

describe("migrate stale-txn detection and recovery", () => {
  test("reports nothing when no journals exist for the stash root", () => {
    const stashDir = freshStash();
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("finds a journal left behind under the stash root's namespace", () => {
    const stashDir = freshStash();
    registerRecordingKind("test-stale-status", []);
    beginTxn({ kind: "test-stale-status", root: stashDir, changes: [], payload: { label: "left-behind" } });

    const entries = findStaleTxnEntries(stashDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("test-stale-status");
    expect(entries[0]?.phase).toBe("prepared");
  });

  test("a journal that would fail its fence check is marked wouldQuarantine without running recovery", () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerTxnKind<{ label: string }>("test-stale-would-quarantine", {
      phases: ["prepared", "files-published", "committed"],
      commitPhase: "files-published",
      validate() {
        throw new Error("fence refuses this journal");
      },
      rollback() {
        calls.push("rollback:unreachable");
      },
      finalize() {
        calls.push("finalize:unreachable");
      },
    });
    beginTxn({ kind: "test-stale-would-quarantine", root: stashDir, changes: [], payload: { label: "bad" } });

    const entries = findStaleTxnEntries(stashDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("test-stale-would-quarantine");
    expect(entries[0]?.phase).toBe("prepared");
    expect(entries[0]?.wouldQuarantine?.reason).toMatch(/fence refuses this journal/);
    // The fence probe never runs rollback/finalize, and nothing moved.
    expect(calls).toEqual([]);
    expect(findStaleTxnEntries(stashDir)).toHaveLength(1);
  });

  test("a journal bound to a DIFFERENT root is not reported", () => {
    const stashDir = freshStash();
    const otherStash = makeStashDir();
    disposers.push(otherStash);
    registerRecordingKind("test-stale-other-root", []);
    beginTxn({ kind: "test-stale-other-root", root: otherStash.dir, changes: [], payload: { label: "elsewhere" } });

    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("apply recovers a journal before its commit point (rollback) and clears it from status", async () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerRecordingKind("test-stale-apply-rollback", calls);
    beginTxn({ kind: "test-stale-apply-rollback", root: stashDir, changes: [], payload: { label: "rb" } });

    const { recovered, quarantined } = await recoverStaleTxns(stashDir);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("test-stale-apply-rollback");
    expect(quarantined).toHaveLength(0);
    expect(calls).toEqual(["rollback:rb"]);
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("apply recovers a journal at/after its commit point (finalize)", async () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerRecordingKind("test-stale-apply-finalize", calls);
    const txn = beginTxn({ kind: "test-stale-apply-finalize", root: stashDir, changes: [], payload: { label: "fw" } });
    advanceTxn(txn, "files-published");

    const { recovered, quarantined } = await recoverStaleTxns(stashDir);

    expect(recovered).toHaveLength(1);
    expect(quarantined).toHaveLength(0);
    expect(calls).toEqual(["finalize:fw"]);
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
  });

  test("an unreadable journal is quarantined, reported, and does not block a sibling's recovery", async () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerRecordingKind("test-stale-poisoned-sibling", calls);
    const nsDir = txnNamespaceDir(stashDir);
    fs.mkdirSync(path.join(nsDir, "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(nsDir, "corrupt", "journal.json"), "{ not valid json");
    const sibling = beginTxn({
      kind: "test-stale-poisoned-sibling",
      root: stashDir,
      changes: [],
      payload: { label: "fw" },
    });
    advanceTxn(sibling, "files-published");

    const { recovered, quarantined, deferred } = await recoverStaleTxns(stashDir);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("test-stale-poisoned-sibling");
    expect(calls).toEqual(["finalize:fw"]);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.transactionId).toBe("corrupt");
    expect(quarantined[0]?.reason).toMatch(/Cannot read transaction journal/);
    expect(deferred).toHaveLength(0);

    // The stash's stale-journal listing no longer sees either journal — the
    // recovered one was cleaned up, the unreadable one moved out of `$DATA/txn`.
    expect(findStaleTxnEntries(stashDir)).toEqual([]);
    const quarantineDir = path.join(txnQuarantineNamespaceDir(stashDir), quarantined[0]?.transactionId as string);
    expect(fs.existsSync(path.join(quarantineDir, "journal.json"))).toBe(true);
    expect(fs.existsSync(path.join(quarantineDir, "reason.json"))).toBe(true);
  });

  test("a journal whose recovery action fails is deferred, reported, and does not block a sibling's recovery", async () => {
    const stashDir = freshStash();
    const calls: string[] = [];
    registerTxnKind<{ label: string }>("test-stale-stuck", {
      phases: ["prepared", "files-published", "committed"],
      commitPhase: "files-published",
      rollback() {
        throw new Error("recovery action failed, journal is still trusted");
      },
      finalize() {
        calls.push("finalize:unreachable");
      },
    });
    registerRecordingKind("test-stale-stuck-sibling", calls);
    const stuck = beginTxn({ kind: "test-stale-stuck", root: stashDir, changes: [], payload: { label: "bad" } });
    const sibling = beginTxn({
      kind: "test-stale-stuck-sibling",
      root: stashDir,
      changes: [],
      payload: { label: "fw" },
    });
    advanceTxn(sibling, "files-published");

    const { recovered, quarantined, deferred } = await recoverStaleTxns(stashDir);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("test-stale-stuck-sibling");
    expect(calls).toEqual(["finalize:fw"]);
    expect(quarantined).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.kind).toBe("test-stale-stuck");
    expect(deferred[0]?.reason).toMatch(/recovery action failed, journal is still trusted/);

    // The recovered sibling is gone from the listing; the deferred journal
    // is still there — left in place under `$DATA/txn` for a later retry.
    const remaining = findStaleTxnEntries(stashDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.transactionId).toBe(stuck.journal.transactionId);
    expect(remaining[0]?.wouldQuarantine).toBeUndefined();
  });
});
