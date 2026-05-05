/**
 * Tests for the memory-inference pass (#201).
 *
 * The LLM client is never called for real — `compressMemoryToDerivedMemory` is
 * mocked via `mock.module` to return deterministic derived-memory drafts. These
 * tests cover:
 *   - pending detection (parent vs already-inferred vs already-processed)
 *   - the disabled-by-default path (no `akm.llm` configured)
 *   - the `index.memory.llm = false` opt-out
 *   - derived memories written with `inferred: true` + `source:` backref
 *   - re-running the pass is idempotent (no duplicate children, parent stays
 *     processed, inferred children are not deleted when toggled off)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../src/core/config";
import { parseFrontmatter } from "../src/core/frontmatter";
import type { SearchSource } from "../src/indexer/search-source";

// ── Module-level LLM stub ───────────────────────────────────────────────────
//
// `mock.module` must run before the module under test is imported, so we set
// up the stub here at the top of the file. The behaviour is controlled by
// the mutable `compressor` variable — each test sets it to whatever
// deterministic draft it wants.

type Draft = {
  title: string;
  description: string;
  tags: string[];
  searchHints: string[];
  content: string;
};

let compressor: (body: string) => Draft | undefined = () => undefined;

mock.module("../src/llm/memory-infer", () => ({
  compressMemoryToDerivedMemory: async (_config: unknown, body: string) => compressor(body),
}));

// Import AFTER mock.module so the pass picks up the stub.
const { runMemoryInferencePass, isPendingMemory, collectPendingMemories } = await import(
  "../src/indexer/memory-inference"
);

// ── Test fixtures ───────────────────────────────────────────────────────────

let tmpStash = "";

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-memory-infer-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  compressor = () => undefined;
});

afterEach(() => {
  if (tmpStash) {
    fs.rmSync(tmpStash, { recursive: true, force: true });
    tmpStash = "";
  }
});

function writeMemory(name: string, frontmatter: Record<string, unknown>, body: string): string {
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    fmLines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  fmLines.push("---");
  const content = `${fmLines.join("\n")}\n\n${body}\n`;
  const filePath = path.join(tmpStash, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

const SAMPLE_LLM = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

function configWithLlm(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    llm: { ...SAMPLE_LLM },
  };
}

function configOptedOut(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    llm: { ...SAMPLE_LLM },
    index: { memory: { llm: false } },
  };
}

function sources(): SearchSource[] {
  return [{ path: tmpStash }];
}

function sampleDraft(title = "Derived Insight"): Draft {
  return {
    title,
    description: "Why this derived memory matters.",
    tags: ["memory", "derived", "test"],
    searchHints: ["find derived memory", "memory inference output", "compressed memory summary"],
    content: "## Summary\n\nUseful compressed content.",
  };
}

// ── isPendingMemory predicate ───────────────────────────────────────────────

describe("isPendingMemory", () => {
  test("plain memory with no inference markers is pending", () => {
    expect(isPendingMemory({ description: "anything" })).toBe(true);
  });

  test("inferred children are not pending", () => {
    expect(isPendingMemory({ inferred: true, source: "memory:parent" })).toBe(false);
  });

  test("memory already marked processed is not pending", () => {
    expect(isPendingMemory({ inferenceProcessed: true })).toBe(false);
  });

  test("inference markers must be literal `true` — non-boolean is treated as not-set", () => {
    expect(isPendingMemory({ inferred: "yes" })).toBe(true);
    expect(isPendingMemory({ inferenceProcessed: 1 })).toBe(true);
  });
});

// ── collectPendingMemories ──────────────────────────────────────────────────

describe("collectPendingMemories", () => {
  test("returns empty when memories/ does not exist", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "akm-mi-empty-"));
    try {
      expect(collectPendingMemories(fresh)).toEqual([]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("walks markdown files and filters by predicate", () => {
    writeMemory("plain", {}, "Plain body, needs splitting.");
    writeMemory("already-inferred", { inferred: true, source: "memory:plain" }, "Atomic.");
    writeMemory("already-processed", { inferenceProcessed: true }, "Already split.");
    writeMemory("nested/sub", {}, "Nested memory body.");
    // A non-markdown file under memories/ must be ignored.
    fs.writeFileSync(path.join(tmpStash, "memories", "notes.txt"), "ignore me");

    const pending = collectPendingMemories(tmpStash);
    const names = pending.map((p) => p.ref).sort();
    expect(names).toEqual(["memory:nested/sub", "memory:plain"]);
  });
});

// ── runMemoryInferencePass — disabled paths ─────────────────────────────────

describe("runMemoryInferencePass — disabled by default", () => {
  test("returns no-op when no akm.llm is configured", async () => {
    writeMemory("plain", {}, "Plain body, needs splitting.");
    compressor = () => sampleDraft();
    const result = await runMemoryInferencePass({ semanticSearchMode: "auto" }, sources());
    expect(result).toEqual({ considered: 0, splitParents: 0, writtenFacts: 0, skippedNoFacts: 0 });
  });

  test("returns no-op when index.memory.llm = false", async () => {
    const filePath = writeMemory("plain", {}, "Plain body, needs splitting.");
    compressor = () => sampleDraft();
    const result = await runMemoryInferencePass(configOptedOut(), sources());
    expect(result.writtenFacts).toBe(0);
    // Existing inferred children are NOT deleted — but here we just confirm
    // the parent file is unchanged, since the toggle should not mutate state.
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(fm.data.inferenceProcessed).toBeUndefined();
  });

  test("toggling off after a previous run leaves existing inferred children intact", async () => {
    // First run: enabled. Writes one derived memory.
    writeMemory("parent", {}, "Body.");
    compressor = () => sampleDraft();
    await runMemoryInferencePass(configWithLlm(), sources());

    const derivedPath = path.join(tmpStash, "memories", "parent.derived.md");
    expect(fs.existsSync(derivedPath)).toBe(true);

    // Second run: disabled. Children must remain on disk.
    compressor = () => {
      throw new Error("must not be called when disabled");
    };
    await runMemoryInferencePass(configOptedOut(), sources());
    expect(fs.existsSync(derivedPath)).toBe(true);
  });
});

// ── runMemoryInferencePass — orthogonal gating (§14 + #208) ─────────────────

describe("runMemoryInferencePass — feature flag and per-pass key are orthogonal", () => {
  test("runs when both gates allow (feature on, per-pass on)", async () => {
    writeMemory("parent", {}, "Body.");
    compressor = () => sampleDraft();
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM, features: { memory_inference: true } },
      // index.memory.llm omitted → defaults to enabled.
    };
    const result = await runMemoryInferencePass(cfg, sources());
    expect(result.writtenFacts).toBe(1);
    expect(result.splitParents).toBe(1);
  });

  test("skipped when llm.features.memory_inference = false even with index.memory.llm enabled", async () => {
    const filePath = writeMemory("parent", {}, "Body.");
    let invocations = 0;
    compressor = () => {
      invocations += 1;
      return sampleDraft();
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM, features: { memory_inference: false } },
      index: { memory: { llm: true } },
    };
    const result = await runMemoryInferencePass(cfg, sources());
    expect(result).toEqual({ considered: 0, splitParents: 0, writtenFacts: 0, skippedNoFacts: 0 });
    expect(invocations).toBe(0);
    // Parent is not mutated when the feature gate blocks.
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(fm.data.inferenceProcessed).toBeUndefined();
  });

  test("skipped when index.memory.llm = false even with llm.features.memory_inference = true", async () => {
    const filePath = writeMemory("parent", {}, "Body.");
    let invocations = 0;
    compressor = () => {
      invocations += 1;
      return sampleDraft();
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM, features: { memory_inference: true } },
      index: { memory: { llm: false } },
    };
    const result = await runMemoryInferencePass(cfg, sources());
    expect(result.writtenFacts).toBe(0);
    expect(invocations).toBe(0);
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(fm.data.inferenceProcessed).toBeUndefined();
  });
});

// ── runMemoryInferencePass — enabled path ───────────────────────────────────

describe("runMemoryInferencePass — enabled", () => {
  test("writes one derived memory with rich metadata, `inferred: true`, and `source:` backref", async () => {
    writeMemory("parent", { description: "before" }, "Two facts in one body.");
    compressor = () => ({
      title: "Compressed Parent Insight",
      description: "A higher-signal summary of the parent.",
      tags: ["one", "two", "three"],
      searchHints: ["compressed parent", "derived memory", "higher signal summary"],
      content: "## Root Cause\n\nThe parent had too much noise.\n\n## Reusable Insight\n\nKeep the compressed version.",
    });

    const result = await runMemoryInferencePass(configWithLlm(), sources());

    expect(result).toEqual({
      considered: 1,
      splitParents: 1,
      writtenFacts: 1,
      skippedNoFacts: 0,
    });

    const derived = parseFrontmatter(fs.readFileSync(path.join(tmpStash, "memories", "parent.derived.md"), "utf8"));
    expect(derived.data.inferred).toBe(true);
    expect(derived.data.source).toBe("memory:parent");
    expect(derived.data.description).toBe("A higher-signal summary of the parent.");
    expect(derived.data.tags).toEqual(["one", "two", "three"]);
    expect(derived.data.searchHints).toEqual(["compressed parent", "derived memory", "higher signal summary"]);
    expect(derived.data.title).toBe("Compressed Parent Insight");
    expect(derived.data.derivedFrom).toBe("parent");
    expect(derived.content).toContain("# Compressed Parent Insight");
    expect(derived.content).toContain("## Root Cause");
  });

  test("marks parent with inferenceProcessed: true and preserves prior frontmatter", async () => {
    const filePath = writeMemory("parent", { description: "preserve me", tags: "[a, b]" }, "Body.");
    compressor = () => sampleDraft();

    await runMemoryInferencePass(configWithLlm(), sources());

    const parentFm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(parentFm.data.inferenceProcessed).toBe(true);
    expect(parentFm.data.description).toBe("preserve me");
  });

  test("re-running the pass is idempotent — no duplicate splits", async () => {
    writeMemory("parent", {}, "Body.");
    let calls = 0;
    compressor = () => {
      calls += 1;
      return sampleDraft();
    };

    await runMemoryInferencePass(configWithLlm(), sources());
    await runMemoryInferencePass(configWithLlm(), sources());

    // Second invocation must not call the splitter — the parent is already
    // marked `inferenceProcessed: true`.
    expect(calls).toBe(1);

    expect(fs.existsSync(path.join(tmpStash, "memories", "parent.derived.md"))).toBe(true);
  });

  test("derived children are themselves filtered out — they don't get re-processed", async () => {
    writeMemory("parent", {}, "Body.");
    compressor = () => sampleDraft();
    await runMemoryInferencePass(configWithLlm(), sources());

    // Now reset the compressor to verify a second run finds no pending memories.
    let secondRunInvocations = 0;
    compressor = () => {
      secondRunInvocations += 1;
      return sampleDraft();
    };
    const second = await runMemoryInferencePass(configWithLlm(), sources());
    expect(secondRunInvocations).toBe(0);
    expect(second.considered).toBe(0);
    expect(second.writtenFacts).toBe(0);
  });

  test("LLM returning no derived memory leaves the parent unprocessed (retried next run)", async () => {
    const filePath = writeMemory("parent", {}, "Body.");
    compressor = () => undefined;

    const result = await runMemoryInferencePass(configWithLlm(), sources());
    expect(result.skippedNoFacts).toBe(1);
    expect(result.splitParents).toBe(0);
    expect(result.writtenFacts).toBe(0);

    // Parent must NOT be marked processed — a transient empty response
    // should be retried on the next `akm index`.
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(fm.data.inferenceProcessed).toBeUndefined();
  });

  test("does not write under cache-only sources (only the primary stash)", async () => {
    // Add a second source dir simulating a read-only cache. The pass must
    // ignore it: only sources[0] (primary stash) is writable.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-mi-cache-"));
    fs.mkdirSync(path.join(cacheDir, "memories"), { recursive: true });
    const cacheParent = path.join(cacheDir, "memories", "cache-parent.md");
    fs.writeFileSync(cacheParent, "---\n---\n\nCache body.\n");

    try {
      writeMemory("primary", {}, "Primary body.");
      compressor = () => sampleDraft();

      const result = await runMemoryInferencePass(configWithLlm(), [{ path: tmpStash }, { path: cacheDir }]);

      // Only the primary parent was considered.
      expect(result.considered).toBe(1);
      expect(result.writtenFacts).toBe(1);
      // No derived memory should have been created under the cache-only source.
      expect(fs.existsSync(path.join(cacheDir, "memories", "cache-parent.derived.md"))).toBe(false);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
