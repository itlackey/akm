// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal reopen` (#997): a rejection used to be final — no supported
 * command undid it, and for a `consolidate-pair` retire proposal the record of
 * the rejection also suppressed the pair pass from ever re-proposing that
 * retirement. Reopen moves a rejected proposal back to `pending`, keeping the
 * rejection in its history, unless the world moved on since it was minted.
 *
 * These tests drive the real producers end to end (mint -> reject -> reopen ->
 * accept -> revert), not hand-built rows; `retirement()` computes REAL body
 * hashes from files on disk, since the freshness checks compare them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadRejectedPairKeys } from "../../../src/commands/improve/consolidate/pair-pass";
import { contentHash } from "../../../src/commands/improve/content-hash";
import { stageJudgedProposal } from "../../../src/commands/improve/stage";
import { drainProposals } from "../../../src/commands/proposal/drain";
import {
  akmProposalAccept,
  akmProposalReject,
  akmProposalReopen,
  akmProposalRevert,
  bulkAdjudicateProposals,
} from "../../../src/commands/proposal/proposal";
import type { Proposal, RetirementMetadata } from "../../../src/commands/proposal/proposal-types";
import {
  archiveProposal,
  createProposal as createProposalImpl,
  createRetireProposal,
  expireStaleProposals,
  getProposal,
  listProposals,
  recordGateDecision,
} from "../../../src/commands/proposal/repository";
import { NotFoundError, UsageError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { getImproveLedgerRow } from "../../../src/storage/repositories/improve-ledger-repository";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  for (const dir of ["memories", "knowledge", "lessons"]) {
    fs.mkdirSync(path.join(storage.stashDir, dir), { recursive: true });
  }
});

afterEach(() => {
  storage.cleanup();
});

const stash = () => storage.stashDir;
const config = () => makeConfig(storage.stashDir);

function writeAsset(relPath: string, frontmatter: string, body = "Body text.\n"): string {
  const filePath = path.join(storage.stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
}

function retirement(
  retiredPath: string,
  successorPath: string,
  retired: string,
  successor: string,
): RetirementMetadata {
  return {
    retiredRef: retired,
    successorRef: successor,
    cosine: 0.986,
    judgeLabel: "duplicate",
    judgeReason: "Same durable facts, B adds nothing new.",
    retiredContentHash: contentHash(fs.readFileSync(retiredPath, "utf8"), "body"),
    successorContentHash: contentHash(fs.readFileSync(successorPath, "utf8"), "body"),
    reason: "duplicate",
  };
}

/** A pending `consolidate-pair` retire proposal over two real memories. */
function mintRetire(retiredName = "old-note", successorName = "new-note") {
  const retiredPath = writeAsset(`memories/${retiredName}.md`, `description: ${retiredName}`, "The durable fact.\n");
  const successorPath = writeAsset(`memories/${successorName}.md`, `description: ${successorName}`);
  const proposal = createRetireProposal(storage.stashDir, {
    ref: `memories/${retiredName}`,
    source: "consolidate-pair",
    retirement: retirement(retiredPath, successorPath, `memories/${retiredName}`, `memories/${successorName}`),
  });
  return { proposal, retiredPath, successorPath };
}

const REJECTION = "consolidate-pair proposal replaces the entire existing doc with a blank line; would destroy content";

async function rejectIt(proposal: Proposal, reason = REJECTION): Promise<Proposal> {
  return (await akmProposalReject({ stashDir: stash(), id: proposal.id, reason, config: config() })).proposal;
}

function ledgerRow(ref: string, source: string) {
  const db = openStateDatabase();
  try {
    return getImproveLedgerRow(db, storage.stashDir, ref, source);
  } finally {
    db.close();
  }
}

describe("akm proposal reopen — a rejected retire proposal", () => {
  test("goes back to pending; the rejection stays in its history; an event and the ledger follow", async () => {
    const { proposal } = mintRetire();
    const rejected = await rejectIt(proposal);
    expect(rejected.status).toBe("rejected");
    expect(ledgerRow(proposal.ref, "consolidate-pair")).toMatchObject({ outcome: "rejected", proposalId: proposal.id });

    const results = await akmProposalReopen({
      stashDir: stash(),
      ids: [proposal.id],
      reason: "diff rendering bug #997",
      config: config(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      schemaVersion: 1,
      ok: true,
      id: proposal.id,
      ref: proposal.ref,
      reason: "diff rendering bug #997",
    });
    const reopened = getProposal(stash(), proposal.id);
    expect(reopened.status).toBe("pending");
    expect(reopened.review).toBeUndefined();
    expect(reopened.reviewHistory).toEqual([
      { review: rejected.review, reopenedAt: reopened.updatedAt, reopenReason: "diff rendering bug #997" },
    ]);
    // Everything else about the proposal is what it was.
    expect(reopened).toMatchObject({
      createdAt: proposal.createdAt,
      changes: proposal.changes,
      retirement: proposal.retirement,
      beforeHash: proposal.beforeHash,
    });

    expect(listProposals(stash(), { status: "pending" }).map((p) => p.id)).toEqual([proposal.id]);
    expect(listProposals(stash(), { status: "rejected", includeArchive: true })).toEqual([]);

    const events = readEvents({ type: "proposal_reopened" }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ref: proposal.ref,
      metadata: { proposalId: proposal.id, source: "consolidate-pair", reason: "diff rendering bug #997" },
    });

    // A retire mint writes no ledger row, so reopening leaves none behind: the
    // "rejected" one described a decision that no longer stands.
    expect(ledgerRow(proposal.ref, "consolidate-pair")).toBeUndefined();
  });

  test("without --reason the history entry and the event carry none", async () => {
    const { proposal } = mintRetire();
    await rejectIt(proposal);
    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() });
    const entry = getProposal(stash(), proposal.id).reviewHistory?.[0];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("reopenReason");
    expect(readEvents({ type: "proposal_reopened" }).events[0]?.metadata).not.toHaveProperty("reason");
  });

  test("a reopened retire proposal is no longer among the pairs the pair pass treats as settled", async () => {
    const { proposal } = mintRetire();
    await rejectIt(proposal);
    const settled = loadRejectedPairKeys(stash(), undefined);
    expect(settled.size).toBe(1);

    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() });
    expect(loadRejectedPairKeys(stash(), undefined).size).toBe(0);

    // Rejecting it again settles the pair again — with both rejections on record.
    await rejectIt(proposal, "on second thought, no");
    expect([...loadRejectedPairKeys(stash(), undefined)]).toEqual([...settled]);
    const history = getProposal(stash(), proposal.id);
    expect(history.status).toBe("rejected");
    expect(history.reviewHistory).toHaveLength(1);
    expect(history.review?.reason).toBe("on second thought, no");
  });

  test("accepting after a reopen archives the file; revert restores the exact bytes", async () => {
    const { proposal, retiredPath } = mintRetire();
    const original = fs.readFileSync(retiredPath);
    await rejectIt(proposal);
    await akmProposalReopen({
      stashDir: stash(),
      ids: [proposal.id],
      reason: "reviewed the real diff",
      config: config(),
    });

    const accepted = await akmProposalAccept({ stashDir: stash(), id: proposal.id, config: config() });
    expect(accepted.proposal.status).toBe("accepted");
    expect(fs.existsSync(retiredPath)).toBe(false);
    const archived = getProposal(stash(), proposal.id);
    expect(archived.retiredArchive?.dirs).toHaveLength(1);
    expect(fs.existsSync(path.join(stash(), archived.retiredArchive?.dirs[0] ?? "missing"))).toBe(true);
    expect(archived.reviewHistory).toHaveLength(1); // accepting does not erase the reopen
    expect(ledgerRow(proposal.ref, "consolidate-pair")?.outcome).toBe("accepted");

    await akmProposalRevert({ stashDir: stash(), id: proposal.id, config: config() });
    expect(fs.readFileSync(retiredPath).equals(original)).toBe(true);
    expect(getProposal(stash(), proposal.id).status).toBe("reverted");
  });

  test("a reopened proposal that is rejected again can be reopened again; the history accumulates", async () => {
    const { proposal } = mintRetire();
    await rejectIt(proposal, "first");
    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], reason: "one", config: config() });
    await rejectIt(proposal, "second");
    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], reason: "two", config: config() });

    const reopened = getProposal(stash(), proposal.id);
    expect(reopened.status).toBe("pending");
    expect(reopened.reviewHistory?.map((entry) => [entry.review?.reason, entry.reopenReason])).toEqual([
      ["first", "one"],
      ["second", "two"],
    ]);
    expect(readEvents({ type: "proposal_reopened" }).events).toHaveLength(2);
  });

  test("the same proposal named twice is reopened once", async () => {
    const { proposal } = mintRetire();
    await rejectIt(proposal);
    const results = await akmProposalReopen({ stashDir: stash(), ids: [proposal.id, proposal.id], config: config() });
    expect(results).toHaveLength(1);
    expect(getProposal(stash(), proposal.id).reviewHistory).toHaveLength(1);
  });
});

describe("akm proposal reopen — the age a sweep sees", () => {
  const DAY = 86_400_000;
  const longAgo = { now: () => Date.now() - 30 * DAY };

  /** A retire proposal minted 30 days ago. */
  function mintOldRetire(name: string) {
    const retiredPath = writeAsset(`memories/${name}-old.md`, `description: ${name}-old`, "The durable fact.\n");
    const successorPath = writeAsset(`memories/${name}-new.md`, `description: ${name}-new`);
    return createRetireProposal(
      storage.stashDir,
      {
        ref: `memories/${name}-old`,
        source: "consolidate-pair",
        retirement: retirement(retiredPath, successorPath, `memories/${name}-old`, `memories/${name}-new`),
      },
      longAgo,
    );
  }

  test("`--older-than` counts a reopened proposal from its reopen: a bulk accept or reject leaves it alone", async () => {
    const reopened = mintOldRetire("reopened");
    const untouched = mintOldRetire("untouched");
    await rejectIt(reopened);
    await akmProposalReopen({ stashDir: stash(), ids: [reopened.id], config: config() });
    expect(Date.now() - Date.parse(getProposal(stash(), reopened.id).createdAt)).toBeGreaterThan(29 * DAY); // old by creation

    for (const action of ["accept", "reject"] as const) {
      const sweep = await bulkAdjudicateProposals({
        stashDir: stash(),
        config: config(),
        action,
        generator: "consolidate-pair",
        olderThanMs: 7 * DAY,
        dryRun: true,
      });
      expect({ action, ids: sweep.results.map((result) => (result as { id: string }).id) }).toEqual({
        action,
        ids: [untouched.id],
      });
    }
    // Without the age filter both are in the sweep, so it is the reopen that keeps the first one out.
    const everything = await bulkAdjudicateProposals({
      stashDir: stash(),
      config: config(),
      action: "reject",
      generator: "consolidate-pair",
      dryRun: true,
    });
    expect(everything.count).toBe(2);
  });
});

describe("akm proposal reopen — refusals", () => {
  async function expectRefused(ids: string[], message: RegExp): Promise<UsageError> {
    const error = await akmProposalReopen({ stashDir: stash(), ids, config: config() }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toMatch(message);
    expect((error as UsageError).code).toBe("INVALID_FLAG_VALUE");
    return error as UsageError;
  }

  test("a pending proposal is refused", async () => {
    const { proposal } = mintRetire();
    await expectRefused([proposal.id], /cannot be reopened: it is not rejected \(current status: pending\)/);
    expect(getProposal(stash(), proposal.id).status).toBe("pending");
    expect(readEvents({ type: "proposal_reopened" }).events).toHaveLength(0);
  });

  test("an accepted proposal is refused, and so is a reverted one", async () => {
    const { proposal } = mintRetire();
    await akmProposalAccept({ stashDir: stash(), id: proposal.id, config: config() });
    await expectRefused([proposal.id], /not rejected \(current status: accepted\)/);
    await akmProposalRevert({ stashDir: stash(), id: proposal.id, config: config() });
    await expectRefused([proposal.id], /not rejected \(current status: reverted\)/);
    expect(getProposal(stash(), proposal.id).status).toBe("reverted");
  });

  test("a retire proposal whose retired file changed since it was minted is refused", async () => {
    const { proposal, retiredPath } = mintRetire();
    await rejectIt(proposal);
    writeAsset("memories/old-note.md", "description: old-note", "The durable fact, since corrected.\n");
    expect(fs.existsSync(retiredPath)).toBe(true);
    await expectRefused([proposal.id], /cannot be reopened: Retire proposal .* is stale/);
    expect(getProposal(stash(), proposal.id).status).toBe("rejected");
    expect(getProposal(stash(), proposal.id).reviewHistory).toBeUndefined();
  });

  test("a retire proposal whose successor changed is refused", async () => {
    const { proposal } = mintRetire();
    await rejectIt(proposal);
    writeAsset("memories/new-note.md", "description: new-note", "Rewritten since.\n");
    await expectRefused([proposal.id], /is stale — successor memories\/new-note changed since judging/);
    expect(getProposal(stash(), proposal.id).status).toBe("rejected");
  });

  test("a retire proposal whose successor is gone is refused", async () => {
    const { proposal, successorPath } = mintRetire();
    await rejectIt(proposal);
    fs.rmSync(successorPath);
    await expectRefused([proposal.id], /successor memories\/new-note no longer exists/);
  });

  test("a retire proposal whose retired file is gone is refused", async () => {
    const { proposal, retiredPath } = mintRetire();
    await rejectIt(proposal);
    fs.rmSync(retiredPath);
    await expectRefused([proposal.id], /its retired file no longer exists/);
  });

  test("a batch is all-or-nothing: one refusal reopens none, and names every proposal it refused", async () => {
    const a = mintRetire("old-a", "new-a");
    const b = mintRetire("old-b", "new-b");
    const c = mintRetire("old-c", "new-c");
    for (const { proposal } of [a, b, c]) await rejectIt(proposal);
    writeAsset("memories/old-b.md", "description: old-b", "Edited.\n");
    fs.rmSync(c.successorPath);

    const error = await expectRefused([a.proposal.id, b.proposal.id, c.proposal.id], /Cannot reopen 2 of 3 proposals/);
    expect(error.message).toContain(b.proposal.id);
    expect(error.message).toContain(c.proposal.id);
    expect(error.message).not.toContain(a.proposal.id);
    for (const { proposal } of [a, b, c]) expect(getProposal(stash(), proposal.id).status).toBe("rejected");
    expect(readEvents({ type: "proposal_reopened" }).events).toHaveLength(0);

    // Without the two stale ones the same command goes through.
    await akmProposalReopen({ stashDir: stash(), ids: [a.proposal.id], config: config() });
    expect(getProposal(stash(), a.proposal.id).status).toBe("pending");
  });

  test("a pair whose asset was meanwhile re-paired is refused while the newer retire proposal is pending", async () => {
    // Rejected X->Y; the pair pass, which only settles the exact pair, then mints X->Z.
    const first = mintRetire("old-note", "new-note");
    await rejectIt(first.proposal);
    const otherPath = writeAsset("memories/other-note.md", "description: other-note");
    const second = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement(first.retiredPath, otherPath, "memories/old-note", "memories/other-note"),
    });

    await expectRefused(
      [first.proposal.id],
      new RegExp(`memories/old-note is already part of retire proposal ${second.id}`),
    );
    expect(getProposal(stash(), first.proposal.id).status).toBe("rejected");

    // Decide the newer one and the older can come back.
    await rejectIt(second);
    await akmProposalReopen({ stashDir: stash(), ids: [first.proposal.id], config: config() });
    expect(getProposal(stash(), first.proposal.id).status).toBe("pending");
  });

  test("two rejected proposals that share an asset cannot be reopened together — the later is refused", async () => {
    const first = mintRetire("old-note", "new-note");
    await rejectIt(first.proposal);
    const otherPath = writeAsset("memories/other-note.md", "description: other-note");
    const second = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement(first.retiredPath, otherPath, "memories/old-note", "memories/other-note"),
    });
    await rejectIt(second);

    const error = await expectRefused(
      [first.proposal.id, second.id],
      /Cannot reopen 1 of 2 proposals; none were reopened/,
    );
    expect(error.message).toContain(second.id);
    expect(error.message).toContain(`retire proposal ${first.proposal.id}`);
    expect(getProposal(stash(), first.proposal.id).status).toBe("rejected");
    expect(getProposal(stash(), second.id).status).toBe("rejected");
  });

  test("a proposal recorded before the change envelope existed is refused, not half-restored", async () => {
    // ~89% of archived rows on a real install: no `changes` and no `proposedTarget` in metadata_json at all.
    const db = openStateDatabase();
    try {
      db.prepare(
        `INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
         VALUES (?, ?, ?, 'rejected', 'reflect', ?, ?, ?, NULL, ?)`,
      ).run(
        "legacy-rejected",
        stash(),
        "stash//lessons/legacy",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "old body",
        JSON.stringify({ review: { outcome: "rejected", reason: "old", decidedAt: "2026-01-02T00:00:00.000Z" } }),
      );
    } finally {
      db.close();
    }
    await expectRefused(["legacy-rejected"], /before proposals carried their change envelope/);
    expect(getProposal(stash(), "legacy-rejected").status).toBe("rejected");
  });

  test("an unknown id, and a prefix (which only matches pending proposals), are not found, with a hint", async () => {
    const { proposal } = mintRetire();
    await rejectIt(proposal);
    for (const id of ["00000000-0000-0000-0000-000000000000", proposal.id.slice(0, 8)]) {
      const error = await akmProposalReopen({ stashDir: stash(), ids: [id], config: config() }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).code).toBe("PROPOSAL_NOT_FOUND");
      expect((error as NotFoundError).hint()).toContain("full id");
    }
  });
});

describe("akm proposal reopen — any rejected proposal, not just a retirement", () => {
  const LESSON = "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching repos\n---\n\nPrefer rg.\n";
  const createProposal: typeof createProposalImpl = (dir, input, ctx) =>
    createProposalImpl(dir, { ...input, target: input.target ?? { source: "stash", root: path.resolve(dir) } }, ctx);

  function mintLesson(source = "reflect") {
    return createProposal(stash(), {
      ref: "lessons/rg-over-grep",
      source,
      sourceRun: "run-1",
      payload: { content: LESSON },
    });
  }

  test("returns to pending with its ledger row back at `proposed`, and its gate verdict moved into the history", async () => {
    const proposal = mintLesson();
    expect(ledgerRow(proposal.ref, "reflect")).toMatchObject({ outcome: "proposed", proposalId: proposal.id });
    const rejected = (
      await akmProposalReject({
        stashDir: stash(),
        id: proposal.id,
        reason: "not now",
        config: config(),
        gateDecision: { outcome: "auto-rejected", reason: "judgment-reject", gate: "quality-gate" },
      })
    ).proposal;
    const afterReject = ledgerRow(proposal.ref, "reflect");
    expect(afterReject?.outcome).toBe("rejected");
    expect(afterReject?.nextEligibleAt).not.toBeNull(); // reflect: a 14-day window nothing should apply to a pending proposal

    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], reason: "second look", config: config() });

    const reopened = getProposal(stash(), proposal.id);
    expect(reopened.status).toBe("pending");
    // Another gate's `auto-rejected` verdict would have the drain skip it forever.
    expect(reopened.gateDecision).toBeUndefined();
    expect(reopened.reviewHistory).toEqual([
      {
        review: rejected.review,
        gateDecision: rejected.gateDecision,
        reopenedAt: reopened.updatedAt,
        reopenReason: "second look",
      },
    ]);
    const row = ledgerRow(proposal.ref, "reflect");
    expect(row).toMatchObject({ outcome: "proposed", proposalId: proposal.id, detail: "reopened: second look" });
    expect(row?.lastAttemptAt).toBe(afterReject?.lastAttemptAt); // a decision keeps the attempt time
    expect(Date.parse(row?.nextEligibleAt ?? "")).toBeGreaterThan(Date.now()); // the revisit cadence, not the rejection window

    // And it is an ordinary pending proposal again.
    const accepted = await akmProposalAccept({ stashDir: stash(), id: proposal.id, config: config() });
    expect(accepted.proposal.status).toBe("accepted");
    expect(fs.readFileSync(accepted.assetPath, "utf8")).toContain("Prefer rg.");
    expect(ledgerRow(proposal.ref, "reflect")?.outcome).toBe("accepted");
  });

  test("a `staged` verdict does not survive a rejection that is then reopened: the drain must not accept it unseen", async () => {
    const proposal = mintLesson();
    stageJudgedProposal(stash(), proposal); // a quality judge passed it
    const drain = () => drainProposals({ stashDir: stash(), applyMode: "promote", maxAccepts: 25, dryRun: true });
    expect((await drain()).promoted).toEqual([proposal.id]); // control: staged and pending, the drain would accept it

    // A human then rejects it by hand, which leaves the verdict on the row.
    await rejectIt(proposal, "no");
    expect(getProposal(stash(), proposal.id).gateDecision?.outcome).toBe("staged");

    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() });
    expect(getProposal(stash(), proposal.id).gateDecision).toBeUndefined();
    const drained = await drain();
    expect(drained.promoted).toEqual([]);
    expect(drained.deferred).toEqual([{ id: proposal.id, reason: "needs-judgment" }]); // undecided, as any new proposal is
  });

  test("a `deferred` quality-gate verdict is kept: the drain still leaves a reopened proposal for the person it was handed to", async () => {
    const proposal = mintLesson();
    recordGateDecision(stash(), proposal.id, { outcome: "deferred", reason: "quality-review", gate: "quality-gate" });
    await rejectIt(proposal, "not now"); // by hand: the deferral stays on the row
    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], reason: "second look", config: config() });

    const reopened = getProposal(stash(), proposal.id);
    expect(reopened.gateDecision).toMatchObject({
      outcome: "deferred",
      reason: "quality-review",
      gate: "quality-gate",
    });
    expect(reopened.reviewHistory?.[0]?.gateDecision).toMatchObject({ outcome: "deferred" }); // the history records it regardless

    // Cleared, the drain would judge it (and, in promote mode, could accept it); kept, it never touches it.
    const drained = await drainProposals({ stashDir: stash(), applyMode: "promote", maxAccepts: 25, dryRun: true });
    expect(drained).toMatchObject({
      promoted: [],
      rejected: [],
      deferred: [],
      skippedByCap: [],
      staged: [],
      failed: [],
    });
  });

  test("an update proposal whose target changed since it was minted is refused", async () => {
    const lessonPath = path.join(stash(), "lessons", "rg-over-grep.md");
    fs.writeFileSync(lessonPath, "---\ndescription: Original\nwhen_to_use: Testing\n---\n\nOriginal.\n", "utf8");
    const proposal = mintLesson();
    expect(proposal.changes[0]?.op).toBe("update");
    await rejectIt(proposal, "no");
    fs.writeFileSync(lessonPath, "---\ndescription: Original\nwhen_to_use: Testing\n---\n\nEdited by hand.\n", "utf8");

    await expect(akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() })).rejects.toThrow(
      /Proposal target changed after proposal .* was created/,
    );
    expect(getProposal(stash(), proposal.id).status).toBe("rejected");
  });

  test("a create proposal is refused once its target exists", async () => {
    const proposal = mintLesson();
    expect(proposal.changes[0]?.op).toBe("create");
    await rejectIt(proposal, "no");
    fs.writeFileSync(path.join(stash(), "lessons", "rg-over-grep.md"), LESSON, "utf8");
    await expect(akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() })).rejects.toThrow(
      /was created after proposal/,
    );
  });

  test("an unchanged update proposal reopens even after the file was rewritten identically", async () => {
    const lessonPath = path.join(stash(), "lessons", "rg-over-grep.md");
    const original = "---\ndescription: Original\nwhen_to_use: Testing\n---\n\nOriginal.\n";
    fs.writeFileSync(lessonPath, original, "utf8");
    const proposal = mintLesson();
    await rejectIt(proposal, "no");
    fs.writeFileSync(lessonPath, original, "utf8");
    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() });
    expect(getProposal(stash(), proposal.id).status).toBe("pending");
  });

  test("a reopened proposal's retention clock starts at the reopen, so the next sweep does not expire it again", async () => {
    const DAY = 86_400_000;
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const at = (days: number) => ({ now: () => t0 + days * DAY });
    const retention = { archiveRetentionDays: 30 } as never;
    const proposal = createProposal(
      stash(),
      { ref: "lessons/rg-over-grep", source: "reflect", sourceRun: "r", payload: { content: LESSON } },
      at(0),
    );

    expect(expireStaleProposals(stash(), retention, at(40)).expired).toBe(1); // aged out: rejected as `expired`
    expect(getProposal(stash(), proposal.id).status).toBe("rejected");

    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config(), ctx: at(41) });
    expect(expireStaleProposals(stash(), retention, at(60)).expired).toBe(0); // 19 days since the reopen
    expect(getProposal(stash(), proposal.id).status).toBe("pending");
    expect(expireStaleProposals(stash(), retention, at(72)).expired).toBe(1); // 31 days since the reopen
  });

  test("a procedurally rejected proposal (archiveProposal) reopens like any other", async () => {
    const proposal = mintLesson();
    archiveProposal(stash(), proposal.id, "rejected", "expired: no action within retention window", undefined, {
      outcome: "auto-rejected",
      reason: "expired",
      gate: "retention",
    });
    expect(ledgerRow(proposal.ref, "reflect")?.outcome).toBe("expired");
    await akmProposalReopen({ stashDir: stash(), ids: [proposal.id], config: config() });
    expect(getProposal(stash(), proposal.id)).toMatchObject({ status: "pending" });
    expect(ledgerRow(proposal.ref, "reflect")?.outcome).toBe("proposed");
  });
});
