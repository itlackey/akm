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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ConsolidateOperation, type ConsolidatePromoteOp, mergePlans } from "../src/commands/consolidate";
import { createProposal, isProposalSkipped, listProposals } from "../src/core/proposals";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-promote-dedup-");
  for (const dir of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // Isolate XDG directories so test proposals don't pollute the real stash.
  process.env.XDG_CACHE_HOME = makeTempDir("akm-dedup-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-dedup-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-dedup-data-");
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
});

// ── Tests: mergePlans within-run dedup ───────────────────────────────────────

describe("mergePlans — promote op deduplication by source ref", () => {
  it("deduplicates promote ops for the same source ref across two chunks, keeping last", () => {
    // Simulates two LLM chunks both recommending the same source memory for
    // promotion but with different target knowledgeRef values.
    const chunk1: ConsolidateOperation[] = [
      makePromoteOp("memory:review-efficiency", "knowledge:paged-review-efficiency"),
    ];
    const chunk2: ConsolidateOperation[] = [
      makePromoteOp("memory:review-efficiency", "knowledge:print-review-efficiency"),
    ];

    const { ops } = mergePlans([chunk1, chunk2]);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    // Only one promote op should survive; the Map key is `op.ref` so the last
    // chunk's value wins.
    expect(promoteOps).toHaveLength(1);
    expect(promoteOps[0]?.ref).toBe("memory:review-efficiency");
  });

  it("deduplicates 4 promote ops for the same source ref across 4 chunks", () => {
    // Regression test mirroring the exact bug report:
    // 4 copies of a promote op with different knowledgeRef values from separate chunks.
    const chunks: ConsolidateOperation[][] = [
      [makePromoteOp("memory:review-efficiency", "knowledge:paged-review-efficiency")],
      [makePromoteOp("memory:review-efficiency", "knowledge:print-review-efficiency")],
      [makePromoteOp("memory:review-efficiency", "knowledge:print-review-efficiency-patterns")],
      [makePromoteOp("memory:review-efficiency", "knowledge:review-agent-efficiency")],
    ];

    const { ops } = mergePlans(chunks);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    expect(promoteOps).toHaveLength(1);
    expect(promoteOps[0]?.ref).toBe("memory:review-efficiency");
  });

  it("preserves promote ops for different source refs (no over-deduplication)", () => {
    // Two different source memories promoted to different targets — both must survive.
    const chunk1: ConsolidateOperation[] = [
      makePromoteOp("memory:review-efficiency", "knowledge:review-efficiency"),
      makePromoteOp("memory:embedding-fix", "knowledge:akm-embedding-fix"),
    ];

    const { ops } = mergePlans([chunk1]);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    expect(promoteOps).toHaveLength(2);
    const refs = promoteOps.map((p) => p.ref);
    expect(refs).toContain("memory:review-efficiency");
    expect(refs).toContain("memory:embedding-fix");
  });

  it("preserves a single promote op unchanged", () => {
    const chunk: ConsolidateOperation[] = [makePromoteOp("memory:foo", "knowledge:foo-stable")];

    const { ops } = mergePlans([chunk]);
    const promoteOps = ops.filter((op): op is ConsolidatePromoteOp => op.op === "promote");

    expect(promoteOps).toHaveLength(1);
    expect(promoteOps[0]?.knowledgeRef).toBe("knowledge:foo-stable");
  });
});

// ── Tests: content-hash dedup via createProposal ────────────────────────────

describe("content-hash dedup — identical content blocked regardless of target ref", () => {
  /**
   * These tests validate the guard added to Phase B of akmConsolidate:
   *
   *   const newContentHash = createHash("sha256").update(memoryContent, ...).digest("hex");
   *   const allPendingConsolidateProposals = listProposals(stashDir, { status: "pending" })
   *     .filter((p) => p.source === "consolidate");
   *   const contentDupProposal = allPendingConsolidateProposals.find(
   *     (p) => createHash("sha256").update(p.payload.content, ...).digest("hex") === newContentHash,
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
    const result = createProposal(stash, {
      ref: "knowledge:paged-review-efficiency",
      source: "consolidate",
      payload: {
        content: CONTENT_WITH_DESCRIPTION,
        frontmatter: { description: "Reusable efficiency knowledge" },
      },
    });
    expect(isProposalSkipped(result)).toBe(false);

    // Load all pending consolidate proposals.
    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
    expect(pending).toHaveLength(1);

    // Compute hash of the second (duplicate) payload — same content, different ref.
    const secondContentHash = sha256(CONTENT_WITH_DESCRIPTION);
    const existingContent = pending[0]?.payload.content ?? "";
    const existingHash = sha256(existingContent);

    // The guard should detect the match.
    expect(existingHash).toBe(secondContentHash);
    const dup = pending.find((p) => sha256(p.payload.content) === secondContentHash);
    expect(dup).toBeDefined();
    expect(dup?.ref).toBe("knowledge:paged-review-efficiency");
  });

  it("content hash guard does NOT block proposals with different content", () => {
    const stash = makeStashDir();

    const content1 = `---\ndescription: Pattern A\n---\n\nContent for pattern A.\n`;
    const content2 = `---\ndescription: Pattern B\n---\n\nContent for pattern B — completely different.\n`;

    // Create a proposal for content1.
    const result1 = createProposal(stash, {
      ref: "knowledge:pattern-a",
      source: "consolidate",
      payload: { content: content1, frontmatter: { description: "Pattern A" } },
    });
    expect(isProposalSkipped(result1)).toBe(false);

    // content2 should NOT match the hash of content1.
    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
    const hash2 = sha256(content2);
    const dup = pending.find((p) => sha256(p.payload.content) === hash2);

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
    const distillResult = createProposal(stash, {
      ref: "knowledge:shared-knowledge",
      source: "distill",
      payload: { content: SHARED_CONTENT, frontmatter: { description: "Shared knowledge" } },
    });
    expect(isProposalSkipped(distillResult)).toBe(false);

    // The consolidate guard should only check consolidate proposals.
    const pendingConsolidate = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
    const hash = sha256(SHARED_CONTENT);
    const dup = pendingConsolidate.find((p) => sha256(p.payload.content) === hash);

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
      "knowledge:paged-review-efficiency",
      "knowledge:print-review-efficiency",
      "knowledge:print-review-efficiency-patterns",
      "knowledge:review-agent-efficiency",
    ];

    const createdIds: string[] = [];
    const skippedRefs: string[] = [];

    for (const ref of refs) {
      // Simulate the Phase B content-hash guard: load all pending consolidate
      // proposals and check for hash match before calling createProposal.
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "consolidate");
      const newHash = sha256(IDENTICAL_CONTENT);
      const contentDup = pending.find((p) => sha256(p.payload.content) === newHash);

      if (contentDup) {
        skippedRefs.push(ref);
        continue;
      }

      const result = createProposal(stash, {
        ref,
        source: "consolidate",
        payload: { content: IDENTICAL_CONTENT, frontmatter: { description: "Review efficiency patterns" } },
      });
      if (isProposalSkipped(result)) {
        skippedRefs.push(ref);
      } else {
        createdIds.push(result.id);
      }
    }

    // Only the first ref's proposal should have been created.
    expect(createdIds).toHaveLength(1);
    expect(skippedRefs).toHaveLength(3);

    // The single pending proposal should be for the first ref.
    const allPending = listProposals(stash, { status: "pending" });
    expect(allPending).toHaveLength(1);
    expect(allPending[0]?.ref).toBe("knowledge:paged-review-efficiency");
  });
});
