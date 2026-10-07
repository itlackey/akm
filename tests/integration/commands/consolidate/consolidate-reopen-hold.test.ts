// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal reopen` (#997) meets the promotion hold (#998).
 *
 * A rejected consolidate promotion holds its source memory by body hash: the
 * ledger row is `rejected` with the hash the promotion was queued against and no
 * clock, and the pool offers the memory again only when its body changes.
 * Reopening the proposal must undo exactly that: the row goes back to `proposed`
 * on the 7-day revisit cadence with no hash, the proposal is pending, and a
 * later rejection must restore the hold, wherever the memory's ledger row got to
 * in between. In particular the model can be asked about the memory again while
 * the reopened proposal is pending, and that must not mint a second proposal.
 *
 * Every step runs the real code: `emitPromotionProposal` and `akmConsolidate`
 * (with the model behind a mocked fetch) mint and re-offer, the proposal API
 * rejects and reopens, `recordGateDecision` is the drain's deferral, and
 * `inspectConsolidationPool` selects. Decisions carry an explicit `ctx.now`, so
 * "8 days on" needs no waiting; the memory is marked as retrieved so that the
 * retrieval scope (#986) never masks what the ledger decides.
 *
 * Integration (ORG-03): opens a real state.db (the proposal and ledger
 * repositories) and probes index.db through `akmConsolidate` and
 * `inspectConsolidationPool` (`openExistingDatabase`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmConsolidate,
  type ConsolidatePromoteOp,
  emitPromotionProposal,
  inspectConsolidationPool,
} from "../../../../src/commands/improve/consolidate";
import { contentHash } from "../../../../src/commands/improve/content-hash";
import { akmProposalAccept, akmProposalReject, akmProposalReopen } from "../../../../src/commands/proposal/proposal";
import { getProposal, listProposals, recordGateDecision } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import { resolveWriteTarget } from "../../../../src/core/write-source";
import {
  getImproveLedgerRow,
  isContentDrivenRow,
  listImproveLedgerRows,
} from "../../../../src/storage/repositories/improve-ledger-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../../_helpers/sandbox";

const DAY_MS = 86_400_000;
const NAME = "reopen-hold";
const REF = `memories/${NAME}`;
const KNOWLEDGE_SLUG = `${NAME}-notes`;
/** The mint's two guards against queueing a promotion that is already pending: the same target, and the same body. */
const PENDING_GUARDS = ["promote_pending_proposal_exists", "dedup_pending_proposal"];

let storage: IsolatedAkmStorage;
let stash: string;
let config: AkmConfig;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = storage.stashDir;
  config = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    engines: {
      planner: { kind: "llm", endpoint: "https://consolidate.example.test/v1/chat/completions", model: "planner" },
    },
    defaults: { llmEngine: "planner", improveStrategy: "default" },
    improve: { strategies: { default: { processes: { consolidate: { enabled: true } } } } },
  } as AkmConfig;
  for (const dir of ["memories", "knowledge"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

const BODY =
  "Always run the release check on a clean checkout before tagging, because a dirty tree hides files the build needs. " +
  "The second sentence keeps this fixture above the promotion size gate.";
const EDITED = `${BODY} A later note adds that the check also needs network access.`;

function writeMemory(body: string): string {
  const file = path.join(stash, "memories", `${NAME}.md`);
  fs.writeFileSync(file, `---\ndescription: ${NAME} memory\n---\n\n${body}\n`, "utf8");
  return fs.readFileSync(file, "utf8");
}

/** A user search returned the memory, so it stays inside the retrieval scope whatever the ledger says. */
function markRetrieved(): void {
  const db = openStateDatabase();
  try {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source, created_at) VALUES (?, ?, ?, ?)").run(
      "search",
      `stash//${REF}`,
      "user",
      new Date().toISOString().replace("T", " ").slice(0, 19),
    );
  } finally {
    db.close();
  }
}

/** The model proposes to promote the memory, straight into the mint: what a run does once the pool offered it. */
async function offer(knowledgeSlug = KNOWLEDGE_SLUG) {
  const op: ConsolidatePromoteOp = {
    op: "promote",
    ref: REF,
    knowledgeRef: `knowledge/${knowledgeSlug}`,
    reason: "test",
    description: `${NAME} notes`,
  };
  const skips: string[] = [];
  const promoted: string[] = [];
  await emitPromotionProposal(op, {
    config,
    stashDir: stash,
    sourceRun: "consolidate-reopen-hold-test",
    target: resolveWriteTarget(config),
    memoryByRef: new Map([
      [
        REF,
        {
          name: NAME,
          filePath: path.join(stash, "memories", `${NAME}.md`),
          description: "",
          tags: [],
          stashDir: stash,
        },
      ],
    ]),
    promoted,
    promotedSourceRefs: new Set(),
    existingKnowledgeBodyHashes: new Set(),
    promotionFailures: { count: 0 },
    warnings: [],
    pushSkipReason: (_op, _ref, reason) => skips.push(reason),
  });
  return { skips, promoted };
}

/** Queue the promotion through the real mint path; returns the pending proposal. */
async function mint() {
  const { skips, promoted } = await offer();
  expect(skips).toEqual([]);
  expect(promoted).toHaveLength(1);
  return getProposal(stash, promoted[0]!);
}

/** A whole consolidate run: the real pool, the model behind a mocked endpoint that always proposes this memory, the real mint. */
async function runConsolidate() {
  let modelCalls = 0;
  const result = await withMockedFetch(
    () => akmConsolidate({ stashDir: stash, config, sourceRun: "consolidate-reopen-hold-test" }),
    async () => {
      modelCalls++;
      const operations = [
        { op: "promote", ref: REF, knowledgeRef: `knowledge/${KNOWLEDGE_SLUG}`, reason: "durable", description: NAME },
      ];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return { result, modelCalls };
}

const daysAgo = (days: number) => () => Date.now() - days * DAY_MS;

const reject = (id: string, days: number, reason = "duplicate of knowledge/release-check") =>
  akmProposalReject({ stashDir: stash, id, config, reason, ctx: { now: daysAgo(days) } });

const reopen = (id: string, days: number) =>
  akmProposalReopen({ stashDir: stash, ids: [id], config, reason: "rejected by mistake", ctx: { now: daysAgo(days) } });

function ledgerRow() {
  const db = openStateDatabase();
  try {
    return getImproveLedgerRow(db, stash, REF, "consolidate");
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

const pendingPromotions = (): string[] =>
  listProposals(stash, { status: "pending" })
    .filter((p) => p.promotionSource === REF)
    .map((p) => p.id);

const pool = () => inspectConsolidationPool({ config }, stash, []);
const poolHas = (snapshot: ReturnType<typeof pool>): boolean => snapshot.memories.some((m) => m.name === NAME);

describe("reject, reopen and reject again (#997, #998)", () => {
  test("reopen releases the hold, a re-offer mints no duplicate, and the next rejection restores the hold", async () => {
    const raw = writeMemory(BODY);
    markRetrieved();
    const hash = contentHash(raw, "body");
    const proposal = await mint();

    // 1. Rejected 20 days ago: the memory is held by its body hash, not by any clock.
    await reject(proposal.id, 20);
    expect(getProposal(stash, proposal.id).status).toBe("rejected");
    expect(ledgerRow()).toMatchObject({
      outcome: "rejected",
      nextEligibleAt: null,
      contentHash: hash,
      proposalId: proposal.id,
    });
    const held = pool();
    expect(poolHas(held)).toBe(false);
    expect(held.judgedUnchanged).toBe(1);
    expect((await runConsolidate()).modelCalls).toBe(0); // a held memory never reaches the model

    // 2. Reopened 8 days ago, so the 7-day revisit window it starts has since elapsed.
    const reopenedAt = Date.now() - 8 * DAY_MS;
    await akmProposalReopen({
      stashDir: stash,
      ids: [proposal.id],
      config,
      reason: "rejected by mistake",
      ctx: { now: () => reopenedAt },
    });
    expect(getProposal(stash, proposal.id).status).toBe("pending");
    // The row is what a mint writes: `proposed` on the revisit cadence from the reopen, and no hash.
    const afterReopen = ledgerRow();
    expect(afterReopen).toMatchObject({
      outcome: "proposed",
      contentHash: null,
      proposalId: proposal.id,
      nextEligibleAt: new Date(reopenedAt + 7 * DAY_MS).toISOString(),
    });
    expect(isContentDrivenRow(afterReopen!)).toBe(false);
    const released = pool();
    expect(poolHas(released)).toBe(true); // nothing holds it any more
    expect(released.judgedUnchanged).toBe(0);
    expect(pendingPromotions()).toEqual([proposal.id]);

    // 3. The model is asked about the unchanged memory again. The reopened proposal is still pending,
    // so the mint drops the promotion, under the same slug and under another one.
    const rerun = await runConsolidate();
    expect(rerun.modelCalls).toBe(1);
    expect(rerun.result.promoted).toEqual([]);
    expect(rerun.result.skipReasons).toHaveLength(1);
    expect(rerun.result.skipReasons?.[0]?.ref).toBe(REF);
    expect(rerun.result.skipReasons?.[0]?.skips).toHaveLength(1);
    expect(rerun.result.skipReasons?.[0]?.skips[0]?.reason).toBeOneOf(PENDING_GUARDS);
    // Under another slug there is no same-target clash; the identical body still gives it away.
    expect(await offer("reopen-hold-under-another-name")).toEqual({ skips: ["dedup_pending_proposal"], promoted: [] });
    expect(pendingPromotions()).toEqual([proposal.id]); // still the one proposal, no duplicate
    // That run judged the memory, which took over its ledger row and dropped the link to the proposal: the
    // situation step 4 is about. (Should a run ever stop doing that, force this precondition instead.)
    expect(ledgerRow()).toMatchObject({ outcome: "judged_no_action", proposalId: null, contentHash: hash });

    // 4. The drain defers the reopened proposal to a person. The deferral goes to the memory's row, not to one
    // under the knowledge ref (which the next verdict would then have updated instead).
    recordGateDecision(stash, proposal.id, { outcome: "deferred", reason: "judgment-deferred", gate: "triage" });
    expect(ledgerRow()).toMatchObject({ outcome: "review_needed", proposalId: proposal.id });
    expect(ledgerRefs()).toEqual([REF]);

    // 5. Rejected again: the hold is back, on the memory's own row and with the hash.
    await reject(proposal.id, 8);
    expect(getProposal(stash, proposal.id).status).toBe("rejected");
    expect(ledgerRow()).toMatchObject({
      outcome: "rejected",
      nextEligibleAt: null,
      contentHash: hash,
      proposalId: proposal.id,
    });
    expect(ledgerRefs()).toEqual([REF]);
    const heldAgain = pool();
    expect(poolHas(heldAgain)).toBe(false);
    expect(heldAgain.judgedUnchanged).toBe(1);
    expect((await runConsolidate()).modelCalls).toBe(0);

    // Only an edit releases it.
    writeMemory(EDITED);
    expect(poolHas(pool())).toBe(true);
  });

  test("reopened at once, the memory waits out the pending proposal's 7 days, and the deferral and re-rejection stay on its row", async () => {
    const raw = writeMemory(BODY);
    markRetrieved();
    const hash = contentHash(raw, "body");
    const proposal = await mint();

    await reject(proposal.id, 0);
    expect(ledgerRow()).toMatchObject({ outcome: "rejected", nextEligibleAt: null, contentHash: hash });

    await reopen(proposal.id, 0);
    const row = ledgerRow();
    expect(row).toMatchObject({ outcome: "proposed", contentHash: null, proposalId: proposal.id });
    expect(isContentDrivenRow(row!)).toBe(false);
    expect(Date.parse(row?.nextEligibleAt ?? "")).toBeGreaterThan(Date.now()); // the revisit cadence of a pending proposal
    const waiting = pool();
    expect(poolHas(waiting)).toBe(false);
    expect(waiting.judgedUnchanged).toBe(1);
    expect((await runConsolidate()).modelCalls).toBe(0);

    // The row was never taken over, so the deferral finds it by the proposal id.
    recordGateDecision(stash, proposal.id, { outcome: "deferred", reason: "judgment-deferred", gate: "triage" });
    expect(ledgerRow()).toMatchObject({ outcome: "review_needed", proposalId: proposal.id });
    expect(ledgerRefs()).toEqual([REF]);

    await reject(proposal.id, 8);
    expect(ledgerRow()).toMatchObject({ outcome: "rejected", nextEligibleAt: null, contentHash: hash });
    expect(ledgerRefs()).toEqual([REF]);
    expect(poolHas(pool())).toBe(false);
    writeMemory(EDITED);
    expect(poolHas(pool())).toBe(true);
  });

  test("accepted after a reopen, the promotion retires its source and the accepted hold takes over", async () => {
    const raw = writeMemory(BODY);
    markRetrieved();
    const hash = contentHash(raw, "body");
    const proposal = await mint();
    await reject(proposal.id, 8);
    await reopen(proposal.id, 8);
    expect(ledgerRow()).toMatchObject({ outcome: "proposed", contentHash: null });

    await akmProposalAccept({ stashDir: stash, id: proposal.id, config });

    // O1 archived the source (its recorded hash still matched); the decision re-recorded the hash the reopen cleared.
    expect(fs.existsSync(path.join(stash, "memories", `${NAME}.md`))).toBe(false);
    expect(ledgerRow()).toMatchObject({ outcome: "accepted", nextEligibleAt: null, contentHash: hash });
    expect(ledgerRefs()).toEqual([REF]);

    // The same text coming back does not put the memory back in the pool; an edit does.
    fs.writeFileSync(path.join(stash, "memories", `${NAME}.md`), raw, "utf8");
    expect(poolHas(pool())).toBe(false);
    writeMemory(EDITED);
    expect(poolHas(pool())).toBe(true);
  });
});
