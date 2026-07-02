/**
 * #581 — judged-state cache for nightly consolidation.
 *
 * The cache lets one consolidation run sweep the FULL corpus cheaply by
 * SKIPPING memories already judged with unchanged content, instead of narrowing
 * to a recent time-window slice. After the LLM judges a chunk, every memory it
 * saw has its (entry_key, content_hash, outcome) recorded; on the next run a
 * memory whose current content hash equals the cached hash is dropped from the
 * LLM pool (judged-unchanged → no re-judge). A memory whose body changed (new
 * hash) re-enters the pool.
 *
 * GATE: behind `processes.consolidate.judgedCache.enabled` → mapped onto the
 * `akmConsolidate({ judgedCache })` option (DEFAULT TRUE). Pass
 * `{ enabled: false }` to opt out. With the cache OFF, behaviour is
 * byte-identical to a full-pool run.
 *
 * The LLM transport is stubbed via `mock.module` so no network is touched and
 * we can count judge calls. A module-level `stubMode` switches the stub between
 * a valid empty plan (the LLM saw the chunk and proposed nothing) and a thrown
 * transport failure, without re-registering the mock mid-test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// ── Module-level LLM stub ───────────────────────────────────────────────────
//
// `mock.module` must run before the module under test is imported. `chatCalls`
// counts judge calls (one per judged chunk); `stubMode` controls success vs
// failure so a single registered mock covers both paths.
let chatCalls = 0;
let stubMode: "ok" | "throw" = "ok";
mock.module("../../../src/llm/client", () => {
  const actual = require("../../../src/llm/client");
  return {
    ...actual,
    chatCompletion: async () => {
      chatCalls += 1;
      if (stubMode === "throw") throw new Error("simulated transport failure");
      // Valid empty plan: the model saw the chunk and proposed no operations.
      return JSON.stringify({ operations: [] });
    },
  };
});

import { akmConsolidate } from "../../../src/commands/improve/consolidate";
import type { AkmConfig } from "../../../src/core/config/config";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let cleanup: Cleanup;
let stashDir: string;

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  chatCalls = 0;
  stubMode = "ok";
});

afterEach(() => cleanup());

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

// Consolidation enabled, embeddings off (clustering is a no-op), and a dummy
// LLM endpoint so resolveConsolidateLlmConfig returns a config (the stubbed
// chatCompletion never actually hits it). The judgedCache toggle is passed as
// an `akmConsolidate` OPTION — mirroring how improve.ts maps the profile field
// `processes.consolidate.judgedCache` onto the call.
const CONFIG = {
  semanticSearchMode: "off",
  profiles: {
    llm: { default: { endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" } },
    improve: { default: { processes: { consolidate: { enabled: true } } } },
  },
  defaults: { llm: "default" },
} as unknown as AkmConfig;

describe("#581 consolidate judged-state cache", () => {
  test("cache ON: second run over an UNCHANGED corpus makes ~0 LLM judge calls", async () => {
    writeMemory("alpha", "Alpha body content that is distinct enough to matter.");
    writeMemory("beta", "Beta body content that is distinct enough to matter.");
    writeMemory("gamma", "Gamma body content that is distinct enough to matter.");

    // First run: nothing cached yet → all 3 judged (1 chunk → 1 call).
    const first = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(first.ok).toBe(true);
    expect(first.processed).toBe(3);
    expect(chatCalls).toBe(1);

    // Second run over the unchanged corpus: every memory is judged-unchanged →
    // the pool empties before chunking → ZERO additional LLM calls.
    chatCalls = 0;
    const second = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(second.ok).toBe(true);
    expect(second.processed).toBe(0);
    expect(chatCalls).toBe(0);
  });

  test("cache ON: a memory whose content changed is re-judged; unchanged ones are skipped", async () => {
    writeMemory("alpha", "Alpha body content.");
    writeMemory("beta", "Beta body content.");

    // First run primes the cache for both.
    await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(chatCalls).toBe(1);

    // Change only beta's body → its content hash changes; alpha is unchanged.
    chatCalls = 0;
    writeMemory("beta", "Beta body content — substantially rewritten and different now.");

    const second = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(second.ok).toBe(true);
    // Only the changed memory re-enters the LLM pool.
    expect(second.processed).toBe(1);
    expect(chatCalls).toBe(1);
  });

  test("cache ON: a memory whose TAGS changed (body identical) is re-judged", async () => {
    writeMemory("alpha", "Alpha body content.");
    writeMemory("beta", "Beta body content.");

    // First run primes the cache for both.
    await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(chatCalls).toBe(1);

    // Change ONLY beta's tags — the body is byte-identical. Semantic-metadata
    // drift must re-enter the judge (the hash covers body + sorted tags).
    chatCalls = 0;
    const betaPath = path.join(stashDir, "memories", "beta.md");
    fs.writeFileSync(
      betaPath,
      `---\ndescription: beta memory\ntags: [retagged, drift]\n---\n\nBeta body content.\n`,
      "utf8",
    );

    const second = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(second.ok).toBe(true);
    // Only the tag-drifted memory re-enters the LLM pool.
    expect(second.processed).toBe(1);
    expect(chatCalls).toBe(1);
  });

  test("cache OFF (explicit): every run judges the full pool (no skipping)", async () => {
    writeMemory("alpha", "Alpha body content.");
    writeMemory("beta", "Beta body content.");

    // Explicit enabled:false → cache disabled, full pool judged every run.
    const first = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: false } });
    expect(first.processed).toBe(2);
    expect(chatCalls).toBe(1);

    // Second run with the cache explicitly OFF re-judges everything.
    chatCalls = 0;
    const second = await akmConsolidate({
      stashDir,
      target: stashDir,
      config: CONFIG,
      judgedCache: { enabled: false },
    });
    expect(second.processed).toBe(2);
    expect(chatCalls).toBe(1);
  });

  test("cache ON: a failed LLM chunk is NOT cached (re-judged next run)", async () => {
    writeMemory("alpha", "Alpha body content.");

    // Run where the chunk's LLM call (and its single retry) both fail.
    stubMode = "throw";
    const failed = await akmConsolidate({ stashDir, target: stashDir, config: CONFIG, judgedCache: { enabled: true } });
    expect(failed.ok).toBe(true);
    // Chunk + retry both fail → memory lands in the failed bucket, nothing cached.
    expect(failed.failedChunkMemories).toBe(1);

    // Now the LLM recovers: the memory must be judged again (never cached).
    stubMode = "ok";
    chatCalls = 0;
    const recovered = await akmConsolidate({
      stashDir,
      target: stashDir,
      config: CONFIG,
      judgedCache: { enabled: true },
    });
    expect(recovered.processed).toBe(1);
    expect(chatCalls).toBe(1);
  });
});
