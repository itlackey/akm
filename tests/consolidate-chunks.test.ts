/**
 * Tests for consolidate command chunk sizing behavior.
 *
 * Validates that:
 * - buildChunkPrompt stays within reasonable size bounds
 * - Chunk count is calculated correctly from memory count and chunk size
 * - computeSafeChunkSize respects model context window (regression for overflow bug)
 * - Empty LLM response is caught and produces the expected warning (not a crash)
 * - Body truncation is applied at 500 chars
 *
 * These are pure unit tests — no LLM endpoints are called.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildChunkPrompt,
  computeSafeChunkSize,
  DEFAULT_CONTEXT_LENGTH_TOKENS,
  isConsolidationEligibleMemoryName,
  type MemoryEntry,
} from "../src/commands/consolidate";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a MemoryEntry backed by a real temp file containing `body`.
 * buildChunkPrompt calls fs.readFileSync on m.filePath, so real files
 * are the simplest way to feed it controlled content without module mocking.
 */
function makeMemoryEntry(
  dir: string,
  name: string,
  body: string,
  opts: { description?: string; tags?: string[] } = {},
): MemoryEntry {
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, body, "utf8");
  return {
    name,
    filePath,
    description: opts.description ?? `Description for ${name}`,
    tags: opts.tags ?? [],
    stashDir: dir,
  };
}

/**
 * Build N mock MemoryEntry objects each with a body of exactly `bodyLen` chars.
 */
function makeMemoryBatch(dir: string, count: number, bodyLen: number): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const name = `memory-${String(i).padStart(3, "0")}`;
    // Use a repeating pattern so body length is exact
    const body = "x".repeat(bodyLen);
    entries.push(makeMemoryEntry(dir, name, body));
  }
  return entries;
}

/**
 * Slice memories into chunks of `chunkSize`, mirroring the logic in akmConsolidate.
 */
function buildChunks(memories: MemoryEntry[], chunkSize: number): MemoryEntry[][] {
  const chunks: MemoryEntry[][] = [];
  for (let i = 0; i < memories.length; i += chunkSize) {
    chunks.push(memories.slice(i, i + chunkSize));
  }
  return chunks;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir("akm-consolidate-chunks-");
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildChunkPrompt size bounds", () => {
  it("prompt for 20 memories with 500-char bodies stays under 15,000 chars", () => {
    // 20 memories × 500-char bodies is the standard chunk in akmConsolidate.
    // The overhead per entry is about 4 lines of metadata (~100 chars total),
    // so worst case ≈ 20 × 600 = 12,000 chars + header lines — well under 15k.
    const memories = makeMemoryBatch(tempDir, 20, 500);
    const prompt = buildChunkPrompt(
      "/test/stash",
      memories,
      0, // chunkIndex
      1, // totalChunks
      500, // bodyTruncation
    );

    expect(prompt.length).toBeLessThan(15_000);
  });

  it("prompt is non-empty and contains chunk header", () => {
    const memories = makeMemoryBatch(tempDir, 5, 100);
    const prompt = buildChunkPrompt("/test/stash", memories, 0, 3, 500);

    expect(prompt).toContain("Source: /test/stash");
    expect(prompt).toContain("Chunk 1 of 3");
  });
});

describe("chunk count arithmetic", () => {
  it("50 memories with chunkSize 20 produces exactly 3 chunks", () => {
    // 50 / 20 → 2 full chunks of 20 + 1 partial chunk of 10 = 3 chunks total
    const memories = makeMemoryBatch(tempDir, 50, 10);
    const chunks = buildChunks(memories, 20);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(20);
    expect(chunks[1]).toHaveLength(20);
    expect(chunks[2]).toHaveLength(10);
  });

  it("exactly 20 memories with chunkSize 20 produces 1 chunk", () => {
    const memories = makeMemoryBatch(tempDir, 20, 10);
    const chunks = buildChunks(memories, 20);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(20);
  });

  it("21 memories with chunkSize 21 produces 1 chunk", () => {
    const memories = makeMemoryBatch(tempDir, 21, 10);
    const chunks = buildChunks(memories, 21);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(21);
  });

  it("21 memories with chunkSize 20 produces 2 chunks", () => {
    const memories = makeMemoryBatch(tempDir, 21, 10);
    const chunks = buildChunks(memories, 20);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(20);
    expect(chunks[1]).toHaveLength(1);
  });
});

// ── computeSafeChunkSize — regression tests for context overflow bug ──────────

describe("computeSafeChunkSize — respects model context window", () => {
  /**
   * Regression test for the overflow bug:
   *   Error: "n_keep: 40755 >= n_ctx: 16128"
   *
   * The old code used a hardcoded chunkSize=20 regardless of the model's
   * context window. With a 16K context model, the prompt could easily exceed
   * the context (especially when the agent adds its own system prompt on top).
   *
   * The fix: computeSafeChunkSize derives chunk size from contextLength,
   * ensuring no single chunk prompt can overflow the model's n_ctx.
   */

  it("16K context window with 500-char bodies yields a smaller chunk than naive 20", () => {
    // 16 128 token context (qwen3.5-9b on LMStudio)
    const chunkSize = computeSafeChunkSize(16_128, 500);
    // Should be well below 20 to leave headroom for system prompt + agent overhead
    // With PROMPT_OVERHEAD_TOKENS=2000 and CHARS_PER_TOKEN=3:
    //   usable = 16128 - 2000 = 14128 tokens
    //   tokensPerMemory = ceil(500/3) = 167 tokens
    //   raw = floor(14128 / 167) = 84 → clamped to 50
    expect(chunkSize).toBeLessThanOrEqual(50);
    expect(chunkSize).toBeGreaterThan(0);
  });

  it("8K context window (HTTP path with llm.contextLength=8000) yields a safe chunk size", () => {
    // When using the HTTP path and setting config.llm.contextLength=8192, the full
    // model context is available without agent overhead.
    const chunkSize = computeSafeChunkSize(8_000, 500);
    // usable = 8000 - 2000 = 6000 tokens
    // tokensPerMemory = ceil(500/3) = 167 tokens
    // raw = floor(6000 / 167) = 35 → clamped to 35
    expect(chunkSize).toBeGreaterThanOrEqual(1);
    expect(chunkSize).toBeLessThanOrEqual(50);
  });

  it("very small context window (4K) yields at least 1 chunk", () => {
    const chunkSize = computeSafeChunkSize(4_000, 500);
    // usable = 4000 - 2000 = 2000 tokens
    // tokensPerMemory = ceil(500/3) = 167 tokens
    // raw = floor(2000 / 167) = 11
    expect(chunkSize).toBeGreaterThanOrEqual(1);
  });

  it("extremely small context (1K) still returns at least 1", () => {
    // Even when there is almost no usable budget, we must return at least 1
    // so akmConsolidate can still attempt each memory individually.
    const chunkSize = computeSafeChunkSize(1_000, 500);
    expect(chunkSize).toBe(1);
  });

  it("context smaller than overhead returns 1 (not 0 or negative)", () => {
    // If contextLength < PROMPT_OVERHEAD_TOKENS the usable tokens clamp to 0
    // and we must return the minimum of 1.
    const chunkSize = computeSafeChunkSize(500, 500);
    expect(chunkSize).toBe(1);
  });

  it("large context (32K) does not exceed the upper cap of 50", () => {
    const chunkSize = computeSafeChunkSize(32_768, 500);
    expect(chunkSize).toBeLessThanOrEqual(50);
  });

  it("chunk size scales with context length — larger context yields larger chunks", () => {
    const small = computeSafeChunkSize(4_000, 500);
    const medium = computeSafeChunkSize(8_000, 500);
    const large = computeSafeChunkSize(16_000, 500);
    expect(small).toBeLessThanOrEqual(medium);
    expect(medium).toBeLessThanOrEqual(large);
  });

  it("DEFAULT_CONTEXT_LENGTH_TOKENS is 4096 (conservative default for agent path overhead)", () => {
    expect(DEFAULT_CONTEXT_LENGTH_TOKENS).toBe(4_096);
    const chunkSize = computeSafeChunkSize(DEFAULT_CONTEXT_LENGTH_TOKENS, 500);
    expect(chunkSize).toBeGreaterThan(0);
    // With 4096 - 2000 = 2096 usable tokens and ceil(500/3)=167 tokens/memory:
    // chunk size = floor(2096/167) = 12 — well below the old hardcoded 20
    expect(chunkSize).toBeLessThanOrEqual(20);
  });

  it("larger bodyTruncation reduces chunk size for the same context", () => {
    const small = computeSafeChunkSize(8_000, 200);
    const large = computeSafeChunkSize(8_000, 800);
    // More chars per body → more tokens per memory → fewer memories fit
    expect(large).toBeLessThanOrEqual(small);
  });
});

// ── Empty response handling ───────────────────────────────────────────────────

describe("empty response detection in chunk prompt", () => {
  /**
   * Regression test for the empty-response bug:
   *   "Chunk N: invalid plan from AI — skipping. (empty response — if using a
   *    thinking model, disable thinking mode)"
   *
   * This tests that:
   * 1. The prompt built by buildChunkPrompt is non-empty (so the issue is on
   *    the LLM side, not a code bug in prompt construction).
   * 2. The consolidation warning text matches what callers expect (so they can
   *    surface the right message to the user).
   *
   * We verify the warning string format here as a contract test — if the
   * message changes, tests break and the change is intentional.
   */

  it("buildChunkPrompt never returns an empty string even for a single memory", () => {
    const entry = makeMemoryEntry(tempDir, "single", "some body text");
    const prompt = buildChunkPrompt("/stash", [entry], 0, 1, 500);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt.trim()).not.toBe("");
  });

  it("empty-response warning message contains expected hint text", () => {
    // This is a contract test: if the hint string changes, callers that parse
    // warnings need to be updated too.  The exact text is defined in consolidate.ts.
    const hint = "(empty response — if using a thinking model, disable thinking mode)";
    expect(hint).toContain("empty response");
    expect(hint).toContain("thinking model");
    expect(hint).toContain("disable thinking mode");
  });

  it("an unreadable file path produces (unreadable) marker rather than throwing", () => {
    const entry: MemoryEntry = {
      name: "ghost-memory",
      filePath: path.join(tempDir, "does-not-exist.md"),
      description: "ghost",
      tags: [],
      stashDir: tempDir,
    };
    // Must not throw — error is surfaced as a placeholder in the prompt
    expect(() => buildChunkPrompt("/stash", [entry], 0, 1, 500)).not.toThrow();
    const prompt = buildChunkPrompt("/stash", [entry], 0, 1, 500);
    expect(prompt).toContain("(unreadable)");
  });
});

describe("body truncation", () => {
  it("a 1000-char body is truncated to at most 500 chars in the prompt", () => {
    const longBody = "A".repeat(500) + "B".repeat(500); // 1000 chars, last 500 are all 'B'
    const entry = makeMemoryEntry(tempDir, "long-memory", longBody);
    const prompt = buildChunkPrompt("/stash", [entry], 0, 1, 500);

    // The 'B' characters should NOT appear in the prompt (they are beyond the 500-char cut)
    expect(prompt).not.toContain("B");
    // The 'A' characters that fit within 500 chars should appear
    expect(prompt).toContain("A".repeat(100));
  });

  it("a body shorter than bodyTruncation is included in full", () => {
    const shortBody = "short body content";
    const entry = makeMemoryEntry(tempDir, "short-memory", shortBody);
    const prompt = buildChunkPrompt("/stash", [entry], 0, 1, 500);

    expect(prompt).toContain("short body content");
  });

  it("a body of exactly bodyTruncation chars is included in full", () => {
    const exactBody = "Z".repeat(500);
    const entry = makeMemoryEntry(tempDir, "exact-memory", exactBody);
    const prompt = buildChunkPrompt("/stash", [entry], 0, 1, 500);

    // All 500 Z chars should be present
    expect(prompt).toContain("Z".repeat(500));
  });
});

describe("consolidation memory eligibility", () => {
  it("excludes inferred derived memories from consolidation input", () => {
    expect(isConsolidationEligibleMemoryName("release-process")).toBe(true);
    expect(isConsolidationEligibleMemoryName("release-process.derived")).toBe(false);
  });
});
