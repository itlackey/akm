// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Belongs under tests/integration/ (ORG-03/04/05/06): recovery here reads
// and writes the real state.db through getProposal/finalizeProposalTransaction
// (openIndexDatabase/openExistingDatabase), and crashProposalAt spawns a real
// subprocess.

/**
 * r3-4: `recoverProposalTransactions` (src/commands/proposal/repository.ts)
 * gains the same per-journal quarantine contract `recoverTxnsForRoot`
 * (src/core/fs-txn.ts) already has for the generic engine — a corrupt,
 * unsafe, or finalize-failing SIBLING journal sharing a root's transaction
 * namespace must not abort recovery of every other journal there, which
 * runs ahead of every `akm proposal accept`/`reject`. A transient
 * (`state.db` busy) failure on a SIBLING journal defers instead of
 * quarantining; the SAME failure on the requested proposal's OWN journal
 * instead fails the command as transient (exit 75) rather than letting
 * `accept`/`reject` proceed over a crashed transaction whose outcome is
 * still unknown. Two more spots on that same public `accept`/`reject` path
 * kept their own unguarded scans and are covered here too:
 * `recoverProposalTransactionsForStash`'s upfront `listTxnJournals`
 * root-discovery call failed loudly on ANY unreadable journal anywhere
 * under `$DATA/txn` before the per-root scan above was ever reached (now
 * `listTxnJournalsTolerant`), and `recoverRejectTransaction`'s own scan
 * (run on every `accept`, ahead of promotion) had an unguarded `JSON.parse`
 * of its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { createProposal, getProposal, isProposalSkipped } from "../../../src/commands/proposal/repository";
import { TransientError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import {
  _setTxnMutationHookForTests,
  type TxnJournal,
  txnNamespaceDir,
  txnQuarantineNamespaceDir,
} from "../../../src/core/fs-txn";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";
import { crashProposalAt as crashProposalAtHelper } from "../_helpers/proposal-crash";

const CONTENT = "---\ndescription: Durable proposal content\nwhen_to_use: Testing quarantine recovery\n---\n\nNEW.\n";

let storage: IsolatedAkmStorage;
let markers: ReturnType<typeof makeSandboxDir>;
const children: ChildProcess[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  markers = makeSandboxDir("akm-proposal-quarantine-crash");
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  });
});

afterEach(() => {
  _setTxnMutationHookForTests(undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  markers.cleanup();
  storage.cleanup();
});

async function crashProposalAt(phase: string, proposalId: string, operation = "accept"): Promise<void> {
  await crashProposalAtHelper(markers.dir, children, phase, proposalId, operation);
}

function seedProposal(name: string): { id: string; assetPath: string } {
  const assetPath = path.join(storage.stashDir, "lessons", `${name}.md`);
  fs.writeFileSync(
    assetPath,
    "---\ndescription: Original content\nwhen_to_use: Testing quarantine recovery\n---\n\nORIGINAL.\n",
    "utf8",
  );
  const proposal = createProposal(storage.stashDir, {
    ref: `lessons/${name}`,
    source: "distill",
    force: true,
    payload: { content: CONTENT },
  });
  if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
  return { id: proposal.id, assetPath };
}

/** Find `proposalId`'s own journal dir under the stash's shared transaction namespace. */
function findJournalDir(proposalId: string): string {
  const nsDir = txnNamespaceDir(storage.stashDir);
  for (const name of fs.readdirSync(nsDir)) {
    const journalPath = path.join(nsDir, name, "journal.json");
    if (!fs.existsSync(journalPath)) continue;
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as TxnJournal<{ proposalId: string }>;
    if (journal.payload.proposalId === proposalId) return path.join(nsDir, name);
  }
  throw new Error(`no journal found for proposal ${proposalId}`);
}

function expectQuarantined(transactionId: string, reasonPattern: RegExp): void {
  const quarantineDir = path.join(txnQuarantineNamespaceDir(storage.stashDir), transactionId);
  expect(fs.existsSync(path.join(quarantineDir, "journal.json"))).toBe(true);
  const reason = JSON.parse(fs.readFileSync(path.join(quarantineDir, "reason.json"), "utf8"));
  expect(reason.reason).toMatch(reasonPattern);
}

describe("proposal transaction recovery quarantines a bad sibling journal", () => {
  test("an unsafe journal (bound to a different root) is quarantined; the good siblings still recover", async () => {
    const good1 = seedProposal("quarantine-unsafe-good-1");
    const bad = seedProposal("quarantine-unsafe-bad");
    const good2 = seedProposal("quarantine-unsafe-good-2");
    await crashProposalAt("asset-published", good1.id);
    await crashProposalAt("asset-published", bad.id);
    await crashProposalAt("asset-published", good2.id);

    const badDir = findJournalDir(bad.id);
    const badJournalPath = path.join(badDir, "journal.json");
    const badJournal = JSON.parse(fs.readFileSync(badJournalPath, "utf8")) as TxnJournal<{ proposalId: string }>;
    const otherRoot = fs.mkdtempSync(path.join(storage.root, "other-root-"));
    fs.writeFileSync(badJournalPath, `${JSON.stringify({ ...badJournal, root: otherRoot }, null, 2)}\n`, "utf8");

    // Unmodified base code (3dfa3e29d): this throws, aborting recovery for
    // good1 and good2's crashed transactions along with it.
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: good1.id });
    expect(result.ok).toBe(true);
    expect(getProposal(storage.stashDir, good1.id).status).toBe("accepted");
    // good2's own crashed transaction was recovered as a side effect of the
    // shared-namespace scan good1's accept triggered, even though it was
    // never itself requested.
    expect(getProposal(storage.stashDir, good2.id).status).toBe("accepted");

    // The bad journal never recovered — it was quarantined instead, and its
    // proposal is left exactly as it was (still pending, no partial state).
    expect(fs.existsSync(badDir)).toBe(false);
    expectQuarantined(badJournal.transactionId, /Refusing unsafe proposal transaction journal/i);
    expect(getProposal(storage.stashDir, bad.id).status).toBe("pending");
  });

  test("a journal whose finalize throws (non-transient) is quarantined; the good siblings still recover", async () => {
    const good = seedProposal("quarantine-finalize-good");
    const bad = seedProposal("quarantine-finalize-bad");
    await crashProposalAt("asset-published", good.id);
    await crashProposalAt("asset-published", bad.id);

    const badDir = findJournalDir(bad.id);
    const badJournal = JSON.parse(fs.readFileSync(path.join(badDir, "journal.json"), "utf8")) as TxnJournal<{
      proposalId: string;
    }>;
    // finalize's first step reads the staged published-content file; delete
    // it so finalize throws a genuine (non-transient) error.
    fs.rmSync(path.join(badDir, "published-content"));

    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: good.id });
    expect(result.ok).toBe(true);
    expect(getProposal(storage.stashDir, good.id).status).toBe("accepted");

    expect(fs.existsSync(badDir)).toBe(false);
    expectQuarantined(badJournal.transactionId, /ENOENT|no such file/i);
    expect(getProposal(storage.stashDir, bad.id).status).toBe("pending");
  });

  test("a corrupt journal.json is quarantined without blocking a sibling's recovery, through the real akm proposal accept path", async () => {
    const good = seedProposal("quarantine-corrupt-good");
    const bad = seedProposal("quarantine-corrupt-bad");
    await crashProposalAt("asset-published", good.id);
    await crashProposalAt("asset-published", bad.id);

    const badDir = findJournalDir(bad.id);
    const badTransactionId = path.basename(badDir);
    fs.writeFileSync(path.join(badDir, "journal.json"), "{ not valid json", "utf8");

    // Unmodified base code (3dfa3e29d): akm proposal accept/reject reach
    // recoverProposalTransactions only through
    // recoverProposalTransactionsForStash, whose own listTxnJournals
    // root-discovery scan fails loudly on ANY unreadable journal.json
    // anywhere under $DATA/txn, before good's own root is ever resolved —
    // this throws a SyntaxError out of akmProposalAccept entirely.
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: good.id });
    expect(result.ok).toBe(true);
    expect(getProposal(storage.stashDir, good.id).status).toBe("accepted");

    expect(fs.existsSync(badDir)).toBe(false);
    expectQuarantined(badTransactionId, /Cannot read transaction journal|JSON/i);
    expect(getProposal(storage.stashDir, bad.id).status).toBe("pending");
  });

  test("a corrupt sibling proposal-reject journal is quarantined without blocking another proposal's accept", async () => {
    const bad = seedProposal("quarantine-reject-corrupt-bad");
    await crashProposalAt("reject-state-persisted", bad.id, "reject");

    const badDir = findJournalDir(bad.id);
    const badTransactionId = path.basename(badDir);
    fs.writeFileSync(path.join(badDir, "journal.json"), "{ not valid json", "utf8");

    const good = seedProposal("quarantine-reject-corrupt-good");

    // Unmodified base code (3dfa3e29d): promoteProposalWithLease calls
    // recoverRejectTransaction(stashDir, good.id) ahead of every accept,
    // which shares good's stash-wide transaction namespace with bad's
    // crashed reject journal. Its unguarded JSON.parse throws a
    // SyntaxError while scanning for good's own (nonexistent) reject
    // journal, aborting good's unrelated accept entirely.
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: good.id });
    expect(result.ok).toBe(true);
    expect(getProposal(storage.stashDir, good.id).status).toBe("accepted");

    expect(fs.existsSync(badDir)).toBe(false);
    expectQuarantined(badTransactionId, /Cannot read transaction journal|JSON/i);
  });

  test("a TransientError from finalize on the requested proposal's OWN journal fails accept as transient, not deferred", async () => {
    const target = seedProposal("quarantine-transient-own");
    await crashProposalAt("asset-published", target.id);
    const dir = findJournalDir(target.id);

    let shouldThrow = true;
    _setTxnMutationHookForTests((point) => {
      if (point === "event-persisted" && shouldThrow) {
        shouldThrow = false;
        throw new TransientError("state.db is busy", "STATE_DB_CONTENDED");
      }
    });

    // Unmodified base code (769d2c05c) swallows this into a deferred warning
    // and resolves `ok: true`, instead of failing the command as transient.
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: target.id })).rejects.toThrow(TransientError);
    // The proposal itself is already fully accepted (persisted before the
    // hook fired) — only journal cleanup is pending — and the journal is
    // left in place, not quarantined.
    expect(getProposal(storage.stashDir, target.id).status).toBe("accepted");
    expect(fs.existsSync(dir)).toBe(true);
    const stillPending = JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8")) as TxnJournal<unknown>;
    expect(stillPending.phase).toBe("index-finalized");
    expect(fs.existsSync(txnQuarantineNamespaceDir(storage.stashDir))).toBe(false);

    // A later recovery pass (contention cleared) finishes cleanup exactly once.
    const second = await akmProposalAccept({ stashDir: storage.stashDir, id: target.id });
    expect(second.ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    const events = readEvents({ type: "promoted", ref: second.ref }).events.filter(
      (event) => event.metadata?.proposalId === target.id,
    );
    expect(events).toHaveLength(1);
  });

  test("a TransientError from finalize on a SIBLING's journal still defers it, while the requested proposal's own accept succeeds", async () => {
    // Both `good` and `sibling` are crashed (own journals in the same
    // shared root) so accepting `good` sweeps both — the same "recovered as
    // a side effect" mechanic as the unsafe-journal test above. The hook
    // below fires once per journal that reaches "event-persisted" during
    // that sweep; readdir order between `good` and `sibling` is not
    // guaranteed, so it keys off which journal is CURRENTLY at
    // "index-finalized" on disk (written by advanceTxn just before the
    // hook fires) rather than call order, so it throws on `sibling`'s own
    // finalize specifically regardless of which one is visited first.
    const good = seedProposal("quarantine-transient-good");
    await crashProposalAt("asset-published", good.id);
    const sibling = seedProposal("quarantine-transient-sibling");
    await crashProposalAt("asset-published", sibling.id);
    const siblingDir = findJournalDir(sibling.id);
    const siblingJournalPath = path.join(siblingDir, "journal.json");

    let siblingThrown = false;
    _setTxnMutationHookForTests((point) => {
      if (point !== "event-persisted" || siblingThrown) return;
      const journal = JSON.parse(fs.readFileSync(siblingJournalPath, "utf8")) as TxnJournal<unknown>;
      if (journal.phase !== "index-finalized") return;
      siblingThrown = true;
      throw new TransientError("state.db is busy", "STATE_DB_CONTENDED");
    });

    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: good.id });
    expect(result.ok).toBe(true);
    expect(getProposal(storage.stashDir, good.id).status).toBe("accepted");

    // The sibling's crashed journal was deferred, not quarantined, and its
    // proposal is left exactly as finalize's first step left it.
    expect(fs.existsSync(siblingDir)).toBe(true);
    expect(fs.existsSync(txnQuarantineNamespaceDir(storage.stashDir))).toBe(false);
    expect(getProposal(storage.stashDir, sibling.id).status).toBe("accepted");

    // A later accept of the sibling itself finishes its own cleanup (the
    // hook no longer throws — `siblingThrown` is already set).
    const finish = await akmProposalAccept({ stashDir: storage.stashDir, id: sibling.id });
    expect(finish.ok).toBe(true);
    expect(fs.existsSync(siblingDir)).toBe(false);
  });

  test("a TransientError from finalize on the requested proposal's OWN reject journal fails accept as transient, not the 'not pending' UsageError", async () => {
    const bad = seedProposal("quarantine-transient-reject-own");
    await crashProposalAt("reject-state-persisted", bad.id, "reject");
    const dir = findJournalDir(bad.id);

    let shouldThrow = true;
    _setTxnMutationHookForTests((point) => {
      if (point === "reject-event-persisted" && shouldThrow) {
        shouldThrow = false;
        throw new TransientError("state.db is busy", "STATE_DB_CONTENDED");
      }
    });

    // Unmodified base code (769d2c05c) swallows this and lets accept
    // continue over a proposal already durably marked "rejected", so it
    // throws the "not pending" UsageError instead of a TransientError.
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: bad.id })).rejects.toThrow(TransientError);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(txnQuarantineNamespaceDir(storage.stashDir))).toBe(false);
  });
});
