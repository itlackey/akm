// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #884 — pruning a memory left every inbound belief edge dangling.
 *
 * `analyzeMemoryCleanup`/`applyMemoryCleanup` ARCHIVE a pruned memory (rename
 * under `.akm/memory-cleanup/archive` + a `cleanup.md` audit record) rather
 * than deleting it, but ref resolution only ever looked at the memory's
 * ORIGINAL location. Once #882 made `contradictedBy`/`supersededBy`
 * validatable, every memory pointing at a pruned one started reporting
 * `missing-ref`.
 *
 * The fix resolves the archive tombstone. These tests drive the REAL prune
 * producer (not a hand-built archive fixture) so the tombstone contract is
 * pinned end-to-end: if `archiveMemory` ever changes its layout or drops
 * `originalPath`, the first test fails rather than silently regressing to
 * "everything is missing".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../src/commands/improve/content-hash";
import { analyzeMemoryCleanup, applyMemoryCleanup } from "../src/commands/improve/memory/memory-improve";
import { akmLint } from "../src/commands/lint";
import { akmProposalAccept } from "../src/commands/proposal/proposal";
import { createRetireProposal } from "../src/commands/proposal/repository";
import { resetMemoryArchiveCache } from "../src/core/asset/memory-archive";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

function writeMemory(stashDir: string, slug: string, frontmatter: string, body = "Body.\n"): void {
  fs.writeFileSync(path.join(stashDir, "memories", `${slug}.md`), `---\n${frontmatter}---\n\n${body}`);
}

/**
 * A parent plus two byte-identical derived children — the `duplicate-derived`
 * shape `analyzeMemoryCleanup` prunes. Returns the ref that gets archived.
 */
function seedPrunableDuplicate(stashDir: string): string {
  writeMemory(stashDir, "deploy", "description: parent memory\n");
  const derived =
    "inferred: true\n" +
    "source: memories/deploy\n" +
    "title: Check VPN before deploy\n" +
    "description: VPN is required before deploys.\n";
  const body = "# Check VPN before deploy\n\nEnable VPN before starting the release.\n";
  writeMemory(stashDir, "deploy.derived", derived, body);
  writeMemory(stashDir, "deploy-duplicate.derived", derived, body);
  return "memories/deploy-duplicate.derived";
}

/** Run the real prune. Returns the stash-relative original paths that were archived. */
function prune(stashDir: string): string[] {
  const applied = applyMemoryCleanup(stashDir, analyzeMemoryCleanup(stashDir));
  resetMemoryArchiveCache(); // the sweep below must see the archive this call just wrote
  return applied.archived.map((record) => record.originalPath);
}

describe("belief edges to a pruned memory resolve through the archive tombstone (#884)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetMemoryArchiveCache();
  });
  afterEach(() => {
    resetMemoryArchiveCache();
    storage.cleanup();
  });

  test("a contradictedBy edge to a pruned memory is not reported as missing-ref", async () => {
    const stashDir = storage.stashDir;
    const prunedRef = seedPrunableDuplicate(stashDir);
    writeMemory(stashDir, "holder", `description: holds the edge\ncontradictedBy:\n  - ${prunedRef}\n`);

    // Precondition: the edge resolves while the target is still live, so a
    // pass here can never be "the ref was unresolvable-shaped all along".
    const before = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(before.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);

    expect(prune(stashDir)).toEqual(["memories/deploy-duplicate.derived.md"]);
    expect(fs.existsSync(path.join(stashDir, "memories", "deploy-duplicate.derived.md"))).toBe(false);

    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("the legacy type:slug spelling of the same edge also resolves", async () => {
    const stashDir = storage.stashDir;
    seedPrunableDuplicate(stashDir);
    writeMemory(
      stashDir,
      "holder",
      "description: holds the edge\ncontradictedBy:\n  - memory:deploy-duplicate.derived\n",
    );

    expect(prune(stashDir)).toEqual(["memories/deploy-duplicate.derived.md"]);

    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("a supersededBy edge to a pruned memory resolves on the same channel", async () => {
    const stashDir = storage.stashDir;
    const prunedRef = seedPrunableDuplicate(stashDir);
    writeMemory(stashDir, "holder", `description: holds the edge\nsupersededBy:\n  - ${prunedRef}\n`);

    expect(prune(stashDir)).toEqual(["memories/deploy-duplicate.derived.md"]);

    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("an edge to a memory that was never archived is STILL reported (no blanket suppression)", async () => {
    const stashDir = storage.stashDir;
    seedPrunableDuplicate(stashDir);
    // The #884 stash's real shape: the target was removed by a hand `git rm`,
    // so there is no tombstone and the edge is genuinely dangling.
    writeMemory(stashDir, "holder", "description: holds the edge\ncontradictedBy:\n  - memories/never-existed\n");

    prune(stashDir);

    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    const missing = after.flagged.filter((f) => f.issue === "missing-ref");
    expect(missing.length).toBe(1);
    expect(missing[0]?.detail).toContain("memories/never-existed");
  });

  test("a tombstone never shadows a live file of the same name", async () => {
    const stashDir = storage.stashDir;
    seedPrunableDuplicate(stashDir);
    writeMemory(
      stashDir,
      "holder",
      "description: holds the edge\ncontradictedBy:\n  - memories/deploy-duplicate.derived\n",
    );
    prune(stashDir);

    // Re-create the memory at its original path. Resolution must prefer the
    // live file; the stale tombstone must not make a later real deletion
    // invisible either, so re-deleting still resolves (via the tombstone).
    writeMemory(stashDir, "deploy-duplicate.derived", "description: back again\n");
    resetMemoryArchiveCache();
    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("a corrupt audit record degrades to missing-ref rather than throwing", async () => {
    const stashDir = storage.stashDir;
    const prunedRef = seedPrunableDuplicate(stashDir);
    writeMemory(stashDir, "holder", `description: holds the edge\ncontradictedBy:\n  - ${prunedRef}\n`);
    prune(stashDir);

    const archiveRoot = path.join(stashDir, ".akm", "memory-cleanup", "archive");
    for (const dir of fs.readdirSync(archiveRoot)) {
      fs.writeFileSync(path.join(archiveRoot, dir, "cleanup.md"), "not: [valid\nfrontmatter\n");
    }
    resetMemoryArchiveCache();

    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(after.flagged.filter((f) => f.issue === "missing-ref").length).toBe(1);
  });
});

/**
 * alpha.9: the consolidate pair pass retires assets through a GENERALIZED
 * `archiveCleanupCandidate` — any memory, knowledge or lesson file, not only
 * `.derived` memories. This is the same #884 ref-resolution guarantee, but
 * for a producer this file's own tests never drive: `akm proposal accept`
 * on a `retire` proposal targeting a plain KNOWLEDGE asset (no `.derived`
 * shape at all).
 */
describe("a retire proposal's archived KNOWLEDGE asset also resolves through the tombstone (alpha.9)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetMemoryArchiveCache();
  });
  afterEach(() => {
    resetMemoryArchiveCache();
    storage.cleanup();
  });

  test("an xrefs edge to a retired knowledge asset is not reported as missing-ref", async () => {
    const stashDir = storage.stashDir;
    fs.mkdirSync(path.join(stashDir, "knowledge"), { recursive: true });
    const oldGuideContent = "---\ndescription: an older guide, superseded by a newer one\n---\n\nOld content.\n";
    fs.writeFileSync(path.join(stashDir, "knowledge", "old-guide.md"), oldGuideContent);
    const newGuideContent = "---\ndescription: the newer guide\n---\n\nNew content.\n";
    fs.writeFileSync(path.join(stashDir, "knowledge", "new-guide.md"), newGuideContent);
    writeMemory(stashDir, "holder", "description: holds the edge\nxrefs:\n  - knowledge/old-guide\n");

    const before = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(before.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);

    const config = makeConfig(stashDir);
    // B2 (post-review): accept verifies both sides' recorded body hashes
    // against the current files, so the fixture uses the REAL hashes of the
    // files actually on disk rather than placeholder bytes.
    const proposal = createRetireProposal(stashDir, {
      ref: "knowledge/old-guide",
      source: "consolidate-pair",
      target: { source: "stash", root: stashDir },
      retirement: {
        retiredRef: "knowledge/old-guide",
        successorRef: "knowledge/new-guide",
        cosine: 0.96,
        judgeLabel: "duplicate",
        judgeReason: "Same durable facts as the newer guide.",
        retiredContentHash: contentHash(oldGuideContent, "body"),
        successorContentHash: contentHash(newGuideContent, "body"),
        reason: "duplicate",
      },
    });
    await akmProposalAccept({ stashDir, id: proposal.id, config });
    resetMemoryArchiveCache(); // the lint sweep below must see the archive accept just wrote

    expect(fs.existsSync(path.join(stashDir, "knowledge", "old-guide.md"))).toBe(false);

    const after = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });
    expect(after.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });
});
