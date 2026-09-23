/**
 * R5 (b) tier1-0917: consolidate re-judged memories that were already
 * promoted verbatim into `knowledge/`. Before this fix, that duplication was
 * discovered only after the LLM (`shouldSkipPromotionBodyDuplicate`), so a
 * pool where ~84% of memories were already-promoted duplicates still paid
 * the full chunk/LLM cost for all of them before being skipped.
 *
 * This file tests the pre-filter (`narrowConsolidationPool`, via the public
 * `akmConsolidate` entry point): a memory whose body already exists verbatim
 * in `knowledge/` is dropped BEFORE chunking, is counted in
 * `result.prefilteredAlreadyPromoted`, and never reaches the LLM chunk loop
 * (so it cannot appear in `processed`, `judgedNoAction`, or
 * `failedChunkMemories`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmConsolidate, loadExistingKnowledgeBodyHashes } from "../../../src/commands/improve/consolidate";
import { cacheHash } from "../../../src/commands/improve/content-hash";
import type { AkmConfig } from "../../../src/core/config/config";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let cleanup: Cleanup;
let stashDir: string;

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
});

afterEach(() => cleanup());

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

function writeKnowledge(name: string, body: string): void {
  const filePath = path.join(stashDir, "knowledge", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

// No LLM configured and no embedding (clustering is a no-op): any memory
// that reaches the chunk loop lands in `failedChunkMemories` instead of
// silently succeeding, so the test can tell "reached chunking" apart from
// "pre-filtered" without mocking an LLM response.
const CONFIG = {
  semanticSearchMode: "off",
  profiles: { improve: { default: { processes: { consolidate: { enabled: true } } } } },
} as unknown as AkmConfig;

describe("akmConsolidate — pre-filter already-promoted memories before chunking (R5 tier1-0917)", () => {
  test("a memory whose body already exists in knowledge/ is dropped before chunking; the other memory still reaches it", async () => {
    writeMemory("dup-a", "Duplicate body content that is long enough to matter.");
    writeMemory("new-b", "Brand new body content that is long enough to matter.");
    writeKnowledge(
      "already-promoted",
      "---\ndescription: already promoted copy\ntags: [x]\n---\n\nDuplicate body content that is long enough to matter.\n",
    );

    const result = await akmConsolidate({ stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.prefilteredAlreadyPromoted).toBe(1);
    // Only new-b reaches the chunk/LLM path; dup-a never enters `processed`.
    expect(result.processed).toBe(1);
    expect(result.failedChunkMemories).toBe(1);
    expect(result.warnings.some((w) => w.includes("pre-filtered 1 memory") && w.includes("knowledge/"))).toBe(true);
  });

  test("no knowledge/ duplicates means prefilteredAlreadyPromoted is 0 and both memories reach chunking", async () => {
    writeMemory("only-a", "First body content that is long enough to matter.");
    writeMemory("only-b", "Second body content that is long enough to matter.");

    const result = await akmConsolidate({ stashDir, config: CONFIG });

    expect(result.ok).toBe(true);
    expect(result.prefilteredAlreadyPromoted).toBe(0);
    expect(result.processed).toBe(2);
  });

  test("loadExistingKnowledgeBodyHashes and cacheHash agree on the same body despite frontmatter/whitespace differences", () => {
    writeKnowledge(
      "already-promoted",
      "---\ndescription: promoted copy\ntags: [a, b]\n---\n\nShared canonical body text.\n\n",
    );
    const existingHashes = loadExistingKnowledgeBodyHashes(stashDir);

    // Same body, different frontmatter and surrounding whitespace — the
    // shape a source memory takes relative to its promoted knowledge copy.
    const memoryBody = "---\ndescription: source memory\ncaptureMode: hot\n---\n\n  Shared canonical body text.  \n";
    expect(existingHashes.has(cacheHash(memoryBody))).toBe(true);
  });
});
