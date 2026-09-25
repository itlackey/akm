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
 * (`state.db` busy) failure defers instead of quarantining.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import {
  _recoverProposalTransactionsForTests,
  createProposal,
  getProposal,
  isProposalSkipped,
} from "../../../src/commands/proposal/repository";
import { loadConfig } from "../../../src/core/config/config";
import { TransientError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import {
  _setTxnMutationHookForTests,
  type TxnJournal,
  txnNamespaceDir,
  txnQuarantineNamespaceDir,
} from "../../../src/core/fs-txn";
import { resolveBundleWriteTarget } from "../../../src/core/mutation-target";
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

async function crashProposalAt(phase: string, proposalId: string): Promise<void> {
  await crashProposalAtHelper(markers.dir, children, phase, proposalId, "accept");
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

  test("a corrupt journal.json is quarantined without blocking a sibling's recovery", async () => {
    const good = seedProposal("quarantine-corrupt-good");
    const bad = seedProposal("quarantine-corrupt-bad");
    await crashProposalAt("asset-published", good.id);
    await crashProposalAt("asset-published", bad.id);

    const badDir = findJournalDir(bad.id);
    const badTransactionId = path.basename(badDir);
    fs.writeFileSync(path.join(badDir, "journal.json"), "{ not valid json", "utf8");

    const config = loadConfig();
    const target = resolveBundleWriteTarget(config, "stash");
    // Uses the test-only seam: akm proposal accept/reject reach
    // recoverProposalTransactions only through recoverProposalTransactionsForStash,
    // whose own listTxnJournals root-discovery scan fails loudly on ANY
    // unreadable journal.json anywhere under $DATA/txn (by design), so it
    // can't reach a corrupt SIBLING journal to prove this contract in
    // isolation.
    const completed = await _recoverProposalTransactionsForTests(target, storage.stashDir);

    expect(completed.get(good.id)?.status).toBe("accepted");
    expect(getProposal(storage.stashDir, good.id).status).toBe("accepted");

    expect(fs.existsSync(badDir)).toBe(false);
    expectQuarantined(badTransactionId, /Cannot read transaction journal|JSON/i);
    expect(getProposal(storage.stashDir, bad.id).status).toBe("pending");
  });

  test("a TransientError from finalize defers the journal instead of quarantining it", async () => {
    const target = seedProposal("quarantine-transient");
    await crashProposalAt("asset-published", target.id);
    const dir = findJournalDir(target.id);

    let shouldThrow = true;
    _setTxnMutationHookForTests((point) => {
      if (point === "event-persisted" && shouldThrow) {
        shouldThrow = false;
        throw new TransientError("state.db is busy", "STATE_DB_CONTENDED");
      }
    });

    // Unmodified base code (3dfa3e29d) has no try/catch around finalize at
    // all, so this throw propagates all the way out of akmProposalAccept.
    const first = await akmProposalAccept({ stashDir: storage.stashDir, id: target.id });
    expect(first.ok).toBe(true);
    // The proposal itself is already fully accepted (persisted before the
    // hook fired) — only journal cleanup is pending.
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
});
