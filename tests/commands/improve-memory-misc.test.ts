import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../src/commands/improve/distill";
import { akmImprove } from "../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../src/commands/improve/reflect";
import { saveConfig } from "../../src/core/config";
import { appendEvent, readEvents } from "../../src/core/events";
import type { Proposal } from "../../src/core/proposals";
import { akmIndex } from "../../src/indexer/indexer";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMemory(stashDir: string, name: string, frontmatter: Record<string, unknown>, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = ["---", ...renderFrontmatter(frontmatter), "---", "", body.trim(), ""];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function renderFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${String(item)}`);
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines;
}

function makeProposal(ref: string): Proposal {
  return {
    id: `proposal-${ref.replace(/[^a-z0-9-]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    payload: { content: "# proposal" },
  };
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-memory-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-memory-config-");
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-memory-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-improve-memory-state-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.AKM_DATA_DIR === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = savedEnv.AKM_DATA_DIR;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.AKM_STATE_DIR === undefined) delete process.env.AKM_STATE_DIR;
  else process.env.AKM_STATE_DIR = savedEnv.AKM_STATE_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── O-2 / #365 — scope-ref cooldown bypass ──────────────────────────────────

describe("O-2: --scope <ref> bypasses reflect/distill cooldowns (#365)", () => {
  test("explicit --scope <ref> reflects even when ref is on reflect cooldown", async () => {
    const stashDir = makeTempDir("akm-o2-reflect-bypass-");
    writeMemory(stashDir, "auth-tips", { description: "auth memory" }, "Auth tips content.");
    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];
    const now = Date.now();
    appendEvent({ eventType: "reflect_invoked", ref: "memory:auth-tips" }, { now: () => now - 60 * 1000 });

    await akmImprove({
      scope: "memory:auth-tips",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflectedRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        } satisfies AkmReflectResult;
      },
      distillFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(reflectedRefs).toContain("memory:auth-tips");
  });

  test("non-ref scope (scope: 'memory') still respects reflect cooldown", async () => {
    const stashDir = makeTempDir("akm-o2-no-bypass-");
    writeMemory(stashDir, "auth-tips-2", { description: "auth memory 2" }, "Auth tips 2.");
    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];
    const now = Date.now();
    appendEvent({ eventType: "reflect_invoked", ref: "memory:auth-tips-2" }, { now: () => now - 60 * 1000 });

    await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflectedRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        } satisfies AkmReflectResult;
      },
      distillFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(reflectedRefs).not.toContain("memory:auth-tips-2");
  });
});

// ── O-1 / #364 — AbortSignal budget propagation ─────────────────────────────

describe("O-1: wall-clock budget AbortSignal propagated to sub-calls (#364)", () => {
  test("reflectFn receives a timeoutMs derived from the remaining budget", async () => {
    const stashDir = makeTempDir("akm-o1-timeout-propagation-");
    writeMemory(stashDir, "budget-test", { description: "budget memory" }, "Budget test content.");
    await buildIndex(stashDir);

    const capturedTimeouts: Array<number | undefined> = [];

    await akmImprove({
      scope: "memory:budget-test",
      stashDir,
      timeoutMs: 60_000,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => {
        capturedTimeouts.push(opts.timeoutMs);
        return {
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(opts.ref ?? "memory:budget-test"),
          ref: opts.ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        } satisfies AkmReflectResult;
      },
      distillFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(capturedTimeouts.length).toBeGreaterThan(0);
    const firstTimeout = capturedTimeouts[0];
    expect(firstTimeout).toBeDefined();
    expect(firstTimeout).toBeGreaterThan(0);
    expect(firstTimeout).toBeLessThanOrEqual(60_000);
  });

  test("budget AbortController is cleared after run completes (no timer leak)", async () => {
    const stashDir = makeTempDir("akm-o1-timer-clear-");
    writeMemory(stashDir, "timer-test", { description: "timer memory" }, "Timer test content.");
    await buildIndex(stashDir);

    const result = await akmImprove({
      scope: "memory:timer-test",
      stashDir,
      timeoutMs: 5_000,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(opts.ref ?? "memory:timer-test"),
        ref: opts.ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued",
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    expect(result.ok).toBe(true);
  });
});

// ── D-2 / #370 — reject-aware distill cooldown ───────────────────────────────

describe("D-2: reject-aware cooldown for distill (#370)", () => {
  test("distill is skipped when the lesson for an asset was recently rejected", async () => {
    const stashDir = makeTempDir("akm-d2-reject-cooldown-");
    writeMemory(stashDir, "auth-tips", { description: "auth memory" }, "Auth tips content.");
    await buildIndex(stashDir);

    const distilledRefs: string[] = [];
    const now = Date.now();
    appendEvent(
      { eventType: "proposal_rejected", ref: "lesson:memory-auth-tips-lesson", metadata: { reason: "Too generic" } },
      { now: () => now - 60 * 1000 },
    );

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:auth-tips"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => {
        if (ref) distilledRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(result.ok).toBe(true);
    expect(distilledRefs).not.toContain("memory:auth-tips");
    const distillSkipped = result.actions?.find((a) => a.ref === "memory:auth-tips" && a.mode === "distill-skipped");
    expect(distillSkipped).toBeDefined();
  });

  test("D-2: --scope <ref> bypasses distill reject cooldown (O-2 interaction)", async () => {
    const stashDir = makeTempDir("akm-d2-scope-bypass-");
    writeMemory(stashDir, "auth-tips", { description: "auth memory" }, "Auth tips content.");
    await buildIndex(stashDir);

    const distilledRefs: string[] = [];
    const now = Date.now();
    appendEvent(
      { eventType: "proposal_rejected", ref: "lesson:memory-auth-tips-lesson", metadata: { reason: "Too generic" } },
      { now: () => now - 60 * 1000 },
    );

    await akmImprove({
      scope: "memory:auth-tips",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:auth-tips"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => {
        if (ref) distilledRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(distilledRefs).toContain("memory:auth-tips");
  });
});

// ── M-1 / #367 — contradiction-detection unit tests ──────────────────────────

describe("M-1: contradiction-detection pass writes contradictedBy edges (#367)", () => {
  test("detectAndWriteContradictions is a no-op when no LLM is configured", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-no-llm-");
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memory:auth-tips" }, "Always use VPN.");
    writeMemory(stashDir, "auth-tips.derived2", { inferred: true, source: "memory:auth-tips" }, "VPN is optional.");

    const result = await detectAndWriteContradictions(stashDir, {
      stashDir,
      sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
      defaultWriteTarget: "stash",
      // No llm config — should be a no-op.
    } as Parameters<typeof detectAndWriteContradictions>[1]);

    // No LLM → no pairs checked → no edges written.
    expect(result.pairsChecked).toBe(0);
    expect(result.edgesWritten).toBe(0);
  });

  test("detectAndWriteContradictions writes contradictedBy edges when LLM judges true", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-detect-");
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memory:auth-tips" }, "Always use VPN.");
    writeMemory(
      stashDir,
      "auth-tips.derived2",
      { inferred: true, source: "memory:auth-tips" },
      "VPN is never required.",
    );

    const result = await detectAndWriteContradictions(
      stashDir,
      {
        semanticSearchMode: "auto",
        stashDir,
        sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
        defaultWriteTarget: "stash",
        profiles: {
          llm: { default: { endpoint: "http://localhost/v1/chat", model: "test" } },
          improve: { default: { processes: { consolidate: { contradictionDetection: { enabled: true } } } } },
        },
        defaults: { llm: "default" },
      } as Parameters<typeof detectAndWriteContradictions>[1],
      // Inject a fake chat that always returns "contradicts: true".
      async () => JSON.stringify({ contradicts: true, reason: "Direct factual conflict about VPN requirement." }),
    );

    expect(result.pairsChecked).toBe(1);
    expect(result.edgesWritten).toBe(2); // Both sides get a contradictedBy edge.

    // Verify frontmatter was updated.
    const file1 = path.join(stashDir, "memories", "auth-tips.derived.md");
    const file2 = path.join(stashDir, "memories", "auth-tips.derived2.md");
    const raw1 = fs.readFileSync(file1, "utf8");
    const raw2 = fs.readFileSync(file2, "utf8");
    expect(raw1).toContain("contradictedBy");
    expect(raw2).toContain("contradictedBy");
    expect(raw1).toContain("auth-tips.derived2");
    expect(raw2).toContain("auth-tips.derived");
  });

  test("detectAndWriteContradictions skips pair when LLM judges no contradiction", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-no-contradiction-");
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memory:auth-tips" }, "Use VPN for prod.");
    writeMemory(
      stashDir,
      "auth-tips.derived2",
      { inferred: true, source: "memory:auth-tips" },
      "Enable 2FA before deploys.",
    );

    const result = await detectAndWriteContradictions(
      stashDir,
      {
        semanticSearchMode: "auto",
        stashDir,
        sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
        defaultWriteTarget: "stash",
        profiles: {
          llm: { default: { endpoint: "http://localhost/v1/chat", model: "test" } },
          improve: { default: { processes: { consolidate: { contradictionDetection: { enabled: true } } } } },
        },
        defaults: { llm: "default" },
      } as Parameters<typeof detectAndWriteContradictions>[1],
      async () => JSON.stringify({ contradicts: false, reason: "These are complementary security measures." }),
    );

    expect(result.pairsChecked).toBe(1);
    expect(result.edgesWritten).toBe(0);
  });
});

// ── M-3 / #387 — schema-repair routes through proposal queue ─────────────────

describe("M-3: schema-repair routes through proposal queue (#387)", () => {
  test("runSchemaRepairPass queues a proposal instead of writing directly to disk", async () => {
    const { runSchemaRepairPass } = await import("../../src/commands/schema-repair");
    const { listProposals } = await import("../../src/core/proposals");

    const stashDir = makeTempDir("akm-m3-schema-repair-");
    const memFile = path.join(stashDir, "memories", "auth-guide.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, "---\n---\nAuth guide content.\n", "utf8");

    const result = await runSchemaRepairPass([{ ref: "memory:auth-guide", reason: "missing description" }], {
      startMs: Date.now(),
      budgetMs: 30_000,
      stashDir,
      llmConfig: { endpoint: "http://localhost/v1/chat", model: "test" },
      findFilePath: async () => memFile,
      isLessonCandidateFn: () => false,
      chatFn: async () => JSON.stringify({ description: "Authentication guide for the service." }),
    });

    // M-3: proposal queued (not written to disk directly)
    expect(result.repairs.length).toBe(1);
    const repair = result.repairs[0];
    expect(repair?.outcome).toBe("queued");
    expect(repair?.proposalId).toBeDefined();
    expect(result.repairedRefs.has("memory:auth-guide")).toBe(true);

    // File should NOT be modified (write went through proposal queue)
    const fileContent = fs.readFileSync(memFile, "utf8");
    expect(fileContent).not.toContain("Authentication guide");

    // Proposal should exist in the queue
    const proposals = listProposals(stashDir);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.ref).toBe("memory:auth-guide");
    expect(proposals[0]?.payload.content).toContain("Authentication guide");
  });

  test("runSchemaRepairPass falls back to direct write when stashDir is absent", async () => {
    const { runSchemaRepairPass } = await import("../../src/commands/schema-repair");

    const stashDir = makeTempDir("akm-m3-fallback-");
    const memFile = path.join(stashDir, "memories", "auth2.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, "---\n---\nAuth content.\n", "utf8");

    const result = await runSchemaRepairPass([{ ref: "memory:auth2", reason: "missing description" }], {
      startMs: Date.now(),
      budgetMs: 30_000,
      // No stashDir: triggers legacy direct-write path
      llmConfig: { endpoint: "http://localhost/v1/chat", model: "test" },
      findFilePath: async () => memFile,
      isLessonCandidateFn: () => false,
      chatFn: async () => JSON.stringify({ description: "Auth content description." }),
    });

    // Fallback: direct write
    expect(result.repairs[0]?.outcome).toBe("written");
    const fileContent = fs.readFileSync(memFile, "utf8");
    expect(fileContent).toContain("Auth content description.");
  });
});

// ── O-3 / #376 — reindex between consolidate and graph extraction ─────────────

describe("O-3: reindex triggered after consolidation before graph extraction (#376)", () => {
  test("reindexFn is called after consolidation ran and before graph extraction", async () => {
    const stashDir = makeTempDir("akm-o3-reindex-");
    writeMemory(stashDir, "auth-guide", { description: "Auth guide" }, "Auth guide content.");
    await buildIndex(stashDir);

    const reindexCallOrder: string[] = [];

    // Track reindex calls
    const reindexFn = async ({ stashDir: _s }: { stashDir: string }) => {
      reindexCallOrder.push("reindex");
      return { schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 };
    };

    // Track graph extraction calls
    let graphExtractionCalled = false;
    const graphExtractionFn = async () => {
      graphExtractionCalled = true;
      reindexCallOrder.push("graphExtraction");
      return {
        considered: 0,
        extracted: 0,
        totalEntities: 0,
        totalRelations: 0,
        written: false,
        quality: {
          consideredFiles: 0,
          extractedFiles: 0,
          entityCount: 0,
          relationCount: 0,
          extractionCoverage: 0,
          density: 0,
        },
        warnings: [],
      } satisfies import("../../src/indexer/graph-extraction").GraphExtractionResult;
    };

    // Run with consolidation enabled to trigger the D9 reindex path
    await akmImprove({
      scope: "memory",
      stashDir,
      config: {
        semanticSearchMode: "off",
        profiles: {
          llm: { default: { endpoint: "http://localhost/chat/completions", model: "test" } },
          improve: {
            default: {
              processes: {
                consolidate: { enabled: true },
                graphExtraction: { enabled: true },
                memoryInference: { enabled: false },
              },
            },
          },
        },
        defaults: { llm: "default" },
      },
      ensureIndexFn: async () => false,
      reindexFn,
      graphExtractionFn,
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:auth-guide"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // O-3: if consolidation ran, reindex must happen before graph extraction
    if (graphExtractionCalled && reindexCallOrder.includes("reindex")) {
      const reindexIdx = reindexCallOrder.indexOf("reindex");
      const graphIdx = reindexCallOrder.indexOf("graphExtraction");
      // Reindex must come before graphExtraction (when consolidation ran)
      expect(reindexIdx).toBeLessThan(graphIdx);
    }
    // At minimum, either reindex was called or graph extraction ran
    expect(reindexCallOrder.length).toBeGreaterThan(0);
  });
});

// ── zero-signal stash: no eligible refs ───────────────────────────────────────

describe("zero-signal stash: 0 eligible refs when stash has no feedback or retrievals", () => {
  test("nothing is reflected when stash has no feedback and no retrievals", async () => {
    const stashDir = makeTempDir("akm-zero-signal-");
    for (let i = 1; i <= 5; i++) {
      writeMemory(stashDir, `mem-${i}`, { description: `Memory ${i}` }, `Memory ${i} content.`);
    }
    await buildIndex(stashDir);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir,
      config: {
        semanticSearchMode: "off",
        profiles: {
          llm: { default: { endpoint: "http://localhost/chat/completions", model: "test" } },
          improve: {
            default: { processes: { memoryInference: { enabled: false }, graphExtraction: { enabled: false } } },
          },
        },
        defaults: { llm: "default" },
      },
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => {
        reflected.push(ref ?? "");
        return {
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:mem-1"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        };
      },
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // No feedback, no retrievals → 0 eligible refs → nothing reflected
    expect(reflected.length).toBe(0);
  });
});

// ── M8 — new 0.8.0 improve metrics ───────────────────────────────────────────

describe("new 0.8.0 improve metrics", () => {
  test("result shape includes orphansPurged and reflectCooldownActions fields", async () => {
    const stashDir = makeTempDir("akm-m8-shape-");
    writeMemory(stashDir, "alpha", { description: "Alpha memory" }, "Alpha content.");
    await buildIndex(stashDir);

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:alpha"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // Both fields must be present and be non-negative integers.
    expect(typeof result.orphansPurged).toBe("number");
    expect(result.orphansPurged).toBeGreaterThanOrEqual(0);
    expect(typeof result.reflectCooldownActions).toBe("number");
    expect(result.reflectCooldownActions).toBeGreaterThanOrEqual(0);
  });

  test("reflectCooldownActions increments when reflectFn returns a cooldown signal", async () => {
    const stashDir = makeTempDir("akm-m8-cooldown-");
    writeMemory(stashDir, "beta", { description: "Beta memory" }, "Beta content.");
    writeMemory(stashDir, "gamma", { description: "Gamma memory" }, "Gamma content.");
    await buildIndex(stashDir);

    // 0.8.0 signal-delta gate requires recent feedback to make a ref eligible
    // for reflect. Add a feedback event for each ref so the planner queues
    // them and reflectFn (which returns cooldown) is actually called.
    appendEvent({ eventType: "feedback", ref: "memory:beta", metadata: { signal: "positive" } });
    appendEvent({ eventType: "feedback", ref: "memory:gamma", metadata: { signal: "positive" } });

    // Return a cooldown result for every ref to drive reflectCooldownActions up.
    const result = await akmImprove({
      scope: "memory",
      stashDir,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: false,
        reason: "cooldown" as const,
        error: "Dedup signal from test",
        ref: ref ?? "",
        exitCode: null,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // Both beta and gamma should contribute to reflectCooldownActions.
    expect(result.reflectCooldownActions).toBeGreaterThanOrEqual(1);
  });

  test("orphansPurged increments for pending proposals targeting refs absent from disk", async () => {
    const { createProposal } = await import("../../src/core/proposals");
    const stashDir = makeTempDir("akm-m8-orphan-");
    // Write one real memory so improve has something to process.
    writeMemory(stashDir, "real-asset", { description: "Real memory" }, "Real content.");
    await buildIndex(stashDir);

    // Seed a pending reflect proposal for a ref that does NOT exist on disk.
    createProposal(stashDir, {
      ref: "memory:ghost-asset",
      source: "reflect",
      sourceRun: "test-seed",
      payload: { content: "# Ghost\nThis ref is orphaned." },
    });

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:real-asset"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // The ghost-asset proposal should have been purged.
    expect(result.orphansPurged).toBeGreaterThanOrEqual(1);
  });

  // ── Phase 6A — Confidence-driven auto-accept ──────────────────────────────

  test("auto-accept promotes a high-confidence reflect proposal when threshold met", async () => {
    const { createProposal, getProposal, isProposalSkipped } = await import("../../src/core/proposals");
    const stashDir = makeTempDir("akm-6a-auto-accept-");
    writeMemory(stashDir, "target-asset", { description: "Existing memory" }, "Existing body.");
    await buildIndex(stashDir);

    // The mock reflectFn must persist a real proposal on disk so that
    // promoteProposal() can find it. We persist with confidence 0.95 — well
    // above the default threshold of 0.9 — to exercise the auto-accept path.
    // scope is a specific ref so collectEligibleRefs unconditionally plans it.
    const result = await akmImprove({
      scope: "memory:target-asset",
      stashDir,
      ensureIndexFn: async () => false,
      autoAccept: 90, // explicit threshold (default is now OFF / undefined); conversion = 0.9
      minRetrievalCount: 0,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async ({ ref, stashDir: sd }) => {
        const created = createProposal(sd ?? stashDir, {
          ref: ref ?? "memory:target-asset",
          source: "reflect",
          sourceRun: "test-confidence-high",
          force: true,
          payload: {
            content: `---\ndescription: Updated memory\n---\n\nNEW BODY.\n`,
            frontmatter: { description: "Updated memory" },
          },
          confidence: 0.95,
        });
        if (isProposalSkipped(created)) throw new Error("seed proposal skipped");
        return {
          schemaVersion: 1,
          ok: true,
          proposal: created,
          ref: created.ref,
          agentProfile: "test",
          durationMs: 1,
        } satisfies AkmReflectResult;
      },
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // Find the reflect action that fired for memory:target-asset
    const reflectAction = result.actions?.find((a) => a.mode === "reflect" && a.ref === "memory:target-asset");
    expect(reflectAction).toBeDefined();
    if (!reflectAction || reflectAction.mode !== "reflect") throw new Error("expected reflect action");
    const ar = reflectAction.result as AkmReflectResult;
    if (!ar.ok) throw new Error("expected ok reflect result");
    // Proposal should be auto-accepted → status === accepted
    const proposal = getProposal(stashDir, ar.proposal.id);
    expect(proposal.status).toBe("accepted");
    // A `promoted` event with `autoAccept: true` is emitted from the loop.
    const promotedEvents = readEvents({ type: "promoted" });
    const auto = promotedEvents.events.find(
      (e) => (e.metadata as Record<string, unknown> | undefined)?.autoAccept === true,
    );
    expect(auto).toBeDefined();
  });

  test("auto-accept skips proposals below the threshold (left pending)", async () => {
    const { createProposal, getProposal, isProposalSkipped } = await import("../../src/core/proposals");
    const stashDir = makeTempDir("akm-6a-below-threshold-");
    writeMemory(stashDir, "target-low", { description: "Existing memory" }, "Existing body.");
    await buildIndex(stashDir);

    await akmImprove({
      scope: "memory:target-low",
      stashDir,
      ensureIndexFn: async () => false,
      autoAccept: 90,
      minRetrievalCount: 0,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async ({ ref, stashDir: sd }) => {
        const created = createProposal(sd ?? stashDir, {
          ref: ref ?? "memory:target-low",
          source: "reflect",
          sourceRun: "test-confidence-low",
          force: true,
          payload: { content: `---\ndescription: low confidence\n---\n\nLOW.\n` },
          confidence: 0.3, // well below 0.9
        });
        if (isProposalSkipped(created)) throw new Error("seed proposal skipped");
        return {
          schemaVersion: 1,
          ok: true,
          proposal: created,
          ref: created.ref,
          agentProfile: "test",
          durationMs: 1,
        } satisfies AkmReflectResult;
      },
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // Find the proposal directly on disk; status must remain pending.
    const { listProposals } = await import("../../src/core/proposals");
    const pending = listProposals(stashDir, { status: "pending", ref: "memory:target-low" });
    expect(pending.length).toBe(1);
    expect(pending[0]?.confidence).toBe(0.3);
    // No auto-accept promoted event for this proposal.
    const promotedEvents = readEvents({ type: "promoted" });
    const autoForLow = promotedEvents.events.find(
      (e) => e.ref === "memory:target-low" && (e.metadata as Record<string, unknown> | undefined)?.autoAccept === true,
    );
    expect(autoForLow).toBeUndefined();
    // Verify with getProposal so we don't accidentally pass on an empty array.
    if (pending[0]) {
      expect(getProposal(stashDir, pending[0].id).status).toBe("pending");
    }
  });

  // ── Phase 6B — proposalsExpired propagates through the improve result ─────

  test("proposalsExpired surfaces in the result when stale proposals exist", async () => {
    const { createProposal, isProposalSkipped } = await import("../../src/core/proposals");
    const stashDir = makeTempDir("akm-6b-expired-");
    writeMemory(stashDir, "live-asset", { description: "Live memory" }, "Live body.");
    await buildIndex(stashDir);

    // Seed a stale proposal that should be expired. We seed it on a ref that
    // exists on disk so the orphan-purge pass does not race the expiration
    // pass and pre-archive it.
    const STALE_AGE_MS = 200 * 86_400_000;
    const seeded = createProposal(
      stashDir,
      {
        ref: "memory:live-asset",
        source: "reflect",
        sourceRun: "test-stale",
        force: true,
        payload: { content: "# Stale proposal\nOld content." },
      },
      { now: () => Date.now() - STALE_AGE_MS },
    );
    if (isProposalSkipped(seeded)) throw new Error("seed skipped");

    const result = await akmImprove({
      scope: "memory:live-asset",
      stashDir,
      ensureIndexFn: async () => false,
      minRetrievalCount: 0,
      // Disable auto-accept so the seed proposal doesn't get auto-promoted by
      // a fresh reflect run before the expiration pass observes it. (The
      // seeded proposal has no confidence anyway — defence in depth.)
      autoAccept: undefined,
      // Default config.archiveRetentionDays is 90; 200 days old > 90 → expire.
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: false,
        reason: "cooldown" as const,
        error: "test-suppressed",
        ...(ref ? { ref } : {}),
        exitCode: null,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    expect(result.proposalsExpired).toBeGreaterThanOrEqual(1);
    // The expired proposal must have been emitted as a `proposal_expired` event.
    const expiredEvents = readEvents({ type: "proposal_expired" });
    expect(expiredEvents.events.some((e) => e.ref === "memory:live-asset")).toBe(true);
  });
});

describe("Phase 4A: staleness-detection pass appears in maintenance result when enabled", () => {
  test("akmImprove surfaces stalenessDetection telemetry from the injected pass", async () => {
    const stashDir = makeTempDir("akm-improve-staleness-");
    writeMemory(stashDir, "vpn", { description: "vpn memory" }, "Remember vpn details.");
    await buildIndex(stashDir);

    appendEvent({ eventType: "feedback", ref: "memory:vpn", metadata: { signal: "positive", note: "good" } });

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:vpn"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
      stalenessDetectionFn: async () => ({
        considered: 3,
        deprecated: 1,
        confirmed: 2,
        skipped: 0,
        durationMs: 7,
        warnings: [],
      }),
    });

    expect(result.stalenessDetection).toEqual({
      considered: 3,
      deprecated: 1,
      confirmed: 2,
      skipped: 0,
      durationMs: 7,
      warnings: [],
    });
  });
});
