/**
 * Tests for the promote-op deduplication logic added to akmConsolidate.
 *
 * Bug: a single consolidation run could produce multiple proposals for the
 * same source memory content, each with a different `knowledgeRef` target.
 * This happened when:
 *   (a) Multiple duplicate source memories with identical content were each
 *       promoted to a different knowledgeRef by the LLM in the same run.
 *   (b) Across multiple runs, the LLM suggested a different knowledgeRef
 *       slug for the same source memory content each time.
 *
 * Fix: two guards were added to the Phase B promote block in consolidate.ts:
 *   1. Within-run source-ref dedup — `promotedSourceRefs` Set prevents the
 *      same `op.ref` from being promoted twice in one run.
 *   2. Content-hash dedup — before calling `createProposal`, all pending
 *      `consolidate` proposals are scanned for a matching SHA-256 hash of
 *      the payload content. A match (regardless of target ref) causes the
 *      promote to be skipped.
 *
 * These tests validate:
 *   - `mergePlans` deduplicates promote ops by source ref within a run
 *     (the Map-based guard that was already present).
 *   - The content-hash dedup logic correctly identifies duplicate content
 *     across proposals with different target refs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { emitPromotionProposal, loadExistingKnowledgeBodyHashes } from "../../../src/commands/improve/consolidate";
import { mergePlans } from "../../../src/commands/improve/consolidate/merge";
import type { ConsolidateOperation, ConsolidatePromoteOp } from "../../../src/commands/improve/consolidate/types";
import { cacheHash } from "../../../src/commands/improve/content-hash";
import { createProposal, listProposals } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { resolveWriteTarget } from "../../../src/core/write-source";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../../src/indexer/installations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The durable `proposals.ref` item_ref (WI-8.5a): `<bundle>//<conceptId>`. */
function durableRef(stashDir: string, type: string, name: string): string {
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

function makePromoteOp(ref: string, knowledgeRef: string): ConsolidatePromoteOp {
  return {
    op: "promote",
    ref,
    knowledgeRef,
    reason: "test reason",
    description: "test description",
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

beforeEach(() => {
  // Isolate XDG directories (and a scaffolded stash) so test proposals don't
  // pollute the real stash.
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function makeStashDir(): string {
  return storage.stashDir;
}

// ── Tests: mergePlans within-run dedup ───────────────────────────────────────

describe("mergePlans — promote op deduplication by source ref", () => {
  it("deduplicates promote ops for the same source ref across two chunks, keeping last", () => {
    // Simulates two LLM chunks both recommending the same source memory for
    // promotion but with different target knowledgeRef values.
    const chunk1: ConsolidateOperation[] = [
      makePromoteOp("memories/review-efficiency", "knowledge/paged-review-efficiency"),
    ];
    const chunk2: ConsolidateOperation[] = [
      makePromoteOp("memories/review-efficiency", "knowledge/print-review-efficiency"),
    ];

    const { ops } = mergePlans([chunk1, chunk2]);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    // Only one promote op should survive; the Map key is `op.ref` so the last
    // chunk's value wins.
    expect(promoteOps).toHaveLength(1);
    expect(promoteOps[0]?.ref).toBe("memories/review-efficiency");
  });

  it("deduplicates 4 promote ops for the same source ref across 4 chunks", () => {
    // Regression test mirroring the exact bug report:
    // 4 copies of a promote op with different knowledgeRef values from separate chunks.
    const chunks: ConsolidateOperation[][] = [
      [makePromoteOp("memories/review-efficiency", "knowledge/paged-review-efficiency")],
      [makePromoteOp("memories/review-efficiency", "knowledge/print-review-efficiency")],
      [makePromoteOp("memories/review-efficiency", "knowledge/print-review-efficiency-patterns")],
      [makePromoteOp("memories/review-efficiency", "knowledge/review-agent-efficiency")],
    ];

    const { ops } = mergePlans(chunks);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    expect(promoteOps).toHaveLength(1);
    expect(promoteOps[0]?.ref).toBe("memories/review-efficiency");
  });

  it("preserves promote ops for different source refs (no over-deduplication)", () => {
    // Two different source memories promoted to different targets — both must survive.
    const chunk1: ConsolidateOperation[] = [
      makePromoteOp("memories/review-efficiency", "knowledge/review-efficiency"),
      makePromoteOp("memories/embedding-fix", "knowledge/akm-embedding-fix"),
    ];

    const { ops } = mergePlans([chunk1]);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    expect(promoteOps).toHaveLength(2);
    const refs = promoteOps.map((p) => p.ref);
    expect(refs).toContain("memories/review-efficiency");
    expect(refs).toContain("memories/embedding-fix");
  });

  it("preserves a single promote op unchanged", () => {
    const chunk: ConsolidateOperation[] = [makePromoteOp("memories/foo", "knowledge/foo-stable")];

    const { ops } = mergePlans([chunk]);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    expect(promoteOps).toHaveLength(1);
    expect(promoteOps[0]?.knowledgeRef).toBe("knowledge/foo-stable");
  });
});

// ── Tests: content-hash dedup via createProposal ────────────────────────────

describe("content-hash dedup — identical content blocked regardless of target ref", () => {
  /**
   * These tests validate the guard added to Phase B of akmConsolidate:
   *
   *   const newContentHash = cacheHash(memoryContent);
   *   const allPendingConsolidateProposals = listProposals(stashDir, { status: "pending" })
   *     .filter((p) => p.source === "consolidate");
   *   const contentDupProposal = allPendingConsolidateProposals.find(
   *     (p) => cacheHash(p.payload.content) === newContentHash,
   *   );
   *   if (contentDupProposal) { ... skip ... }
   *
   * We test the logic directly by:
   *   1. Creating a proposal via createProposal.
   *   2. Listing pending proposals and computing content hashes.
   *   3. Asserting that a second proposal with the same content (different ref)
   *      would be detected as a duplicate by the hash guard.
   */

  const CONTENT_WITH_DESCRIPTION = `---\ndescription: Reusable efficiency knowledge\n---\n\nThis memory describes efficiency patterns for review agents.\n`;

  it("content hash of a created proposal matches a second identical payload", () => {
    const stash = makeStashDir();

    // Create the first proposal.
    createProposal(stash, {
      ref: "knowledge/paged-review-efficiency",
      source: "consolidate",
      payload: {
        content: CONTENT_WITH_DESCRIPTION,
        frontmatter: { description: "Reusable efficiency knowledge" },
      },
    });

    // Load all pending consolidate proposals.
    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
    expect(pending).toHaveLength(1);

    // Compute hash of the second (duplicate) payload — same content, different ref.
    const secondContentHash = cacheHash(CONTENT_WITH_DESCRIPTION);
    const existingContent = pending[0]?.payload.content ?? "";
    const existingHash = cacheHash(existingContent);

    // The guard should detect the match.
    expect(existingHash).toBe(secondContentHash);
    const dup = pending.find((p) => cacheHash(p.payload.content) === secondContentHash);
    expect(dup).toBeDefined();
    expect(dup?.ref).toBe(durableRef(stash, "knowledge", "paged-review-efficiency"));
  });

  it("content hash guard does NOT block proposals with different content", () => {
    const stash = makeStashDir();

    const content1 = `---\ndescription: Pattern A\n---\n\nContent for pattern A.\n`;
    const content2 = `---\ndescription: Pattern B\n---\n\nContent for pattern B — completely different.\n`;

    // Create a proposal for content1.
    createProposal(stash, {
      ref: "knowledge/pattern-a",
      source: "consolidate",
      payload: { content: content1, frontmatter: { description: "Pattern A" } },
    });

    // content2 should NOT match the hash of content1.
    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
    const hash2 = cacheHash(content2);
    const dup = pending.find((p) => cacheHash(p.payload.content) === hash2);

    // No match — the second proposal would be allowed through.
    expect(dup).toBeUndefined();
  });

  it("hash guard ignores non-consolidate pending proposals", () => {
    // A pending proposal from a different source (e.g. 'distill') should NOT
    // block a consolidate proposal with the same content. The guard filters by
    // source === 'consolidate' only.
    const stash = makeStashDir();
    const SHARED_CONTENT = `---\ndescription: Shared knowledge\n---\n\nSome reusable content.\n`;

    // Create a 'distill' proposal with the same content.
    createProposal(stash, {
      ref: "knowledge/shared-knowledge",
      source: "distill",
      payload: { content: SHARED_CONTENT, frontmatter: { description: "Shared knowledge" } },
    });

    // The consolidate guard should only check consolidate proposals.
    const pendingConsolidate = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
    const hash = cacheHash(SHARED_CONTENT);
    const dup = pendingConsolidate.find((p) => cacheHash(p.payload.content) === hash);

    // No consolidate proposals exist yet — dup should be undefined.
    expect(dup).toBeUndefined();
  });

  it("4 identical-content proposals for different refs: only first would be created", () => {
    // Simulates the exact bug scenario: 4 memories with identical content, each
    // promoted to a different knowledgeRef. Only the first should be created;
    // the guard detects the content hash match for refs 2-4.
    const stash = makeStashDir();
    const IDENTICAL_CONTENT = `---\ndescription: Review efficiency patterns\n---\n\nWhen reviewing documents, batch similar items together to reduce context switching overhead.\n`;

    const refs = [
      "knowledge/paged-review-efficiency",
      "knowledge/print-review-efficiency",
      "knowledge/print-review-efficiency-patterns",
      "knowledge/review-agent-efficiency",
    ];

    const createdIds: string[] = [];
    const skippedRefs: string[] = [];

    for (const ref of refs) {
      // Simulate the Phase B content-hash guard: load all pending consolidate
      // proposals and check for hash match before calling createProposal.
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
      const newHash = cacheHash(IDENTICAL_CONTENT);
      const contentDup = pending.find((p) => cacheHash(p.payload.content) === newHash);

      if (contentDup) {
        skippedRefs.push(ref);
        continue;
      }

      const result = createProposal(stash, {
        ref,
        source: "consolidate",
        payload: { content: IDENTICAL_CONTENT, frontmatter: { description: "Review efficiency patterns" } },
      });
      createdIds.push(result.id);
    }

    // Only the first ref's proposal should have been created.
    expect(createdIds).toHaveLength(1);
    expect(skippedRefs).toHaveLength(3);

    // The single pending proposal should be for the first ref.
    const allPending = listProposals(stash, { status: "pending" });
    expect(allPending).toHaveLength(1);
    expect(allPending[0]?.ref).toBe(durableRef(stash, "knowledge", "paged-review-efficiency"));
  });
});

describe("existing knowledge body dedup", () => {
  it("finds an accepted knowledge body despite different frontmatter and a nested path", () => {
    const stash = makeStashDir();
    const nested = path.join(stash, "knowledge", "accepted");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(nested, "existing.md"),
      "---\ntype: knowledge\ndescription: Existing title\n---\n\nReusable body text with enough substance.\n",
    );
    fs.writeFileSync(path.join(stash, "knowledge", "ignored.txt"), "Reusable body text with enough substance.\n");

    const hashes = loadExistingKnowledgeBodyHashes(stash);

    expect(
      hashes.has(
        cacheHash(
          "---\ntype: memory\ndescription: Different title\n---\n\nReusable body text with enough substance.\n",
        ),
      ),
    ).toBe(true);
    expect(hashes.has(cacheHash("A genuinely different body."))).toBe(false);
    expect(hashes).toHaveLength(1);
  });

  it("returns an empty set when the knowledge directory is absent", () => {
    const stash = path.join(storage.root, "no-knowledge-stash");
    fs.mkdirSync(stash, { recursive: true });
    expect(loadExistingKnowledgeBodyHashes(stash)).toEqual(new Set());
  });

  it("suppresses proposal emission on the real promotion path and records the skip reason", async () => {
    const stash = makeStashDir();
    const sourceBody =
      "Reusable accepted knowledge body with enough substance to pass the promotion size gate. " +
      "The second sentence keeps this fixture above the production minimum without changing its meaning.";
    const memoryPath = path.join(stash, "memories", "source.md");
    fs.writeFileSync(memoryPath, `---\ndescription: Source memory\n---\n\n${sourceBody}\n`);
    fs.writeFileSync(
      path.join(stash, "knowledge", "already-accepted.md"),
      `---\ntype: knowledge\ndescription: Different accepted title\n---\n\n${sourceBody}\n`,
    );
    const config = {
      semanticSearchMode: "off",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
    } as AkmConfig;
    const promoted: string[] = [];
    const warnings: string[] = [];
    const skips: Array<{ op: string; ref: string; reason: string }> = [];

    await emitPromotionProposal(makePromoteOp("memories/source", "knowledge/new-slug"), {
      config,
      stashDir: stash,
      sourceRun: "consolidate-test",
      target: resolveWriteTarget(config),
      memoryByRef: new Map([
        [
          "memories/source",
          { name: "source", filePath: memoryPath, description: "Source memory", tags: [], stashDir: stash },
        ],
      ]),
      promoted,
      promotedSourceRefs: new Set(),
      existingKnowledgeBodyHashes: loadExistingKnowledgeBodyHashes(stash),
      promotionFailures: { count: 0 },
      warnings,
      pushSkipReason: (op, ref, reason) => skips.push({ op, ref, reason }),
    });

    expect(listProposals(stash, { status: "pending" })).toHaveLength(0);
    expect(promoted).toEqual([]);
    expect(skips).toEqual([{ op: "promote", ref: "memories/source", reason: "dedup_existing_knowledge" }]);
    expect(warnings.some((warning) => warning.includes("identical body already exists in knowledge"))).toBe(true);
  });

  it("detects a duplicate whose body starts with its own --- block (H1)", async () => {
    // Regression for H1: the post-LLM dedup hash used to be computed as
    // cacheHash(parseFrontmatter(memoryContent).content.trim()) — an already-
    // stripped body run through cacheHash's own internal strip a second time.
    // A body that begins with its own `---`…`---` divider pair only diverges
    // from the single-strip domain (loadExistingKnowledgeBodyHashes / the
    // pre-filter) under that double strip, so this fixture is the minimal
    // reproduction: with the bug, the dedup guard misses the match and a
    // promote for duplicate content goes through uncaught.
    const stash = makeStashDir();
    const sourceBody =
      "---\nexample: not real frontmatter\n---\n\n" +
      "This body deliberately starts with its own --- divider pair so the duplicate-detection hash must not " +
      "re-strip it a second time. The text continues long enough to clear the promotion size gate.";
    const memoryPath = path.join(stash, "memories", "source.md");
    fs.writeFileSync(memoryPath, `---\ndescription: Source memory\n---\n\n${sourceBody}\n`);
    fs.writeFileSync(
      path.join(stash, "knowledge", "already-accepted.md"),
      `---\ntype: knowledge\ndescription: Different accepted title\n---\n\n${sourceBody}\n`,
    );
    const config = {
      semanticSearchMode: "off",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
    } as AkmConfig;
    const promoted: string[] = [];
    const warnings: string[] = [];
    const skips: Array<{ op: string; ref: string; reason: string }> = [];

    await emitPromotionProposal(makePromoteOp("memories/source", "knowledge/new-slug"), {
      config,
      stashDir: stash,
      sourceRun: "consolidate-test",
      target: resolveWriteTarget(config),
      memoryByRef: new Map([
        [
          "memories/source",
          { name: "source", filePath: memoryPath, description: "Source memory", tags: [], stashDir: stash },
        ],
      ]),
      promoted,
      promotedSourceRefs: new Set(),
      existingKnowledgeBodyHashes: loadExistingKnowledgeBodyHashes(stash),
      promotionFailures: { count: 0 },
      warnings,
      pushSkipReason: (op, ref, reason) => skips.push({ op, ref, reason }),
    });

    expect(listProposals(stash, { status: "pending" })).toHaveLength(0);
    expect(promoted).toEqual([]);
    expect(skips).toEqual([{ op: "promote", ref: "memories/source", reason: "dedup_existing_knowledge" }]);
  });
});
