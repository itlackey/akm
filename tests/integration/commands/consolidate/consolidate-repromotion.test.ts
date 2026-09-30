// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #998 — a memory whose promotion was decided is offered to the model again
 * only when its body changes. Before, an accepted promotion's memory was
 * eligible at once (`next_eligible_at = NULL`) and a rejected one after 7
 * days; on the owner's bundle 88% of a run's proposals came from memories
 * already promoted before, one of them 14 times.
 *
 * Drives the real producers end to end: `emitPromotionProposal` mints, a
 * person accepts or rejects through the proposal API, and
 * `inspectConsolidationPool` selects. Every memory is marked as retrieved so
 * that the retrieval scope (#986) never masks what the ledger decides.
 *
 * Integration (ORG-03): opens a real state.db (`openStateDatabase`, the
 * proposal and ledger repositories) and `inspectConsolidationPool` opens
 * index.db with `openExistingDatabase`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type ConsolidatePromoteOp,
  emitPromotionProposal,
  inspectConsolidationPool,
} from "../../../../src/commands/improve/consolidate";
import { contentHash } from "../../../../src/commands/improve/content-hash";
import { recordLedgerAttempt } from "../../../../src/commands/improve/ledger";
import { akmProposalAccept, akmProposalReject } from "../../../../src/commands/proposal/proposal";
import { createProposal, listProposals, recordGateDecision } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import { resolveWriteTarget } from "../../../../src/core/write-source";
import {
  getImproveLedgerRow,
  listImproveLedgerRows,
} from "../../../../src/storage/repositories/improve-ledger-repository";
import { makeConfig } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const DAY_MS = 86_400_000;

let storage: IsolatedAkmStorage;
let stash: string;
let config: AkmConfig;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = storage.stashDir;
  config = { ...makeConfig(stash), semanticSearchMode: "off" } as AkmConfig;
  for (const dir of ["memories", "knowledge"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

const BODY =
  "Always run the release check on a clean checkout before tagging, because a dirty tree hides files the build needs. " +
  "The second sentence keeps this fixture above the promotion size gate.";
const EDITED = `${BODY} A later note adds that the check also needs network access.`;

function memoryPath(name: string): string {
  return path.join(stash, "memories", `${name}.md`);
}

function writeMemory(name: string, body: string): string {
  const file = memoryPath(name);
  fs.writeFileSync(file, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
  return fs.readFileSync(file, "utf8");
}

/** A user search returned the memory, so it stays inside the retrieval scope whatever the ledger says. */
function markRetrieved(name: string): void {
  const db = openStateDatabase();
  try {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source, created_at) VALUES (?, ?, ?, ?)").run(
      "search",
      `stash//memories/${name}`,
      "user",
      new Date().toISOString().replace("T", " ").slice(0, 19),
    );
  } finally {
    db.close();
  }
}

/** Queue the promotion of `memories/<name>` through the real mint path; returns the pending proposal. */
async function promote(name: string) {
  const op: ConsolidatePromoteOp = {
    op: "promote",
    ref: `memories/${name}`,
    knowledgeRef: `knowledge/${name}-notes`,
    reason: "test",
    description: `${name} notes`,
  };
  const skips: string[] = [];
  await emitPromotionProposal(op, {
    config,
    stashDir: stash,
    sourceRun: "consolidate-test",
    target: resolveWriteTarget(config),
    memoryByRef: new Map([
      [op.ref, { name, filePath: memoryPath(name), description: `${name} memory`, tags: [], stashDir: stash }],
    ]),
    promoted: [],
    promotedSourceRefs: new Set(),
    existingKnowledgeBodyHashes: new Set(),
    promotionFailures: { count: 0 },
    warnings: [],
    pushSkipReason: (_op, _ref, reason) => skips.push(reason),
  });
  expect(skips).toEqual([]);
  const pending = listProposals(stash, { status: "pending" }).filter((p) => p.promotionSource === op.ref);
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

function ledgerRow(name: string) {
  const db = openStateDatabase();
  try {
    return getImproveLedgerRow(db, stash, `memories/${name}`, "consolidate");
  } finally {
    db.close();
  }
}

/** The ref of every `consolidate` ledger row: promotions are keyed by their source memory, never by the knowledge ref. */
function ledgerRefs(): string[] {
  const db = openStateDatabase();
  try {
    return listImproveLedgerRows(db, stash, ["consolidate"]).map((row) => row.ref);
  } finally {
    db.close();
  }
}

function pool() {
  return inspectConsolidationPool({ config }, stash, []);
}

const namesIn = (snapshot: ReturnType<typeof pool>): string[] => snapshot.memories.map((m) => m.name);

describe("a rejected promotion (#998)", () => {
  it("keeps its memory out of the pool, 8 days on, until the body changes", async () => {
    const raw = writeMemory("rejected", BODY);
    markRetrieved("rejected");
    const proposal = await promote("rejected");

    // Decided 8 days ago: the old 7-day rejection window has long elapsed.
    await akmProposalReject({
      stashDir: stash,
      id: proposal.id,
      config,
      reason: "duplicate of knowledge/release-check",
      ctx: { now: () => Date.now() - 8 * DAY_MS },
    });

    const held = pool();
    expect(namesIn(held)).not.toContain("rejected");
    expect(held.judgedUnchanged).toBe(1);
    expect(held.outsideRetrievalScope).toBe(0);
    expect(ledgerRow("rejected")).toMatchObject({
      outcome: "rejected",
      nextEligibleAt: null,
      contentHash: contentHash(raw, "body"),
    });

    // Bookkeeping frontmatter is not content: the body hash ignores it.
    fs.writeFileSync(memoryPath("rejected"), `---\ndescription: reworded\nupdated: 2026-09-30\n---\n\n${BODY}\n`);
    expect(namesIn(pool())).not.toContain("rejected");

    writeMemory("rejected", EDITED);
    const released = pool();
    expect(namesIn(released)).toContain("rejected");
    expect(released.judgedUnchanged).toBe(0);
  });
});

describe("a promotion whose ledger row a later attempt overwrote (#998)", () => {
  it("still holds the memory once the pending proposal is rejected", async () => {
    const raw = writeMemory("clobbered", BODY);
    markRetrieved("clobbered");
    const proposal = await promote("clobbered");

    // The proposal sat pending past the 7-day revisit; the model saw the memory
    // again ("already queued") and left it alone, which replaced the `proposed`
    // row and dropped its link to the proposal.
    recordLedgerAttempt({ proposalsCtx: { now: () => Date.now() - 9 * DAY_MS } }, [
      { stashDir: stash, ref: "memories/clobbered", source: "consolidate", outcome: "judged_no_action" },
    ]);
    expect(ledgerRow("clobbered")).toMatchObject({ outcome: "judged_no_action", proposalId: null });

    await akmProposalReject({
      stashDir: stash,
      id: proposal.id,
      config,
      reason: "duplicate of knowledge/release-check",
      ctx: { now: () => Date.now() - 8 * DAY_MS },
    });

    // The verdict reaches the memory's own row, not a row for the knowledge ref.
    expect(namesIn(pool())).not.toContain("clobbered");
    expect(ledgerRow("clobbered")).toMatchObject({
      outcome: "rejected",
      nextEligibleAt: null,
      contentHash: contentHash(raw, "body"),
      proposalId: proposal.id,
    });
  });
});

describe("a promotion the drain deferred after its ledger row was overwritten (#998)", () => {
  it("keeps the deferral on the memory's row, so the later verdict still holds the memory", async () => {
    const raw = writeMemory("deferred", BODY);
    markRetrieved("deferred");
    const proposal = await promote("deferred");

    // As above, a later attempt took over the memory's row; then the drain's
    // judge deferred the proposal for a person to review.
    recordLedgerAttempt({ proposalsCtx: { now: () => Date.now() - 9 * DAY_MS } }, [
      { stashDir: stash, ref: "memories/deferred", source: "consolidate", outcome: "judged_no_action" },
    ]);
    recordGateDecision(stash, proposal.id, { outcome: "deferred", reason: "judgment-deferred", gate: "triage" });

    // The deferral restores the link on the memory's row. It used to write a
    // row under the knowledge ref, which the verdict below then updated
    // instead, leaving the memory's own row `judged_no_action`.
    expect(ledgerRow("deferred")).toMatchObject({ outcome: "review_needed", proposalId: proposal.id });
    expect(ledgerRefs()).toEqual(["memories/deferred"]);

    await akmProposalReject({
      stashDir: stash,
      id: proposal.id,
      config,
      reason: "duplicate of knowledge/release-check",
      ctx: { now: () => Date.now() - 8 * DAY_MS },
    });

    expect(namesIn(pool())).not.toContain("deferred");
    expect(ledgerRow("deferred")).toMatchObject({
      outcome: "rejected",
      nextEligibleAt: null,
      contentHash: contentHash(raw, "body"),
      proposalId: proposal.id,
    });
    expect(ledgerRefs()).toEqual(["memories/deferred"]);
  });
});

describe("an accepted promotion (#998)", () => {
  it("keeps a memory that comes back byte for byte out of the pool until the body changes", async () => {
    const raw = writeMemory("accepted", BODY);
    markRetrieved("accepted");
    const proposal = await promote("accepted");

    await akmProposalAccept({ stashDir: stash, id: proposal.id, config });

    // O1 archived the source, so nothing is left to select…
    expect(fs.existsSync(memoryPath("accepted"))).toBe(false);
    expect(namesIn(pool())).not.toContain("accepted");

    // …and an undo, a restore or a re-capture of the same text does not put it back.
    fs.writeFileSync(memoryPath("accepted"), raw, "utf8");
    const held = pool();
    expect(namesIn(held)).not.toContain("accepted");
    expect(held.judgedUnchanged).toBe(1);
    expect(ledgerRow("accepted")).toMatchObject({
      outcome: "accepted",
      nextEligibleAt: null,
      contentHash: contentHash(raw, "body"),
    });

    writeMemory("accepted", EDITED);
    expect(namesIn(pool())).toContain("accepted");
  });

  it("offers a source edited after the promotion was queued straight away: it was not archived and its text is new", async () => {
    writeMemory("edited", BODY);
    markRetrieved("edited");
    const proposal = await promote("edited");
    writeMemory("edited", EDITED);

    await akmProposalAccept({ stashDir: stash, id: proposal.id, config });

    expect(fs.existsSync(memoryPath("edited"))).toBe(true); // B3: an edited source is never archived
    expect(ledgerRow("edited")).toMatchObject({ outcome: "accepted", nextEligibleAt: null });
    expect(namesIn(pool())).toContain("edited");
  });
});

describe("a promotion queued before its source hash was recorded", () => {
  // Older releases minted proposals with `promotionSource` but no
  // `promotionSourceHash`. Nothing to compare a body against, so their
  // decisions keep the clock they always had: 7 days after a rejection.
  async function decideLegacy(name: string, decidedDaysAgo: number) {
    writeMemory(name, BODY);
    markRetrieved(name);
    const proposal = createProposal(stash, {
      ref: `knowledge/${name}-notes`,
      source: "consolidate",
      target: { source: "stash", root: stash },
      payload: { content: `---\ndescription: ${name}\n---\n\n${BODY}\n`, frontmatter: { description: name } },
      attemptedRefs: [`memories/${name}`],
      promotionSource: `memories/${name}`,
    });
    await akmProposalReject({
      stashDir: stash,
      id: proposal.id,
      config,
      ctx: { now: () => Date.now() - decidedDaysAgo * DAY_MS },
    });
  }

  it("is held for 7 days and then released, as before", async () => {
    await decideLegacy("recent", 3);
    await decideLegacy("old", 8);

    expect(ledgerRow("recent")?.contentHash).toBeNull();
    expect(ledgerRow("recent")?.nextEligibleAt).not.toBeNull();
    const names = namesIn(pool());
    expect(names).not.toContain("recent");
    expect(names).toContain("old");
  });
});
