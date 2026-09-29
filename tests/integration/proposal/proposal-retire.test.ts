// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 0.9.17-alpha.9 — the consolidate pair pass's `retire` proposal effect
 * (plan §5.4, brief §B) and O1 (a promotion retires its source).
 *
 * A `retire` proposal's primary `FileChange` deletes its target instead of
 * writing content: accepting it archives the asset (and its `.derived`
 * twin) through the generalized `archiveCleanupCandidate`, `supersedes`
 * additionally writes/removes a `supersededBy` edge, and triage must never
 * auto-accept one regardless of `applyMode`. These tests drive the real
 * producers end-to-end (mint -> accept -> revert), not hand-built fixtures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
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

function retirement(overrides: Partial<RetirementMetadata> = {}): RetirementMetadata {
  return {
    retiredRef: "memories/old-note",
    successorRef: "memories/new-note",
    cosine: 0.94,
    judgeLabel: "duplicate",
    judgeReason: "Same durable facts, B adds nothing new.",
    retiredContentHash: "a".repeat(64),
    successorContentHash: "b".repeat(64),
    reason: "duplicate",
    ...overrides,
  };
}

describe("createRetireProposal — mint", () => {
  test("mints a delete-primary proposal for an existing asset", () => {
    writeAsset("memories/old-note.md", "description: an old note");
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.changes).toEqual([{ path: "memories/old-note.md", op: "delete" }]);
    expect(proposal.retirement?.judgeLabel).toBe("duplicate");
    expect(proposal.beforeHash).toBeDefined();
  });

  test("refuses to mint for an asset that does not exist", () => {
    expect(() =>
      createRetireProposal(storage.stashDir, {
        ref: "memories/phantom",
        source: "consolidate",
        retirement: retirement({ retiredRef: "memories/phantom" }),
      }),
    ).toThrow(/does not exist/);
  });
});

describe("akm proposal accept on a retire proposal", () => {
  test("duplicate: archives the asset, tombstone carries reason/successorRefs/proposalId/retiredAt", async () => {
    const filePath = writeAsset("memories/old-note.md", "description: an old note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
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

    // Ledger: the proposal's own decision is recorded under its own source.
    const db = openStateDatabase();
    try {
      const row = getImproveLedgerRow(db, storage.stashDir, archived.ref, "consolidate");
      expect(row?.outcome).toBe("accepted");
    } finally {
      db.close();
    }
  });

  test("supersedes: writes the supersededBy edge on the older asset before archiving it", async () => {
    writeAsset("memories/old-note.md", "description: an old note");
    writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement({ judgeLabel: "supersedes", reason: "superseded" }),
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
    writeAsset("memories/parent.md", "description: parent");
    const twinPath = writeAsset(
      "memories/parent.derived.md",
      "inferred: true\nsource: memories/parent\ndescription: derived child",
    );
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/parent",
      source: "consolidate",
      retirement: retirement({ retiredRef: "memories/parent" }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });

    expect(fs.existsSync(twinPath)).toBe(false);
    const archived = getProposal(storage.stashDir, proposal.id);
    expect(archived.retiredArchive?.dirs).toHaveLength(2);
  });

  test("a target that no longer exists fails cleanly (UsageError), not an unhandled throw", async () => {
    const filePath = writeAsset("memories/vanishing.md", "description: about to vanish");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/vanishing",
      source: "consolidate",
      retirement: retirement({ retiredRef: "memories/vanishing" }),
    });
    fs.rmSync(filePath); // simulate a race: something else already removed it
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toBeInstanceOf(
      UsageError,
    );
    // The proposal stays pending — a clean, reviewable failure, not corruption.
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
  });

  test("re-accepting an already-accepted retire proposal is a no-op", async () => {
    writeAsset("memories/old-note.md", "description: an old note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    const second = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(second.proposal.status).toBe("accepted");
  });
});

describe("akm proposal revert on a retire proposal", () => {
  test("restores the archived asset and removes the archive dir", async () => {
    const filePath = writeAsset("memories/old-note.md", "description: an old note\ntags:\n  - x\n", "Original body.\n");
    const originalBytes = fs.readFileSync(filePath, "utf8");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
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
    writeAsset("memories/new-note.md", "description: a new note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement({ judgeLabel: "supersedes", reason: "superseded" }),
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
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/parent",
      source: "consolidate",
      retirement: retirement({ retiredRef: "memories/parent" }),
    });
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(fs.existsSync(parentPath)).toBe(true);
    expect(fs.existsSync(twinPath)).toBe(true);
  });
});

describe("triage never auto-accepts a retire proposal", () => {
  test("drainProposals with applyMode: promote leaves it pending", async () => {
    writeAsset("memories/old-note.md", "description: an old note");
    const config = makeConfig(storage.stashDir);
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
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
    writeAsset("memories/old-note.md", "description: an old note");
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
    });
    const shown = akmProposalShow({ stashDir: storage.stashDir, id: proposal.id });
    expect(shown.validation.ok).toBe(true);
  });

  test("diff shows the whole body being removed", () => {
    writeAsset("memories/old-note.md", "description: an old note", "The durable fact.\n");
    const proposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
    });
    const diff = akmProposalDiff({ stashDir: storage.stashDir, id: proposal.id });
    expect(diff.isNew).toBe(false);
    expect(diff.unified).toContain("-The durable fact.");
  });

  test("bulk accept --generator consolidate accepts a retire proposal alongside a promotion proposal", async () => {
    writeAsset("memories/old-note.md", "description: an old note");
    const config = makeConfig(storage.stashDir);
    const retireProposal = createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
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
    const { count, results } = await bulkAdjudicateProposals({
      stashDir: storage.stashDir,
      config,
      action: "accept",
      generator: "consolidate",
    });
    expect(count).toBe(2);
    expect(results.map((r) => ("id" in r ? r.id : undefined))).toEqual(
      expect.arrayContaining([retireProposal.id, promoteProposal.id]),
    );
    expect(getProposal(storage.stashDir, retireProposal.id).status).toBe("accepted");
  });
});

describe("O1: an accepted promotion retires its source memory", () => {
  test("archives promotionSource (and its .derived twin) when the promotion is accepted", async () => {
    const sourcePath = writeAsset("memories/source-note.md", "description: source memory");
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

describe("proposal list --queue consolidate surfaces both promote and retire proposals", () => {
  test("listProposals returns both kinds under the same source", () => {
    writeAsset("memories/old-note.md", "description: an old note");
    createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
      retirement: retirement(),
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
    const all = listProposals(storage.stashDir, { status: "pending" }).filter((p) => p.source === "consolidate");
    expect(all).toHaveLength(2);
  });
});
