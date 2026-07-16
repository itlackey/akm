// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: proposal accept/revert + reject engine round-trip outcomes
 * (WI-03, plan §11 Chunk 0a / R3). Chunk 0a brief §2.2, `anchors.md`
 * `repository.ts:1036-1416` (accept/revert transaction engine, phases
 * `prepared -> asset-published -> proposal-persisted -> index-finalized ->
 * event-finalized -> committed`), `:1417-1530` (reject engine, DB-only, no
 * paths/hashes), `:1532-1619` (`prepareProposalTransaction` /
 * `publishProposalAsset` — the fsync + before-hash half outside the plan's
 * named range), `:1643-1756` (`promoteProposal` / `promoteProposalWithLease`,
 * incl. idempotent re-accept short-circuit `:1703-1718`), `:1790-1984`
 * (`revertProposal`).
 *
 * This suite pins file-tree / DB / event outcomes so Chunk 6's collapse into
 * one FileChange transaction has a diff-reviewable preservation oracle
 * (plan §12.3). It is capture-only: no `src/` changes.
 *
 * Encoding (brief §3.2): journal phase sequences are informational data only
 * (never asserted against journal bytes/paths — Chunk 6 replaces the
 * journals); refs are fixture-local (`tests/fixtures/goldens/journal/
 * fixture-refs.ts`); "exactly-once" events are golden as counts
 * (`matchingCount` / `distinctIdempotencyKeyCount`), never as a raw
 * id-keyed map (idempotency keys are random per-run and would leak an
 * unnormalized, non-deterministic value as an object *key*, which
 * `tests/_helpers/golden.ts`'s normalizer cannot rewrite).
 *
 * Designation: `frozen-migration-input` (DESIGNATIONS.json) — preservation
 * oracle through Chunk 6.
 *
 * DEVIATION FROM BRIEF (recorded per the test-first protocol — the brief's
 * assumption about `repository.ts:1608` turned out not to match HEAD
 * behavior; see the "target mutated during displace" test below and its
 * comment for the full trace): the brief's testsFirst description says the
 * target-mutated-during-displace abort surfaces error prefix "Proposal
 * target changed while its backup was being acquired" (`:1608`) with a
 * byte-identical restore. Empirically (this suite's capture run, HEAD
 * `3d9ee7b`) that message is thrown internally but is ALWAYS immediately
 * shadowed: `publishProposalAsset`'s catch block calls
 * `rollbackPreparedProposalTransaction`, which independently re-checks the
 * asset's hash against `originalHash` and — because the external mutation
 * persists — finds its OWN divergence and throws a *different* error
 * ("Cannot roll back proposal transaction: <path> diverged.") before the
 * original error can propagate. The asset is therefore left holding the
 * externally-mutated content (NOT restored), and the transaction directory
 * plus a stray `.akm-proposal-<txnId>.publish` file are orphaned (neither
 * `cleanupProposalPublication` nor `cleanupProposalTransaction` runs, since
 * the rollback call itself threw). This is genuinely today's behavior, not a
 * test-harness artifact — verified with `_setProposalMutationHookForTests`
 * unavailable for this window (see below) and independently with a
 * `spyOn(fs.renameSync)` interception, both producing the identical result.
 * Per brief §1 ("Capture, not aspiration... surprising outcomes get a code
 * comment + a note, not a fix") this suite golden-captures the REAL
 * behavior and records the deviation here rather than in the fixture's
 * `notes` field. Sibling deviation: `_setProposalMutationHookForTests`
 * (`repository.ts:1074`) only fires at 4 named points (`event-persisted`,
 * `reject-state-persisted`, `reject-event-persisted`,
 * `legacy-target-derived`) — none between `prepareProposalTransaction` and
 * `publishProposalAsset` for the accept path. This suite instead uses the
 * `spyOn(fs, "renameSync")` journal-phase-interception technique already
 * established in `tests/commands/mv.test.ts` (keyed to the "prepared" phase
 * written by `writeProposalJournal`), which achieves the same "mutate the
 * target between prepare and publish" window without any `src/` change.
 */

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalReject, akmProposalRevert } from "../../../src/commands/proposal/proposal";
import {
  archiveProposal,
  createProposal,
  getProposal,
  isProposalSkipped,
  type Proposal,
} from "../../../src/commands/proposal/repository";
import { UsageError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { expectGolden, fileTreeManifest } from "../../_helpers/golden";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import {
  ACCEPT_IDEMPOTENT_NAME,
  ACCEPT_NEW_ASSET_NAME,
  ACCEPT_OVERWRITE_NAME,
  ACCEPT_TARGET_MUTATED_NAME,
  CREATE_COOLDOWN_NAME,
  CREATE_DUPLICATE_PENDING_NAME,
  CREATE_FORCE_BYPASS_NAME,
  CREATE_HASH_MATCH_PENDING_NAME,
  CREATE_HASH_MATCH_REJECTED_NAME,
  lessonContent,
  lessonRef,
  REJECT_CONCURRENT_EDIT_NAME,
  REJECT_NON_PENDING_NAME,
  REJECT_SUCCESS_NAME,
  REVERT_REFUSE_CLOBBER_NAME,
  REVERT_SUCCESS_NAME,
} from "../../fixtures/goldens/journal/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/journal/proposal-txn.json";
const SKIP_SHAPES_GOLDEN_PATH = "tests/fixtures/goldens/journal/proposal-skip-shapes.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

function lessonPath(stashDir: string, name: string): string {
  return path.join(stashDir, "lessons", `${name}.md`);
}

function writeAsset(stashDir: string, name: string, content: string): string {
  const p = lessonPath(stashDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/**
 * The unified transaction home (`getDataDir()/txn`, WI-6.3 — mechanical
 * repoint of the legacy `proposal-transactions` root, per the registry's
 * re-baseline-@6 note). `cleanupTxn` (`core/fs-txn.ts`) removes the
 * per-transaction dir and its immediate namespace parent (when empty) but
 * never removes this top-level root itself once created — so "cleaned"
 * means empty-or-absent, not absent.
 */
function proposalTransactionsRoot(dataDir: string): string {
  return path.join(dataDir, "akm", "txn");
}

function transactionsRootIsClean(dataDir: string): boolean {
  const root = proposalTransactionsRoot(dataDir);
  if (!fs.existsSync(root)) return true;
  return fs.readdirSync(root).length === 0;
}

/** Count of events matching {type, ref}, plus the distinct-idempotency-key shape (brief §3.2). */
function eventOutcome(type: string, ref: string): { matchingCount: number; distinctIdempotencyKeyCount: number } {
  const events = readEvents({ type, ref }).events;
  const keys = new Set(events.map((e) => String(e.metadata?.proposalTransactionId ?? "")));
  return { matchingCount: events.length, distinctIdempotencyKeyCount: keys.size };
}

describe("goldens: proposal accept engine round-trip (WI-03, R3)", () => {
  test("accept new-asset success: promotes, exactly-one promoted event, journal dir cleaned", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(ACCEPT_NEW_ASSET_NAME);
      const content = lessonContent(ACCEPT_NEW_ASSET_NAME, "NEW ASSET BODY.");
      const created = createProposal(storage.stashDir, { ref, source: "distill", force: true, payload: { content } });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(result.assetPath, "utf8")).toBe(content);

      const accepted = getProposal(storage.stashDir, created.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedContentHash).toBeDefined();
      expect(accepted.backupContent).toBeUndefined();

      const promoted = eventOutcome("promoted", ref);
      expect(promoted.matchingCount).toBe(1);
      expect(promoted.distinctIdempotencyKeyCount).toBe(1);

      expect(transactionsRootIsClean(storage.dataDir)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test("accept overwrite-existing: captures backup + originalHash before write", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(ACCEPT_OVERWRITE_NAME);
      const original = lessonContent(ACCEPT_OVERWRITE_NAME, "ORIGINAL BODY.");
      const proposed = lessonContent(ACCEPT_OVERWRITE_NAME, "OVERWRITE BODY.");
      writeAsset(storage.stashDir, ACCEPT_OVERWRITE_NAME, original);
      const created = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        force: true,
        payload: { content: proposed },
      });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
      expect(fs.readFileSync(result.assetPath, "utf8")).toBe(proposed);

      const accepted = getProposal(storage.stashDir, created.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.backupContent).toBe(original);
      expect(accepted.acceptedContentHash).toBeDefined();
    } finally {
      storage.cleanup();
    }
  });

  test("idempotent re-accept short-circuit (:1703-1718): no second event, byte-identical tree", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(ACCEPT_IDEMPOTENT_NAME);
      const content = lessonContent(ACCEPT_IDEMPOTENT_NAME, "IDEMPOTENT BODY.");
      const created = createProposal(storage.stashDir, { ref, source: "distill", force: true, payload: { content } });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

      const first = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
      const treeAfterFirst = fileTreeManifest(storage.stashDir);

      const second = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
      const treeAfterSecond = fileTreeManifest(storage.stashDir);

      expect(second.assetPath).toBe(first.assetPath);
      expect(second.proposal.acceptedContentHash).toBe(first.proposal.acceptedContentHash);
      expect(treeAfterSecond).toEqual(treeAfterFirst);

      const promoted = eventOutcome("promoted", ref);
      expect(promoted.matchingCount).toBe(1);
      expect(promoted.distinctIdempotencyKeyCount).toBe(1);
    } finally {
      storage.cleanup();
    }
  });

  test("target-mutated-during-displace abort: real (non-brief) outcome — see file-header DEVIATION", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(ACCEPT_TARGET_MUTATED_NAME);
      const original = lessonContent(ACCEPT_TARGET_MUTATED_NAME, "ORIGINAL BODY.");
      const proposed = lessonContent(ACCEPT_TARGET_MUTATED_NAME, "PROPOSED BODY.");
      const assetPath = writeAsset(storage.stashDir, ACCEPT_TARGET_MUTATED_NAME, original);
      const created = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        force: true,
        payload: { content: proposed },
      });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

      const mutatedContent = "EXTERNALLY MUTATED CONTENT (not proposal content, not original)\n";
      const originalRename = fs.renameSync;
      let triggered = false;
      const spy = spyOn(fs, "renameSync").mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRename(oldPath, newPath);
        if (!triggered && String(oldPath).endsWith("journal.json.tmp") && String(newPath).endsWith("journal.json")) {
          const journal = JSON.parse(fs.readFileSync(String(newPath), "utf8")) as { phase?: string };
          if (journal.phase === "prepared") {
            triggered = true;
            fs.writeFileSync(assetPath, mutatedContent, "utf8");
          }
        }
        return result;
      }) as typeof fs.renameSync);

      let caught: unknown;
      try {
        await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
      } catch (err) {
        caught = err;
      } finally {
        spy.mockRestore();
      }

      expect(triggered).toBe(true);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toStartWith("Cannot roll back proposal transaction:");
      // NOT byte-identical restore: the asset is left holding the external
      // mutator's content (see the file-header DEVIATION note).
      expect(fs.readFileSync(assetPath, "utf8")).toBe(mutatedContent);
      // The proposal never reached "asset-published" -> DB status unchanged.
      expect(getProposal(storage.stashDir, created.id).status).toBe("pending");
      // Orphaned artifacts: the transaction dir and a stray `.publish` sibling
      // survive because rollback itself threw before either cleanup ran.
      expect(transactionsRootIsClean(storage.dataDir)).toBe(false);
      const strayPublishFiles = fs
        .readdirSync(path.dirname(assetPath))
        .filter((f) => f.startsWith(".akm-proposal-") && f.endsWith(".publish"));
      expect(strayPublishFiles.length).toBe(1);
    } finally {
      storage.cleanup();
    }
  });
});

describe("goldens: proposal revert engine round-trip (WI-03, R3)", () => {
  test("revert success: restores backup, flips status, emits exactly-one proposal_reverted event", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(REVERT_SUCCESS_NAME);
      const original = lessonContent(REVERT_SUCCESS_NAME, "ORIGINAL BODY.");
      const proposed = lessonContent(REVERT_SUCCESS_NAME, "ACCEPTED BODY.");
      const assetPath = writeAsset(storage.stashDir, REVERT_SUCCESS_NAME, original);
      const created = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        force: true,
        payload: { content: proposed },
      });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");
      await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
      expect(fs.readFileSync(assetPath, "utf8")).toBe(proposed);

      const result = await akmProposalRevert({ stashDir: storage.stashDir, id: created.id });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(assetPath, "utf8")).toBe(original);
      expect(getProposal(storage.stashDir, created.id).status).toBe("reverted");

      const reverted = eventOutcome("proposal_reverted", ref);
      expect(reverted.matchingCount).toBe(1);
      expect(reverted.distinctIdempotencyKeyCount).toBe(1);
    } finally {
      storage.cleanup();
    }
  });

  test("revert refuse-clobber: reverting A after B accepted over it fails, B's content survives", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(REVERT_REFUSE_CLOBBER_NAME);
      const original = lessonContent(REVERT_REFUSE_CLOBBER_NAME, "ORIGINAL BODY.");
      const aContent = lessonContent(REVERT_REFUSE_CLOBBER_NAME, "PROPOSAL A BODY.");
      const bContent = lessonContent(REVERT_REFUSE_CLOBBER_NAME, "PROPOSAL B BODY.");
      const assetPath = writeAsset(storage.stashDir, REVERT_REFUSE_CLOBBER_NAME, original);

      const proposalA = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        force: true,
        payload: { content: aContent },
      });
      if (isProposalSkipped(proposalA)) throw new Error("unexpected skip");
      await akmProposalAccept({ stashDir: storage.stashDir, id: proposalA.id });

      const proposalB = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        force: true,
        payload: { content: bContent },
      });
      if (isProposalSkipped(proposalB)) throw new Error("unexpected skip");
      await akmProposalAccept({ stashDir: storage.stashDir, id: proposalB.id });

      let caught: unknown;
      try {
        await akmProposalRevert({ stashDir: storage.stashDir, id: proposalA.id });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect((caught as UsageError).code).toBe("INVALID_FLAG_VALUE");
      expect(fs.readFileSync(assetPath, "utf8")).toBe(bContent);
      expect(getProposal(storage.stashDir, proposalA.id).status).toBe("accepted");
    } finally {
      storage.cleanup();
    }
  });
});

describe("goldens: proposal reject engine round-trip (WI-03, R3)", () => {
  test("reject success: status flips, exactly-one rejected event", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(REJECT_SUCCESS_NAME);
      const content = lessonContent(REJECT_SUCCESS_NAME, "REJECT ME.");
      const created = createProposal(storage.stashDir, { ref, source: "distill", force: true, payload: { content } });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

      const result = await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "not useful" });
      expect(result.ok).toBe(true);
      expect(getProposal(storage.stashDir, created.id).status).toBe("rejected");

      const rejected = eventOutcome("rejected", ref);
      expect(rejected.matchingCount).toBe(1);
      expect(rejected.distinctIdempotencyKeyCount).toBe(1);
    } finally {
      storage.cleanup();
    }
  });

  test("reject non-pending proposal throws UsageError INVALID_FLAG_VALUE", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(REJECT_NON_PENDING_NAME);
      const content = lessonContent(REJECT_NON_PENDING_NAME, "ALREADY REJECTED.");
      const created = createProposal(storage.stashDir, { ref, source: "distill", force: true, payload: { content } });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");
      await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "first rejection" });

      let caught: unknown;
      try {
        await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "second rejection" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect((caught as UsageError).code).toBe("INVALID_FLAG_VALUE");
    } finally {
      storage.cleanup();
    }
  });

  test("reject SUCCEEDS while the target asset is concurrently modified (reject has NO before-hash)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(REJECT_CONCURRENT_EDIT_NAME);
      const original = lessonContent(REJECT_CONCURRENT_EDIT_NAME, "ORIGINAL BODY.");
      const proposed = lessonContent(REJECT_CONCURRENT_EDIT_NAME, "PROPOSED BODY.");
      const assetPath = writeAsset(storage.stashDir, REJECT_CONCURRENT_EDIT_NAME, original);
      const created = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        force: true,
        payload: { content: proposed },
      });
      if (isProposalSkipped(created)) throw new Error("unexpected skip");

      // Concurrent external edit of the target the proposal would write to —
      // the reject engine never reads or hashes this path (repository.ts
      // :1405-1415: "no paths, no hashes: DB-only"), so this must not matter.
      fs.writeFileSync(assetPath, "CONCURRENTLY EDITED BY SOMETHING ELSE\n", "utf8");

      const result = await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "concurrent" });
      expect(result.ok).toBe(true);
      expect(getProposal(storage.stashDir, created.id).status).toBe("rejected");
      // The concurrent edit is left untouched — reject never touches the file.
      expect(fs.readFileSync(assetPath, "utf8")).toBe("CONCURRENTLY EDITED BY SOMETHING ELSE\n");
    } finally {
      storage.cleanup();
    }
  });
});

describe("goldens: createProposal skip-record shapes (WI-03, R3)", () => {
  test("duplicate_pending: second create for the same ref+source without force is skipped", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(CREATE_DUPLICATE_PENDING_NAME);
      const a = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        payload: { content: lessonContent(CREATE_DUPLICATE_PENDING_NAME, "FIRST BODY.") },
      });
      if (isProposalSkipped(a)) throw new Error("unexpected skip on first create");

      const b = createProposal(storage.stashDir, {
        ref,
        source: "distill",
        payload: { content: lessonContent(CREATE_DUPLICATE_PENDING_NAME, "SECOND DIFFERENT BODY.") },
      });
      expect(isProposalSkipped(b)).toBe(true);
      if (!isProposalSkipped(b)) throw new Error("expected skip");
      expect(b.reason).toBe("duplicate_pending");
      expect(b.existingProposalId).toBe(a.id);
    } finally {
      storage.cleanup();
    }
  });

  test("content_hash_match vs a pending proposal", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(CREATE_HASH_MATCH_PENDING_NAME);
      const content = lessonContent(CREATE_HASH_MATCH_PENDING_NAME, "SAME BODY.");
      const a = createProposal(storage.stashDir, { ref, source: "distill", payload: { content } });
      if (isProposalSkipped(a)) throw new Error("unexpected skip on first create");

      const b = createProposal(storage.stashDir, { ref, source: "distill", payload: { content } });
      expect(isProposalSkipped(b)).toBe(true);
      if (!isProposalSkipped(b)) throw new Error("expected skip");
      expect(b.reason).toBe("content_hash_match");
      expect(b.existingProposalId).toBe(a.id);
    } finally {
      storage.cleanup();
    }
  });

  test("content_hash_match vs the most-recently-rejected proposal", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(CREATE_HASH_MATCH_REJECTED_NAME);
      const content = lessonContent(CREATE_HASH_MATCH_REJECTED_NAME, "REJECTED BODY.");
      const a = createProposal(storage.stashDir, { ref, source: "distill", payload: { content } });
      if (isProposalSkipped(a)) throw new Error("unexpected skip on first create");
      archiveProposal(storage.stashDir, a.id, "rejected", "not useful");

      const b = createProposal(storage.stashDir, { ref, source: "distill", payload: { content } });
      expect(isProposalSkipped(b)).toBe(true);
      if (!isProposalSkipped(b)) throw new Error("expected skip");
      expect(b.reason).toBe("content_hash_match");
      expect(b.existingProposalId).toBe(a.id);
    } finally {
      storage.cleanup();
    }
  });

  test("cooldown: different content after a recent rejection is skipped until the window elapses", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(CREATE_COOLDOWN_NAME);
      const t0 = Date.parse("2026-01-01T00:00:00.000Z");
      const a = createProposal(
        storage.stashDir,
        { ref, source: "distill", payload: { content: lessonContent(CREATE_COOLDOWN_NAME, "FIRST BODY.") } },
        { now: () => t0 },
      );
      if (isProposalSkipped(a)) throw new Error("unexpected skip on first create");
      archiveProposal(storage.stashDir, a.id, "rejected", "not useful", { now: () => t0 });

      // 1 day later — well inside the 30-day "distill" cooldown window.
      const oneDayLater = t0 + 24 * 60 * 60 * 1000;
      const b = createProposal(
        storage.stashDir,
        { ref, source: "distill", payload: { content: lessonContent(CREATE_COOLDOWN_NAME, "DIFFERENT BODY.") } },
        { now: () => oneDayLater },
      );
      expect(isProposalSkipped(b)).toBe(true);
      if (!isProposalSkipped(b)) throw new Error("expected skip");
      expect(b.reason).toBe("cooldown");
      expect(b.existingProposalId).toBe(a.id);
    } finally {
      storage.cleanup();
    }
  });

  test("force bypass: force:true creates a new pending proposal despite duplicate/cooldown guards", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = lessonRef(CREATE_FORCE_BYPASS_NAME);
      const content = lessonContent(CREATE_FORCE_BYPASS_NAME, "FIRST BODY.");
      const a = createProposal(storage.stashDir, { ref, source: "distill", payload: { content } });
      if (isProposalSkipped(a)) throw new Error("unexpected skip on first create");

      // Same content, same ref+source, no force -> would ordinarily skip
      // (content_hash_match against the still-pending `a`) -- force bypasses it.
      const b = createProposal(storage.stashDir, { ref, source: "distill", force: true, payload: { content } });
      expect(isProposalSkipped(b)).toBe(false);
      if (isProposalSkipped(b)) throw new Error("expected a real proposal");
      const created = b as Proposal;
      expect(created.id).not.toBe(a.id);
      expect(created.status).toBe("pending");
    } finally {
      storage.cleanup();
    }
  });
});

// ── Golden fixture capture ──────────────────────────────────────────────────
//
// Re-runs a representative slice of the scenarios above (fresh sandboxes) to
// assemble the committed golden fixture, kept independent of the assertion
// tests so capture never depends on bun:test's within-file execution order.
describe("golden fixture: serialize proposal transaction outcomes (WI-03, R3)", () => {
  test("golden fixture: proposal-txn.json", async () => {
    // -- accept: new-asset --
    const newAssetOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(ACCEPT_NEW_ASSET_NAME);
        const content = lessonContent(ACCEPT_NEW_ASSET_NAME, "NEW ASSET BODY.");
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
        const accepted = getProposal(storage.stashDir, created.id);
        return {
          fileTree: fileTreeManifest(storage.stashDir),
          status: accepted.status,
          acceptedContentHashPresent: accepted.acceptedContentHash !== undefined,
          backupContentPresent: accepted.backupContent !== undefined,
          promotedEvent: eventOutcome("promoted", ref),
          journalDirCleaned: transactionsRootIsClean(storage.dataDir),
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- accept: overwrite-existing --
    const overwriteOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(ACCEPT_OVERWRITE_NAME);
        const original = lessonContent(ACCEPT_OVERWRITE_NAME, "ORIGINAL BODY.");
        const proposed = lessonContent(ACCEPT_OVERWRITE_NAME, "OVERWRITE BODY.");
        writeAsset(storage.stashDir, ACCEPT_OVERWRITE_NAME, original);
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content: proposed },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
        const accepted = getProposal(storage.stashDir, created.id);
        return {
          fileTree: fileTreeManifest(storage.stashDir),
          status: accepted.status,
          acceptedContentHashPresent: accepted.acceptedContentHash !== undefined,
          backupContentPresent: accepted.backupContent !== undefined,
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- accept: idempotent re-accept --
    const idempotentOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(ACCEPT_IDEMPOTENT_NAME);
        const content = lessonContent(ACCEPT_IDEMPOTENT_NAME, "IDEMPOTENT BODY.");
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        const first = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
        const treeAfterFirst = fileTreeManifest(storage.stashDir);
        const second = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
        return {
          treeUnchanged: JSON.stringify(fileTreeManifest(storage.stashDir)) === JSON.stringify(treeAfterFirst),
          sameAssetPath: second.assetPath === first.assetPath,
          sameAcceptedContentHash: second.proposal.acceptedContentHash === first.proposal.acceptedContentHash,
          promotedEvent: eventOutcome("promoted", ref),
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- accept: target-mutated-during-displace abort (see file-header DEVIATION) --
    const targetMutatedOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(ACCEPT_TARGET_MUTATED_NAME);
        const original = lessonContent(ACCEPT_TARGET_MUTATED_NAME, "ORIGINAL BODY.");
        const proposed = lessonContent(ACCEPT_TARGET_MUTATED_NAME, "PROPOSED BODY.");
        const assetPath = writeAsset(storage.stashDir, ACCEPT_TARGET_MUTATED_NAME, original);
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content: proposed },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");

        const mutatedContent = "EXTERNALLY MUTATED CONTENT (not proposal content, not original)\n";
        const originalRename = fs.renameSync;
        let triggered = false;
        const spy = spyOn(fs, "renameSync").mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          const result = originalRename(oldPath, newPath);
          if (!triggered && String(oldPath).endsWith("journal.json.tmp") && String(newPath).endsWith("journal.json")) {
            const journal = JSON.parse(fs.readFileSync(String(newPath), "utf8")) as { phase?: string };
            if (journal.phase === "prepared") {
              triggered = true;
              fs.writeFileSync(assetPath, mutatedContent, "utf8");
            }
          }
          return result;
        }) as typeof fs.renameSync);

        let abortErrorPrefix: string | undefined;
        try {
          await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
        } catch (err) {
          abortErrorPrefix =
            err instanceof Error ? err.message.slice(0, "Cannot roll back proposal transaction:".length) : undefined;
        } finally {
          spy.mockRestore();
        }

        return {
          triggered,
          abortErrorPrefix,
          finalContentIsMutatorContent: fs.readFileSync(assetPath, "utf8") === mutatedContent,
          finalContentIsByteIdenticalToOriginal: fs.readFileSync(assetPath, "utf8") === original,
          proposalStatus: getProposal(storage.stashDir, created.id).status,
          transactionDirOrphaned: !transactionsRootIsClean(storage.dataDir),
          strayPublishFileCount: fs
            .readdirSync(path.dirname(assetPath))
            .filter((f) => f.startsWith(".akm-proposal-") && f.endsWith(".publish")).length,
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- revert: success --
    const revertSuccessOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(REVERT_SUCCESS_NAME);
        const original = lessonContent(REVERT_SUCCESS_NAME, "ORIGINAL BODY.");
        const proposed = lessonContent(REVERT_SUCCESS_NAME, "ACCEPTED BODY.");
        const assetPath = writeAsset(storage.stashDir, REVERT_SUCCESS_NAME, original);
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content: proposed },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        await akmProposalAccept({ stashDir: storage.stashDir, id: created.id });
        await akmProposalRevert({ stashDir: storage.stashDir, id: created.id });
        return {
          restoredByteIdentical: fs.readFileSync(assetPath, "utf8") === original,
          status: getProposal(storage.stashDir, created.id).status,
          revertedEvent: eventOutcome("proposal_reverted", ref),
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- revert: refuse-clobber --
    const revertRefuseClobberOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(REVERT_REFUSE_CLOBBER_NAME);
        const original = lessonContent(REVERT_REFUSE_CLOBBER_NAME, "ORIGINAL BODY.");
        const aContent = lessonContent(REVERT_REFUSE_CLOBBER_NAME, "PROPOSAL A BODY.");
        const bContent = lessonContent(REVERT_REFUSE_CLOBBER_NAME, "PROPOSAL B BODY.");
        const assetPath = writeAsset(storage.stashDir, REVERT_REFUSE_CLOBBER_NAME, original);
        const proposalA = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content: aContent },
        });
        if (isProposalSkipped(proposalA)) throw new Error("unexpected skip");
        await akmProposalAccept({ stashDir: storage.stashDir, id: proposalA.id });
        const proposalB = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content: bContent },
        });
        if (isProposalSkipped(proposalB)) throw new Error("unexpected skip");
        await akmProposalAccept({ stashDir: storage.stashDir, id: proposalB.id });

        let errorCode: string | undefined;
        try {
          await akmProposalRevert({ stashDir: storage.stashDir, id: proposalA.id });
        } catch (err) {
          errorCode = err instanceof UsageError ? err.code : undefined;
        }
        return {
          errorCode,
          bContentSurvives: fs.readFileSync(assetPath, "utf8") === bContent,
          proposalAStatus: getProposal(storage.stashDir, proposalA.id).status,
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- reject: success --
    const rejectSuccessOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(REJECT_SUCCESS_NAME);
        const content = lessonContent(REJECT_SUCCESS_NAME, "REJECT ME.");
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "not useful" });
        return {
          status: getProposal(storage.stashDir, created.id).status,
          rejectedEvent: eventOutcome("rejected", ref),
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- reject: non-pending --
    const rejectNonPendingOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(REJECT_NON_PENDING_NAME);
        const content = lessonContent(REJECT_NON_PENDING_NAME, "ALREADY REJECTED.");
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "first" });
        let errorCode: string | undefined;
        try {
          await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "second" });
        } catch (err) {
          errorCode = err instanceof UsageError ? err.code : undefined;
        }
        return { errorCode };
      } finally {
        storage.cleanup();
      }
    })();

    // -- reject: concurrent edit succeeds (no before-hash) --
    const rejectConcurrentEditOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const ref = lessonRef(REJECT_CONCURRENT_EDIT_NAME);
        const original = lessonContent(REJECT_CONCURRENT_EDIT_NAME, "ORIGINAL BODY.");
        const proposed = lessonContent(REJECT_CONCURRENT_EDIT_NAME, "PROPOSED BODY.");
        const assetPath = writeAsset(storage.stashDir, REJECT_CONCURRENT_EDIT_NAME, original);
        const created = createProposal(storage.stashDir, {
          ref,
          source: "distill",
          force: true,
          payload: { content: proposed },
        });
        if (isProposalSkipped(created)) throw new Error("unexpected skip");
        fs.writeFileSync(assetPath, "CONCURRENTLY EDITED\n", "utf8");
        const result = await akmProposalReject({ stashDir: storage.stashDir, id: created.id, reason: "concurrent" });
        return {
          ok: result.ok,
          status: getProposal(storage.stashDir, created.id).status,
          concurrentEditUntouched: fs.readFileSync(assetPath, "utf8") === "CONCURRENTLY EDITED\n",
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- createProposal skip-record shapes --
    const skipShapes = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const dupRef = lessonRef(CREATE_DUPLICATE_PENDING_NAME);
        const dupA = createProposal(storage.stashDir, {
          ref: dupRef,
          source: "distill",
          payload: { content: lessonContent(CREATE_DUPLICATE_PENDING_NAME, "FIRST BODY.") },
        });
        if (isProposalSkipped(dupA)) throw new Error("unexpected skip");
        const dupB = createProposal(storage.stashDir, {
          ref: dupRef,
          source: "distill",
          payload: { content: lessonContent(CREATE_DUPLICATE_PENDING_NAME, "SECOND BODY.") },
        });

        const hashPendingRef = lessonRef(CREATE_HASH_MATCH_PENDING_NAME);
        const hashPendingContent = lessonContent(CREATE_HASH_MATCH_PENDING_NAME, "SAME BODY.");
        const hashPendingA = createProposal(storage.stashDir, {
          ref: hashPendingRef,
          source: "distill",
          payload: { content: hashPendingContent },
        });
        if (isProposalSkipped(hashPendingA)) throw new Error("unexpected skip");
        const hashPendingB = createProposal(storage.stashDir, {
          ref: hashPendingRef,
          source: "distill",
          payload: { content: hashPendingContent },
        });

        const hashRejectedRef = lessonRef(CREATE_HASH_MATCH_REJECTED_NAME);
        const hashRejectedContent = lessonContent(CREATE_HASH_MATCH_REJECTED_NAME, "REJECTED BODY.");
        const hashRejectedA = createProposal(storage.stashDir, {
          ref: hashRejectedRef,
          source: "distill",
          payload: { content: hashRejectedContent },
        });
        if (isProposalSkipped(hashRejectedA)) throw new Error("unexpected skip");
        archiveProposal(storage.stashDir, hashRejectedA.id, "rejected", "not useful");
        const hashRejectedB = createProposal(storage.stashDir, {
          ref: hashRejectedRef,
          source: "distill",
          payload: { content: hashRejectedContent },
        });

        const cooldownRef = lessonRef(CREATE_COOLDOWN_NAME);
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const cooldownA = createProposal(
          storage.stashDir,
          {
            ref: cooldownRef,
            source: "distill",
            payload: { content: lessonContent(CREATE_COOLDOWN_NAME, "FIRST BODY.") },
          },
          { now: () => t0 },
        );
        if (isProposalSkipped(cooldownA)) throw new Error("unexpected skip");
        archiveProposal(storage.stashDir, cooldownA.id, "rejected", "not useful", { now: () => t0 });
        const cooldownB = createProposal(
          storage.stashDir,
          {
            ref: cooldownRef,
            source: "distill",
            payload: { content: lessonContent(CREATE_COOLDOWN_NAME, "DIFFERENT BODY.") },
          },
          { now: () => t0 + 24 * 60 * 60 * 1000 },
        );

        const forceRef = lessonRef(CREATE_FORCE_BYPASS_NAME);
        const forceContent = lessonContent(CREATE_FORCE_BYPASS_NAME, "FIRST BODY.");
        const forceA = createProposal(storage.stashDir, {
          ref: forceRef,
          source: "distill",
          payload: { content: forceContent },
        });
        if (isProposalSkipped(forceA)) throw new Error("unexpected skip");
        const forceB = createProposal(storage.stashDir, {
          ref: forceRef,
          source: "distill",
          force: true,
          payload: { content: forceContent },
        });

        const skipKeySet = (r: ReturnType<typeof createProposal>) =>
          isProposalSkipped(r) ? Object.keys(r).sort() : undefined;

        return {
          duplicatePending: {
            skipped: isProposalSkipped(dupB),
            reason: isProposalSkipped(dupB) ? dupB.reason : undefined,
            existingProposalIdMatches: isProposalSkipped(dupB) ? dupB.existingProposalId === dupA.id : undefined,
            keySet: skipKeySet(dupB),
          },
          contentHashMatchVsPending: {
            skipped: isProposalSkipped(hashPendingB),
            reason: isProposalSkipped(hashPendingB) ? hashPendingB.reason : undefined,
            existingProposalIdMatches: isProposalSkipped(hashPendingB)
              ? hashPendingB.existingProposalId === hashPendingA.id
              : undefined,
            keySet: skipKeySet(hashPendingB),
          },
          contentHashMatchVsRejected: {
            skipped: isProposalSkipped(hashRejectedB),
            reason: isProposalSkipped(hashRejectedB) ? hashRejectedB.reason : undefined,
            existingProposalIdMatches: isProposalSkipped(hashRejectedB)
              ? hashRejectedB.existingProposalId === hashRejectedA.id
              : undefined,
            keySet: skipKeySet(hashRejectedB),
          },
          cooldown: {
            skipped: isProposalSkipped(cooldownB),
            reason: isProposalSkipped(cooldownB) ? cooldownB.reason : undefined,
            existingProposalIdMatches: isProposalSkipped(cooldownB)
              ? cooldownB.existingProposalId === cooldownA.id
              : undefined,
            keySet: skipKeySet(cooldownB),
          },
          forceBypass: {
            skipped: isProposalSkipped(forceB),
            isNewProposal: !isProposalSkipped(forceB) && forceB.id !== forceA.id,
            status: !isProposalSkipped(forceB) ? forceB.status : undefined,
          },
        };
      } finally {
        storage.cleanup();
      }
    })();

    expectGolden(GOLDEN_PATH, {
      scenario: "proposal accept/revert/reject transaction round-trip outcomes (WI-03, R3)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "No journal bytes/paths asserted -- journal phase sequences are informational only (brief S3.2 rule 4); " +
          "Chunk 6 replaces the journal engines. Only observable outcomes (file trees, DB status, exactly-once " +
          "events, abort error prefixes, recovery end-states) are the preserved contract.",
        "Reject engine has NO before-hash: rejectConcurrentEdit pins that a concurrently-edited target does not " +
          "block a reject (repository.ts:1405-1415, DB-only journal, no paths/hashes). A unified FileChange " +
          "transaction must not invent a hash check here.",
        "DEVIATION from the brief's testsFirst description: the target-mutated-during-displace abort's REAL " +
          "surfaced error is 'Cannot roll back proposal transaction: <path> diverged.', not 'Proposal target " +
          "changed while its backup was being acquired.' (which IS thrown internally at repository.ts:1608 but " +
          "is always shadowed by rollbackPreparedProposalTransaction's own divergence check re-firing on the " +
          "same persisted mutation). The asset is left holding the mutator's content (not byte-identical " +
          "restored) and the transaction dir + a stray .publish file are orphaned. See this file's header " +
          'comment for the full trace. Captured as-is per brief S1 ("capture, not aspiration").',
      ],
      accept: {
        newAsset: newAssetOutcome,
        overwrite: overwriteOutcome,
        idempotentReaccept: idempotentOutcome,
        targetMutatedAbort: targetMutatedOutcome,
      },
      revert: {
        success: revertSuccessOutcome,
        refuseClobber: revertRefuseClobberOutcome,
      },
      reject: {
        success: rejectSuccessOutcome,
        nonPending: rejectNonPendingOutcome,
        concurrentEditSucceeds: rejectConcurrentEditOutcome,
      },
    });

    // Skip shapes live in their own asset (re-baseline @6): WI-6.4's
    // fingerprint scheme legitimately changes these observable shapes, so the
    // surface-owner rule re-designated exactly this section out of the frozen
    // outcome oracle above BEFORE that change lands.
    expectGolden(SKIP_SHAPES_GOLDEN_PATH, {
      scenario:
        "createProposal dedup/cooldown/force skip-record shapes (split from proposal-txn.json, WI-6.4 surface-owner re-designation)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "Split out of the frozen journal/proposal-txn.json on 2026-07-16: Chunk 6's WI-6.4 replaces the " +
          "dedup/cooldown guard with §23.6 input fingerprints (+ engine/model-id term, rejection backoff retained), " +
          "which legitimately changes these observable skip shapes. Per the registry's surface-owner rule the " +
          "skip-shape section is re-designated re-baseline @6 BEFORE that change lands; the accept/revert/reject " +
          "outcome scenarios remain frozen in proposal-txn.json — they are designed to survive the engine swap.",
      ],
      createProposalSkipShapes: skipShapes,
    });
  });
});
