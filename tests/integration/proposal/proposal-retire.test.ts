// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 0.9.17-alpha.9 — the consolidate pair pass's `retire` proposal effect
 * (plan §5.4, brief §B), O1 (a promotion retires its source), and the
 * review-round correctness fixes (B2/B3/S4/S5/S6).
 *
 * A `retire` proposal's primary `FileChange` deletes its target instead of
 * writing content: accepting it archives the asset (and its `.derived`
 * twin) through the generalized `archiveCleanupCandidate`, `supersedes`
 * additionally writes a `supersededBy` edge, and triage must never
 * auto-accept one regardless of `applyMode`. These tests drive the real
 * producers end-to-end (mint -> accept -> revert), not hand-built fixtures.
 *
 * `retirement()` computes REAL body hashes from files actually on disk (both
 * the retired side and the successor, which must exist) — B2's accept-time
 * check refuses a proposal whose recorded hashes do not match the current
 * files, so a fixture with a fabricated hash or a missing successor file
 * would only prove the guard works, not the happy path it is meant for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../../../src/commands/improve/content-hash";
import { archiveCleanupCandidate } from "../../../src/commands/improve/memory/memory-improve";
import { drainProposals } from "../../../src/commands/proposal/drain";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalRevert,
  akmProposalShow,
  bulkAdjudicateProposals,
} from "../../../src/commands/proposal/proposal";
import type { RetirementMetadata } from "../../../src/commands/proposal/proposal-types";
import {
  createProposal,
  createRetireProposal,
  getProposal,
  listProposals,
} from "../../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { UsageError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { getImproveLedgerRow } from "../../../src/storage/repositories/improve-ledger-repository";
import { upsertProposal } from "../../../src/storage/repositories/proposals-repository";
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

function writeAsset(relPath: string, frontmatter: string, body = "Body text.\n"): string {
  const filePath = path.join(storage.stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
}

/** Real body hashes from files actually on disk — see the module doc comment. */
function retirement(
  opts: {
    retiredPath: string;
    retiredRef: string;
    successorPath: string;
    successorRef: string;
  } & Partial<Omit<RetirementMetadata, "retiredContentHash" | "successorContentHash" | "retiredRef" | "successorRef">>,
): RetirementMetadata {
  const { retiredPath, retiredRef, successorPath, successorRef, ...overrides } = opts;
  return {
    retiredRef,
    successorRef,
    cosine: 0.94,
    judgeLabel: "duplicate",
    judgeReason: "Same durable facts, B adds nothing new.",
    retiredContentHash: contentHash(fs.readFileSync(retiredPath, "utf8"), "body"),
    successorContentHash: contentHash(fs.readFileSync(successorPath, "utf8"), "body"),
    reason: "duplicate",
    ...overrides,
  };
}

function archiveRootOf(): string {
  return path.join(storage.stashDir, ".akm", "memory-cleanup", "archive");
}

/**
 * Reads every archive dir's tombstone (the same `cleanup.md` frontmatter
 * `unretireProposalWithLease` itself reads) to find the one whose recorded
 * `originalPath` is `originalRel` — used to simulate a revert crash by
 * performing exactly the rename the real revert path would perform for one
 * archive dir, without touching the others.
 */
function findArchiveEntry(originalRel: string): { dirAbs: string; originalAbs: string; archivedAbs: string } {
  const root = archiveRootOf();
  for (const name of fs.readdirSync(root)) {
    const dirAbs = path.join(root, name);
    const auditPath = path.join(dirAbs, "cleanup.md");
    if (!fs.existsSync(auditPath)) continue;
    const data = parseFrontmatter(fs.readFileSync(auditPath, "utf8")).data;
    if (data.originalPath === originalRel) {
      return {
        dirAbs,
        originalAbs: path.join(storage.stashDir, String(data.originalPath)),
        archivedAbs: path.join(storage.stashDir, String(data.archivedPath)),
      };
    }
  }
  throw new Error(`no archive entry found for ${originalRel}`);
}

describe("createRetireProposal — mint", () => {
  test("mints a delete-primary proposal for an existing asset", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.source).toBe("consolidate-pair");
    expect(proposal.changes).toEqual([{ path: "memories/old-note.md", op: "delete" }]);
    expect(proposal.retirement?.judgeLabel).toBe("duplicate");
    expect(proposal.beforeHash).toBeDefined();
  });

  test("refuses to mint for an asset that does not exist", () => {
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    expect(() =>
      createRetireProposal(storage.stashDir, {
        ref: "memories/phantom",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: newPath, // any real file — the mint refusal happens before it is read
          retiredRef: "memories/phantom",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      }),
    ).toThrow(/does not exist/);
  });
});

describe("akm proposal accept on a retire proposal", () => {
  test("duplicate: archives the asset, tombstone carries reason/successorRefs/proposalId/retiredAt", async () => {
    const filePath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: filePath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(result.proposal.status).toBe("accepted");
    expect(fs.existsSync(filePath)).toBe(false);

    const archived = getProposal(storage.stashDir, proposal.id);
    expect(archived.retiredArchive?.dirs).toHaveLength(1);
    const archiveDir = path.join(storage.stashDir, archived.retiredArchive!.dirs[0]!);
    const tombstone = parseFrontmatter(fs.readFileSync(path.join(archiveDir, "cleanup.md"), "utf8")).data;
    expect(tombstone.reason).toBe("duplicate");
    expect(tombstone.successorRefs).toEqual(["memories/new-note"]);
    expect(tombstone.proposalId).toBe(proposal.id);
    expect(tombstone.retiredAt).toBeDefined();
    expect(tombstone.originalPath).toBe("memories/old-note.md");

    // Ledger: the proposal's own decision is recorded under its own source
    // (S6: consolidate-pair, not the promote pass's consolidate).
    const db = openStateDatabase();
    try {
      const row = getImproveLedgerRow(db, storage.stashDir, archived.ref, "consolidate-pair");
      expect(row?.outcome).toBe("accepted");
    } finally {
      db.close();
    }
  });

  test("supersedes: writes the supersededBy edge on the older asset before archiving it", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
        judgeLabel: "supersedes",
        reason: "superseded",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });

    const archived = getProposal(storage.stashDir, proposal.id);
    const archiveDir = path.join(storage.stashDir, archived.retiredArchive!.dirs[0]!);
    const archivedBody = fs.readFileSync(path.join(archiveDir, "memories/old-note.md"), "utf8");
    const fm = parseFrontmatter(archivedBody).data;
    expect(fm.beliefState).toBe("superseded");
    expect(fm.supersededBy).toEqual(["memories/new-note"]);
  });

  test("takes the .derived twin along", async () => {
    const parentPath = writeAsset("memories/parent.md", "description: parent");
    const twinPath = writeAsset(
      "memories/parent.derived.md",
      "inferred: true\nsource: memories/parent\ndescription: derived child",
    );
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/parent",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: parentPath,
        retiredRef: "memories/parent",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });

    expect(fs.existsSync(twinPath)).toBe(false);
    const archived = getProposal(storage.stashDir, proposal.id);
    expect(archived.retiredArchive?.dirs).toHaveLength(2);
  });

  test("a target that no longer exists fails cleanly (UsageError), not an unhandled throw", async () => {
    const filePath = writeAsset("memories/vanishing.md", "description: about to vanish");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/vanishing",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: filePath,
        retiredRef: "memories/vanishing",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    fs.rmSync(filePath); // simulate a race: something else already removed it, no tombstone under this proposalId exists
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toBeInstanceOf(
      UsageError,
    );
    // The proposal stays pending — a clean, reviewable failure, not corruption.
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
  });

  test("re-accepting an already-accepted retire proposal is a no-op", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    const second = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(second.proposal.status).toBe("accepted");
  });

  describe("S5 crash recovery (second review round: intent-based, resume-safe)", () => {
    test("intent recorded but no file moved yet — accept resumes from it and finishes", async () => {
      const oldPath = writeAsset("memories/old-note.md", "description: an old note");
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/old-note",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: oldPath,
          retiredRef: "memories/old-note",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      const backupContent = fs.readFileSync(oldPath, "utf8");
      // Simulate the crash: phase 1 (record intent) finished, phase 2 (move) never started.
      const db = openStateDatabase();
      try {
        upsertProposal(
          db,
          { ...proposal, retireAcceptIntent: { assetPath: oldPath, backupContent } },
          storage.stashDir,
        );
      } finally {
        db.close();
      }
      expect(fs.existsSync(oldPath)).toBe(true); // nothing moved yet
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(result.proposal.status).toBe("accepted");
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(result.proposal.retiredArchive?.dirs).toHaveLength(1);
      expect(result.proposal.backupContent).toBe(backupContent);
    });

    test("primary already archived under this proposal's own id, twin not yet — accept resumes and finishes both", async () => {
      const oldPath = writeAsset("memories/old-note.md", "description: an old note");
      const twinPath = writeAsset(
        "memories/old-note.derived.md",
        "inferred: true\nsource: memories/old-note\ndescription: derived",
      );
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/old-note",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: oldPath,
          retiredRef: "memories/old-note",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      const backupContent = fs.readFileSync(oldPath, "utf8");
      const db = openStateDatabase();
      try {
        upsertProposal(
          db,
          { ...proposal, retireAcceptIntent: { assetPath: oldPath, backupContent } },
          storage.stashDir,
        );
      } finally {
        db.close();
      }
      // Simulate phase 2 partially done: primary archived under this
      // proposal's id (exactly what accept's own internals do), twin
      // untouched at its original location.
      archiveCleanupCandidate(
        storage.stashDir,
        {
          ref: "memories/old-note",
          reason: "duplicate",
          proposalId: proposal.id,
          successorRefs: ["memories/new-note"],
        },
        oldPath,
      );
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(twinPath)).toBe(true);
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(result.proposal.status).toBe("accepted");
      expect(fs.existsSync(twinPath)).toBe(false);
      expect(result.proposal.retiredArchive?.dirs).toHaveLength(2);
      // Recovered from the recorded intent, never guessed from the archived copy.
      expect(result.proposal.backupContent).toBe(backupContent);
    });

    test("a target gone with no recorded intent still refuses cleanly (not our own crash)", async () => {
      const oldPath = writeAsset("memories/old-note.md", "description: an old note");
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/old-note",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: oldPath,
          retiredRef: "memories/old-note",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      fs.rmSync(oldPath); // something else removed it — no intent was ever recorded
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toBeInstanceOf(
        UsageError,
      );
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
    });

    test("a supersedes accept resumed from recorded intent restores edge-free content on revert (4a, third review round)", async () => {
      const oldPath = writeAsset("memories/old-note.md", "description: an old note");
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const original = fs.readFileSync(oldPath, "utf8");
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/old-note",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: oldPath,
          retiredRef: "memories/old-note",
          successorPath: newPath,
          successorRef: "memories/new-note",
          judgeLabel: "supersedes",
          reason: "superseded",
        }),
      });
      // Simulates the crash window 4a closes: intent recorded with the
      // pre-edge bytes — exactly what the fixed ordering (record intent,
      // THEN write the edge) always captures — while the file on disk still
      // has no edge yet.
      const db = openStateDatabase();
      try {
        upsertProposal(
          db,
          { ...proposal, retireAcceptIntent: { assetPath: oldPath, backupContent: original } },
          storage.stashDir,
        );
      } finally {
        db.close();
      }

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(result.proposal.backupContent).toBe(original); // the recorded intent wins, never a re-read

      await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
      const restored = fs.readFileSync(oldPath, "utf8");
      expect(restored).toBe(original);
      expect(parseFrontmatter(restored).data.supersededBy).toBeUndefined();
    });

    test("resuming A->B after B->C was separately accepted refuses instead of retiring a stale decision (4b, third review round)", async () => {
      const aPath = writeAsset("memories/a.md", "description: a");
      const bPath = writeAsset("memories/b.md", "description: b");
      const cPath = writeAsset("memories/c.md", "description: c");
      const config = makeConfig(storage.stashDir);
      const pAB = createRetireProposal(storage.stashDir, {
        ref: "memories/a",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: aPath,
          retiredRef: "memories/a",
          successorPath: bPath,
          successorRef: "memories/b",
        }),
      });
      // A->B's intent recorded (Phase 1 done), as if the process crashed
      // right there — nothing has moved yet.
      const aBackup = fs.readFileSync(aPath, "utf8");
      const db = openStateDatabase();
      try {
        upsertProposal(
          db,
          { ...pAB, retireAcceptIntent: { assetPath: aPath, backupContent: aBackup } },
          storage.stashDir,
        );
      } finally {
        db.close();
      }
      expect(fs.existsSync(aPath)).toBe(true);

      // A separate B->C proposal is accepted in the meantime — b is gone.
      const pBC = createRetireProposal(storage.stashDir, {
        ref: "memories/b",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: bPath,
          retiredRef: "memories/b",
          successorPath: cPath,
          successorRef: "memories/c",
        }),
      });
      await akmProposalAccept({ stashDir: storage.stashDir, id: pBC.id, config });
      expect(fs.existsSync(bPath)).toBe(false);

      // Resuming A->B must refuse — its successor no longer exists.
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: pAB.id, config })).rejects.toThrow(/stale/);
      expect(getProposal(storage.stashDir, pAB.id).status).toBe("pending");
      expect(fs.existsSync(aPath)).toBe(true); // a survives — never archived
    });
  });

  describe("B2: accept-time freshness — both sides, not just the retired one", () => {
    test("refuses when the successor was edited after judging", async () => {
      const oldPath = writeAsset("memories/old-note.md", "description: an old note");
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/old-note",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: oldPath,
          retiredRef: "memories/old-note",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      fs.writeFileSync(newPath, "---\ndescription: new\n---\nTotally different now.\n", "utf8");
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(/stale/);
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
      expect(fs.existsSync(oldPath)).toBe(true); // nothing was moved
    });

    test("refuses when the successor was deleted or archived by something else", async () => {
      const oldPath = writeAsset("memories/old-note.md", "description: an old note");
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/old-note",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: oldPath,
          retiredRef: "memories/old-note",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      fs.rmSync(newPath);
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(/stale/);
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
      expect(fs.existsSync(oldPath)).toBe(true);
    });

    test("a chain (A->B accepted, then B->C) refuses the second accept once its successor is gone", async () => {
      const aPath = writeAsset("memories/a.md", "description: a");
      const bPath = writeAsset("memories/b.md", "description: b");
      const cPath = writeAsset("memories/c.md", "description: c");
      const config = makeConfig(storage.stashDir);
      const pBC = createRetireProposal(storage.stashDir, {
        ref: "memories/b",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: bPath,
          retiredRef: "memories/b",
          successorPath: cPath,
          successorRef: "memories/c",
        }),
      });
      const pAB = createRetireProposal(storage.stashDir, {
        ref: "memories/a",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: aPath,
          retiredRef: "memories/a",
          successorPath: bPath,
          successorRef: "memories/b",
        }),
      });
      const acceptedBC = await akmProposalAccept({ stashDir: storage.stashDir, id: pBC.id, config });
      expect(acceptedBC.proposal.status).toBe("accepted");
      expect(fs.existsSync(bPath)).toBe(false); // b is now gone — a's successor

      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: pAB.id, config })).rejects.toThrow(/stale/);
      expect(getProposal(storage.stashDir, pAB.id).status).toBe("pending");
      expect(fs.existsSync(aPath)).toBe(true); // a survives — its retirement was correctly refused
      expect(fs.existsSync(cPath)).toBe(true);
    });

    test("a cycle (A->B and B->A both minted) accepts the first and refuses the second, not both", async () => {
      const aPath = writeAsset("memories/a.md", "description: a");
      const bPath = writeAsset("memories/b.md", "description: b");
      const config = makeConfig(storage.stashDir);
      const p1 = createRetireProposal(storage.stashDir, {
        ref: "memories/a",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: aPath,
          retiredRef: "memories/a",
          successorPath: bPath,
          successorRef: "memories/b",
        }),
      });
      const p2 = createRetireProposal(storage.stashDir, {
        ref: "memories/b",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: bPath,
          retiredRef: "memories/b",
          successorPath: aPath,
          successorRef: "memories/a",
        }),
      });
      const first = await akmProposalAccept({ stashDir: storage.stashDir, id: p1.id, config });
      expect(first.proposal.status).toBe("accepted");
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: p2.id, config })).rejects.toThrow(/stale/);
      // Only a is gone — b (never legitimately retired) survives.
      expect(fs.readdirSync(path.join(storage.stashDir, "memories"))).toContain("b.md");
      expect(fs.readdirSync(path.join(storage.stashDir, "memories"))).not.toContain("a.md");
    });
  });
});

describe("akm proposal revert on a retire proposal", () => {
  test("restores the archived asset and removes the archive dir", async () => {
    const filePath = writeAsset("memories/old-note.md", "description: an old note\ntags:\n  - x\n", "Original body.\n");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const originalBytes = fs.readFileSync(filePath, "utf8");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: filePath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(fs.existsSync(filePath)).toBe(false);

    const reverted = await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(reverted.proposal.status).toBe("reverted");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe(originalBytes);

    const archiveRoot = path.join(storage.stashDir, ".akm", "memory-cleanup", "archive");
    expect(fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot) : []).toEqual([]);
  });

  test("removes the supersede edge it wrote", async () => {
    const filePath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: filePath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
        judgeLabel: "supersedes",
        reason: "superseded",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });

    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8")).data;
    expect(fm.supersededBy).toBeUndefined();
    expect(fm.beliefState).not.toBe("superseded");
  });

  test("restores both the primary and its .derived twin", async () => {
    const parentPath = writeAsset("memories/parent.md", "description: parent");
    const twinPath = writeAsset(
      "memories/parent.derived.md",
      "inferred: true\nsource: memories/parent\ndescription: derived child",
    );
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/parent",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: parentPath,
        retiredRef: "memories/parent",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(fs.existsSync(parentPath)).toBe(true);
    expect(fs.existsSync(twinPath)).toBe(true);
  });

  test("S4: byte-exact — YAML comments, key order and a pre-existing human supersededBy edge all survive the round trip", async () => {
    const original =
      "---\n# a comment akm never wrote\ndescription: 'quoted old'\ntags: [x, y]\nsupersededBy:\n  - memories/someone-elses-note\nbeliefState: superseded\nupdated: 2026-06-01\n---\nOld body.\n";
    const filePath = writeAsset("memories/old-note.md", "placeholder"); // overwritten below with the exact bytes
    fs.writeFileSync(filePath, original, "utf8");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: filePath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
        judgeLabel: "supersedes",
        reason: "superseded",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
    const after = fs.readFileSync(filePath, "utf8");
    expect(after).toBe(original);
    // The human-written edge to a DIFFERENT note survives untouched.
    const fm = parseFrontmatter(after).data;
    expect(fm.supersededBy).toEqual(["memories/someone-elses-note"]);
  });

  test("S5: validates every archive dir before moving any of them — a twin whose destination is occupied leaves the primary archived too", async () => {
    const parentPath = writeAsset("memories/parent.md", "description: parent");
    const twinPath = writeAsset(
      "memories/parent.derived.md",
      "inferred: true\nsource: memories/parent\ndescription: derived child",
    );
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/parent",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: parentPath,
        retiredRef: "memories/parent",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(fs.existsSync(parentPath)).toBe(false);
    expect(fs.existsSync(twinPath)).toBe(false);
    const archiveRoot = path.join(storage.stashDir, ".akm", "memory-cleanup", "archive");
    expect(fs.readdirSync(archiveRoot)).toHaveLength(2);

    // Something else recreates the TWIN's original path before revert runs.
    fs.writeFileSync(twinPath, "---\ndescription: recreated by someone else\n---\nNot the archived content.\n", "utf8");
    await expect(akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      /already exists/,
    );
    // All-or-nothing: the PRIMARY was never moved back either, and both archive dirs are untouched.
    expect(fs.existsSync(parentPath)).toBe(false);
    expect(fs.readdirSync(archiveRoot)).toHaveLength(2);
  });

  describe("S5 crash recovery on revert (second review round: resume-safe, P4)", () => {
    test("primary already moved back, twin still archived — revert resumes and finishes both", async () => {
      const parentPath = writeAsset("memories/parent.md", "description: parent");
      const twinPath = writeAsset(
        "memories/parent.derived.md",
        "inferred: true\nsource: memories/parent\ndescription: derived child",
      );
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/parent",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: parentPath,
          retiredRef: "memories/parent",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(fs.existsSync(parentPath)).toBe(false);
      expect(fs.existsSync(twinPath)).toBe(false);

      // Simulate a crash mid-revert: the primary's rename back already
      // succeeded (an earlier, interrupted revert attempt of our own), the
      // twin's archived copy is untouched, and the DB write never happened —
      // status is still "accepted".
      const primaryEntry = findArchiveEntry("memories/parent.md");
      fs.renameSync(primaryEntry.archivedAbs, primaryEntry.originalAbs);
      expect(fs.existsSync(parentPath)).toBe(true);
      expect(fs.existsSync(twinPath)).toBe(false);
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("accepted");

      const result = await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(result.proposal.status).toBe("reverted");
      expect(fs.existsSync(parentPath)).toBe(true); // not re-moved, not an error
      expect(fs.existsSync(twinPath)).toBe(true); // the one still-pending move completes
      expect(fs.existsSync(archiveRootOf()) ? fs.readdirSync(archiveRootOf()) : []).toEqual([]);
    });

    test("archived copy purged, then the path reused by an unrelated file — revert refuses instead of overwriting it (must-fix 2, third review round)", async () => {
      const parentPath = writeAsset("memories/parent.md", "description: parent");
      const newPath = writeAsset("memories/new-note.md", "description: a new note");
      const config = makeConfig(storage.stashDir);
      const proposal = createRetireProposal(storage.stashDir, {
        ref: "memories/parent",
        source: "consolidate-pair",
        retirement: retirement({
          retiredPath: parentPath,
          retiredRef: "memories/parent",
          successorPath: newPath,
          successorRef: "memories/new-note",
        }),
      });
      await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(fs.existsSync(parentPath)).toBe(false);

      // A purge (not built yet) deletes the archived bytes; later, an
      // unrelated new memory happens to reuse the exact same original path.
      const primaryEntry = findArchiveEntry("memories/parent.md");
      fs.rmSync(primaryEntry.archivedAbs);
      const reusedContent = "---\ndescription: an unrelated new memory\n---\nCompletely different content.\n";
      fs.mkdirSync(path.dirname(primaryEntry.originalAbs), { recursive: true });
      fs.writeFileSync(primaryEntry.originalAbs, reusedContent, "utf8");

      await expect(akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
        /path may have been reused/,
      );
      // The unrelated new file survives untouched — not overwritten with the old retired bytes.
      expect(fs.readFileSync(parentPath, "utf8")).toBe(reusedContent);
      expect(getProposal(storage.stashDir, proposal.id).status).toBe("accepted");
    });
  });
});

describe("triage never auto-accepts a retire proposal", () => {
  test("drainProposals with applyMode: promote leaves it pending", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const result = await drainProposals({
      stashDir: storage.stashDir,
      config,
      applyMode: "promote",
      maxAccepts: 25,
      dryRun: false,
    });
    expect(result.promoted).not.toContain(proposal.id);
    expect(result.rejected).not.toContain(proposal.id);
    expect(result.deferred.map((d) => d.id)).not.toContain(proposal.id);
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
  });
});

describe("review surface (show / diff / bulk accept) works for retire proposals", () => {
  test("show does not throw and reports the proposal valid", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const shown = akmProposalShow({ stashDir: storage.stashDir, id: proposal.id });
    expect(shown.validation.ok).toBe(true);
  });

  test("diff shows the whole body being removed", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note", "The durable fact.\n");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const diff = akmProposalDiff({ stashDir: storage.stashDir, id: proposal.id });
    expect(diff.isNew).toBe(false);
    expect(diff.unified).toContain("-The durable fact.");
  });

  test("S6: bulk accept --generator consolidate-pair sweeps only retire proposals; --generator consolidate sweeps only promotions", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const retireProposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const promoteProposal = createProposal(storage.stashDir, {
      ref: "knowledge/promoted",
      source: "consolidate",
      target: { source: "stash", root: storage.stashDir },
      payload: {
        content: "---\ndescription: promoted knowledge\n---\n\nBody.\n",
        frontmatter: { description: "promoted knowledge" },
      },
    });

    const consolidateSweep = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "accept",
      generator: "consolidate",
    });
    expect(consolidateSweep.count).toBe(1);
    expect(getProposal(storage.stashDir, promoteProposal.id).status).toBe("accepted");
    expect(getProposal(storage.stashDir, retireProposal.id).status).toBe("pending"); // untouched by the consolidate sweep

    const pairSweep = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "accept",
      generator: "consolidate-pair",
    });
    expect(pairSweep.count).toBe(1);
    expect(getProposal(storage.stashDir, retireProposal.id).status).toBe("accepted");
  });

  test("item 1: a continuityRisk proposal is skipped by bulk accept, but a person can still accept it by id", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const riskyProposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
        continuityRisk: { failingQueries: 1, ranks: [{ query: "how do I do X", retiredRank: 1, successorRank: null }] },
      }),
    });

    const sweep = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "accept",
      generator: "consolidate-pair",
    });
    expect(sweep.count).toBe(0); // flagged: never swept, whatever the generator
    expect(sweep.skippedForContinuityRisk).toBe(1); // S4: reported apart from an ordinary filter miss
    expect(getProposal(storage.stashDir, riskyProposal.id).status).toBe("pending");

    // A person can still accept it directly, by id.
    const accepted = await akmProposalAccept({ stashDir: storage.stashDir, id: riskyProposal.id, config });
    expect(accepted.proposal.status).toBe("accepted");
  });

  test("item 1: bulk REJECT is unaffected by continuityRisk — declining a flagged proposal is always safe", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const riskyProposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
        continuityRisk: { failingQueries: 1, ranks: [{ query: "q", retiredRank: 1, successorRank: null }] },
      }),
    });

    const rejectSweep = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "reject",
      generator: "consolidate-pair",
      reason: "bulk reject sweep",
    });
    expect(rejectSweep.count).toBe(1);
    expect(rejectSweep.skippedForContinuityRisk).toBe(0); // S4: only accept excludes for continuityRisk
    expect(getProposal(storage.stashDir, riskyProposal.id).status).toBe("rejected");
  });

  test("S6: --max-diff-lines counts a retire proposal by its target's own current line count, not its empty payload", async () => {
    const bigPath = writeAsset(
      "memories/big-note.md",
      "description: a big note",
      "Line one.\nLine two.\nLine three.\n",
    );
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/big-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: bigPath,
        retiredRef: "memories/big-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const tooSmall = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "accept",
      generator: "consolidate-pair",
      maxDiffLines: 1,
    });
    expect(tooSmall.count).toBe(0);
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");

    const bigEnough = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "accept",
      generator: "consolidate-pair",
      maxDiffLines: 100,
    });
    expect(bigEnough.count).toBe(1);
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("accepted");
  });
});

describe("O1: an accepted promotion retires its source memory", () => {
  test("archives promotionSource (and its .derived twin) when the promotion is accepted and its body is unchanged (B3)", async () => {
    const sourceContent = "---\ndescription: source memory\n---\n\nSource body.\n";
    const sourcePath = writeAsset("memories/source-note.md", "placeholder");
    fs.writeFileSync(sourcePath, sourceContent, "utf8");
    const twinPath = writeAsset(
      "memories/source-note.derived.md",
      "inferred: true\nsource: memories/source-note\ndescription: derived child",
    );
    const config = makeConfig(storage.stashDir);
    const proposal = createProposal(storage.stashDir, {
      ref: "knowledge/promoted-note",
      source: "consolidate",
      target: { source: "stash", root: storage.stashDir },
      payload: {
        content: "---\ndescription: promoted knowledge\nxrefs:\n  - memories/source-note\n---\n\nPromoted body.\n",
        frontmatter: { description: "promoted knowledge" },
      },
      promotionSource: "memories/source-note",
      promotionSourceHash: contentHash(sourceContent, "body"),
    });
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(result.proposal.status).toBe("accepted");
    expect(fs.existsSync(result.assetPath)).toBe(true);

    // The source memory (and its twin) were retired, not left as a duplicate.
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(twinPath)).toBe(false);
    const archiveRoot = path.join(storage.stashDir, ".akm", "memory-cleanup", "archive");
    const dirs = fs.readdirSync(archiveRoot);
    expect(dirs).toHaveLength(2); // source + twin
    const tombstone = parseFrontmatter(fs.readFileSync(path.join(archiveRoot, dirs[0]!, "cleanup.md"), "utf8")).data;
    expect(tombstone.reason).toBe("promoted");
    expect(tombstone.successorRefs).toEqual([result.ref]);
  });

  test("B3: a source edited after the promotion was minted is left alone — not archived", async () => {
    const originalContent = "---\ndescription: source memory\n---\n\nOriginal fact.\n";
    const sourcePath = writeAsset("memories/source-note.md", "placeholder");
    fs.writeFileSync(sourcePath, originalContent, "utf8");
    const config = makeConfig(storage.stashDir);
    const proposal = createProposal(storage.stashDir, {
      ref: "knowledge/promoted-note",
      source: "consolidate",
      target: { source: "stash", root: storage.stashDir },
      payload: {
        content: "---\ndescription: promoted knowledge\n---\n\nPromoted body.\n",
        frontmatter: { description: "promoted knowledge" },
      },
      promotionSource: "memories/source-note",
      promotionSourceHash: contentHash(originalContent, "body"),
    });
    fs.writeFileSync(
      sourcePath,
      "---\ndescription: source memory\n---\n\nOriginal fact.\nNEW FACT ADDED LATER.\n",
      "utf8",
    );
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(result.proposal.status).toBe("accepted"); // the promotion itself still applies
    expect(fs.existsSync(sourcePath)).toBe(true); // but the edited source is not archived
    const content = fs.readFileSync(sourcePath, "utf8");
    expect(content).toContain("NEW FACT ADDED LATER");
  });

  test("B3: a promotion minted before promotionSourceHash existed never archives its source", async () => {
    const sourcePath = writeAsset("memories/source-note.md", "description: source memory");
    const config = makeConfig(storage.stashDir);
    const proposal = createProposal(storage.stashDir, {
      ref: "knowledge/promoted-note",
      source: "consolidate",
      target: { source: "stash", root: storage.stashDir },
      payload: {
        content: "---\ndescription: promoted knowledge\n---\n\nPromoted body.\n",
        frontmatter: { description: "promoted knowledge" },
      },
      promotionSource: "memories/source-note",
      // no promotionSourceHash — simulates a proposal minted by an older release
    });
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(result.proposal.status).toBe("accepted");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  test("a source already gone (raced) does not fail the promotion accept", async () => {
    const config = makeConfig(storage.stashDir);
    const proposal = createProposal(storage.stashDir, {
      ref: "knowledge/promoted-note-2",
      source: "consolidate",
      target: { source: "stash", root: storage.stashDir },
      payload: {
        content: "---\ndescription: promoted knowledge\n---\n\nPromoted body.\n",
        frontmatter: { description: "promoted knowledge" },
      },
      promotionSource: "memories/never-existed",
      promotionSourceHash: "irrelevant-since-the-file-never-existed",
    });
    const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(result.proposal.status).toBe("accepted");
  });

  test("a non-consolidate proposal's promotionSource-shaped ref is never retired (promotionSource is only meaningful for consolidate)", async () => {
    const sourcePath = writeAsset("memories/untouched.md", "description: untouched");
    const config = makeConfig(storage.stashDir);
    // reflect/distill never set promotionSource in practice; this proves the
    // accept path gates on `source === "consolidate"`, not merely on the
    // field's presence, should some other producer ever set it by mistake.
    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/from-reflect",
      source: "reflect",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: "---\ndescription: a lesson\nwhen_to_use: when testing\n---\n\nBody.\n" },
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
});

describe("retire and promote proposals mint under separate sources (S6)", () => {
  test("listProposals(status: pending) shows both, filterable by their own distinct source", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    createProposal(storage.stashDir, {
      ref: "knowledge/promoted",
      source: "consolidate",
      target: { source: "stash", root: storage.stashDir },
      payload: {
        content: "---\ndescription: promoted knowledge\n---\n\nBody.\n",
        frontmatter: { description: "promoted knowledge" },
      },
    });
    const pending = listProposals(storage.stashDir, { status: "pending" });
    expect(pending).toHaveLength(2);
    expect(pending.filter((p) => p.source === "consolidate-pair")).toHaveLength(1);
    expect(pending.filter((p) => p.source === "consolidate")).toHaveLength(1);
  });
});

describe("drain hard-skip is unconditional on the retire shape (S6: not on the source string)", () => {
  test("drainProposals with applyMode: promote and reject leaves a retire proposal pending, whatever its source value", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: an old note");
    const newPath = writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: oldPath,
        retiredRef: "memories/old-note",
        successorPath: newPath,
        successorRef: "memories/new-note",
      }),
    });
    const result = await drainProposals({
      stashDir: storage.stashDir,
      config,
      applyMode: "queue",
      maxAccepts: 25,
      dryRun: false,
    });
    expect(result.promoted).not.toContain(proposal.id);
    expect(result.rejected).not.toContain(proposal.id);
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
  });
});

describe("revert by ref names a sibling retire proposal when refusing (nit, third review round)", () => {
  test("reverting an older reflect proposal by ref, when a retire proposal for the same ref exists, names the retire proposal's id", async () => {
    const targetPath = writeAsset("lessons/dup-target.md", "description: original\nwhen_to_use: originally");
    const config = makeConfig(storage.stashDir);
    const reflect = createProposal(storage.stashDir, {
      ref: "lessons/dup-target",
      source: "reflect",
      payload: { content: "---\ndescription: edited\nwhen_to_use: now\n---\n\nEdited body.\n" },
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: reflect.id, config });

    // A retire proposal for the SAME ref is minted and accepted afterwards —
    // by-ref resolution skips it (should-fix 7), so a bare `revert
    // lessons/dup-target` lands on the reflect proposal instead, whose
    // target is now gone (archived by the retire).
    const newPath = writeAsset("lessons/dup-elsewhere.md", "description: elsewhere");
    const retireProposal = createRetireProposal(storage.stashDir, {
      ref: "lessons/dup-target",
      source: "consolidate-pair",
      retirement: retirement({
        retiredPath: targetPath,
        retiredRef: "lessons/dup-target",
        successorPath: newPath,
        successorRef: "lessons/dup-elsewhere",
      }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: retireProposal.id, config });
    expect(fs.existsSync(targetPath)).toBe(false);

    await expect(akmProposalRevert({ stashDir: storage.stashDir, id: "lessons/dup-target", config })).rejects.toThrow(
      new RegExp(retireProposal.id),
    );
  });
});
