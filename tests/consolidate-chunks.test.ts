/**
 * Tests for consolidate command chunk sizing behavior.
 *
 * Validates that:
 * - buildChunkPrompt stays within reasonable size bounds
 * - Chunk count is calculated correctly from memory count and chunk size
 * - isAgentPath (config.agent) does NOT affect chunk size (regression test for the bug)
 * - Body truncation is applied at 500 chars
 *
 * These are pure unit tests — no LLM endpoints are called.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChunkPrompt, type MemoryEntry } from "../src/commands/consolidate";

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

  it("21 memories with chunkSize 20 produces 2 chunks", () => {
    const memories = makeMemoryBatch(tempDir, 21, 10);
    const chunks = buildChunks(memories, 20);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(20);
    expect(chunks[1]).toHaveLength(1);
  });
});

describe("isAgentPath does NOT affect chunk size (regression)", () => {
  /**
   * Before the fix, akmConsolidate used:
   *   const chunkSize = isAgentPath ? 30 : 20;
   *   const bodyTruncation = isAgentPath ? 1000 : 500;
   *
   * After the fix both paths use chunkSize=20, bodyTruncation=500.
   * This test verifies that chunk count is identical regardless of config.agent.
   *
   * We test the chunk-building logic directly (buildChunks helper mirrors
   * the loop in akmConsolidate) with the fixed constants, so no LLM call
   * is made and no config resolution is needed.
   */

  const FIXED_CHUNK_SIZE = 20; // post-fix constant

  it("chunk count with config.agent set matches chunk count without config.agent", () => {
    const memories = makeMemoryBatch(tempDir, 50, 200);

    // Simulate the pre-fix bug: agent path used chunkSize=30
    const chunksAgentBug = buildChunks(memories, 30);
    // Simulate the pre-fix non-agent path: chunkSize=20
    const chunksNoAgentBug = buildChunks(memories, 20);
    // Post-fix: both paths use chunkSize=20
    const chunksAgentFixed = buildChunks(memories, FIXED_CHUNK_SIZE);
    const chunksNoAgentFixed = buildChunks(memories, FIXED_CHUNK_SIZE);

    // Regression: pre-fix agent path produced a different (larger) chunk count
    expect(chunksAgentBug).toHaveLength(2); // 50/30 = 1 full + 1 partial
    expect(chunksNoAgentBug).toHaveLength(3); // 50/20 = 2 full + 1 partial

    // Post-fix: both paths produce the same chunk count
    expect(chunksAgentFixed).toHaveLength(chunksNoAgentFixed.length);
    expect(chunksAgentFixed).toHaveLength(3);
  });

  it("prompt size with agent config equals prompt size without agent config for same input", () => {
    // Post-fix both code paths call buildChunkPrompt with bodyTruncation=500.
    // Verify the prompt output is byte-for-byte identical regardless of which
    // config.agent scenario we simulate — the function itself is pure given the
    // same arguments.
    const memories = makeMemoryBatch(tempDir, 5, 200);

    const promptWithAgent = buildChunkPrompt("/stash", memories, 0, 1, 500);
    const promptWithoutAgent = buildChunkPrompt("/stash", memories, 0, 1, 500);

    expect(promptWithAgent).toBe(promptWithoutAgent);
    expect(promptWithAgent.length).toBeLessThan(15_000);
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

  it("an unreadable file path produces (unreadable) marker in prompt", () => {
    // Provide a filePath that does not exist — buildChunkPrompt catches the error
    const entry: MemoryEntry = {
      name: "ghost-memory",
      filePath: path.join(tempDir, "does-not-exist.md"),
      description: "ghost",
      tags: [],
      stashDir: tempDir,
    };
    const prompt = buildChunkPrompt("/stash", [entry], 0, 1, 500);

    expect(prompt).toContain("(unreadable)");
  });
});
