/**
 * Tests for the memory-inference pass (#201).
 *
 * The LLM client is never called for real — `splitMemoryIntoAtomicFacts` is
 * mocked via `mock.module` to return deterministic atomic-fact splits. These
 * tests cover:
 *   - pending detection (parent vs already-inferred vs already-processed)
 *   - the disabled-by-default path (no `akm.llm` configured)
 *   - the `index.memory.llm = false` opt-out
 *   - children written with `inferred: true` + `source:` backref
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
// the mutable `splitter` variable — each test sets it to whatever
// deterministic split it wants.

let splitter: (body: string) => string[] = () => [];

mock.module("../src/llm/memory-infer", () => ({
  splitMemoryIntoAtomicFacts: async (_config: unknown, body: string) => splitter(body),
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
  splitter = () => [];
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
    splitter = () => ["should not be called"];
    const result = await runMemoryInferencePass({ semanticSearchMode: "auto" }, sources());
    expect(result).toEqual({ considered: 0, splitParents: 0, writtenFacts: 0, skippedNoFacts: 0 });
  });

  test("returns no-op when index.memory.llm = false", async () => {
    const filePath = writeMemory("plain", {}, "Plain body, needs splitting.");
    splitter = () => ["should not be called"];
    const result = await runMemoryInferencePass(configOptedOut(), sources());
    expect(result.writtenFacts).toBe(0);
    // Existing inferred children are NOT deleted — but here we just confirm
    // the parent file is unchanged, since the toggle should not mutate state.
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(fm.data.inferenceProcessed).toBeUndefined();
  });

  test("toggling off after a previous run leaves existing inferred children intact", async () => {
    // First run: enabled. Splits one parent into two facts.
    writeMemory("parent", {}, "Body.");
    splitter = () => ["fact 1", "fact 2"];
    await runMemoryInferencePass(configWithLlm(), sources());

    const factsDir = path.join(tmpStash, "memories", "parent.facts");
    expect(fs.existsSync(path.join(factsDir, "fact-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(factsDir, "fact-2.md"))).toBe(true);

    // Second run: disabled. Children must remain on disk.
    splitter = () => {
      throw new Error("must not be called when disabled");
    };
    await runMemoryInferencePass(configOptedOut(), sources());
    expect(fs.existsSync(path.join(factsDir, "fact-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(factsDir, "fact-2.md"))).toBe(true);
  });
});

// ── runMemoryInferencePass — orthogonal gating (§14 + #208) ─────────────────

describe("runMemoryInferencePass — feature flag and per-pass key are orthogonal", () => {
  test("runs when both gates allow (feature on, per-pass on)", async () => {
    writeMemory("parent", {}, "Body.");
    splitter = () => ["fact 1"];
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
    splitter = () => {
      invocations += 1;
      return ["should never be called"];
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
    splitter = () => {
      invocations += 1;
      return ["should never be called"];
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
  test("writes atomic children with `inferred: true` and `source:` backref", async () => {
    writeMemory("parent", { description: "before" }, "Two facts in one body.");
    splitter = () => ["First atomic fact.", "Second atomic fact."];

    const result = await runMemoryInferencePass(configWithLlm(), sources());

    expect(result).toEqual({
      considered: 1,
      splitParents: 1,
      writtenFacts: 2,
      skippedNoFacts: 0,
    });

    const factsDir = path.join(tmpStash, "memories", "parent.facts");
    const child1 = parseFrontmatter(fs.readFileSync(path.join(factsDir, "fact-1.md"), "utf8"));
    expect(child1.data.inferred).toBe(true);
    expect(child1.data.source).toBe("memory:parent");
    expect(child1.content.trim()).toBe("First atomic fact.");

    const child2 = parseFrontmatter(fs.readFileSync(path.join(factsDir, "fact-2.md"), "utf8"));
    expect(child2.data.inferred).toBe(true);
    expect(child2.data.source).toBe("memory:parent");
    expect(child2.content.trim()).toBe("Second atomic fact.");
  });

  test("marks parent with inferenceProcessed: true and preserves prior frontmatter", async () => {
    const filePath = writeMemory("parent", { description: "preserve me", tags: "[a, b]" }, "Body.");
    splitter = () => ["only fact"];

    await runMemoryInferencePass(configWithLlm(), sources());

    const parentFm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(parentFm.data.inferenceProcessed).toBe(true);
    expect(parentFm.data.description).toBe("preserve me");
  });

  test("re-running the pass is idempotent — no duplicate splits", async () => {
    writeMemory("parent", {}, "Body.");
    let calls = 0;
    splitter = () => {
      calls += 1;
      return ["fact A", "fact B"];
    };

    await runMemoryInferencePass(configWithLlm(), sources());
    await runMemoryInferencePass(configWithLlm(), sources());

    // Second invocation must not call the splitter — the parent is already
    // marked `inferenceProcessed: true`.
    expect(calls).toBe(1);

    const factsDir = path.join(tmpStash, "memories", "parent.facts");
    const childFiles = fs
      .readdirSync(factsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(childFiles).toEqual(["fact-1.md", "fact-2.md"]);
  });

  test("inferred children are themselves filtered out — they don't get re-split", async () => {
    writeMemory("parent", {}, "Body.");
    splitter = () => ["c1", "c2"];
    await runMemoryInferencePass(configWithLlm(), sources());

    // Now reset the splitter to verify a second run finds no pending memories.
    let secondRunInvocations = 0;
    splitter = () => {
      secondRunInvocations += 1;
      return ["should not happen"];
    };
    const second = await runMemoryInferencePass(configWithLlm(), sources());
    expect(secondRunInvocations).toBe(0);
    expect(second.considered).toBe(0);
    expect(second.writtenFacts).toBe(0);
  });

  test("LLM returning zero facts leaves the parent unprocessed (retried next run)", async () => {
    const filePath = writeMemory("parent", {}, "Body.");
    splitter = () => [];

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
      splitter = () => ["primary fact"];

      const result = await runMemoryInferencePass(configWithLlm(), [{ path: tmpStash }, { path: cacheDir }]);

      // Only the primary parent was considered.
      expect(result.considered).toBe(1);
      expect(result.writtenFacts).toBe(1);
      // No `cache-parent.facts` directory should have been created.
      expect(fs.existsSync(path.join(cacheDir, "memories", "cache-parent.facts"))).toBe(false);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
