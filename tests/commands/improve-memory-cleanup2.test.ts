import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../src/commands/distill";
import { akmImprove } from "../../src/commands/improve";
import type { AkmReflectResult } from "../../src/commands/reflect";
import { saveConfig } from "../../src/core/config";
import { appendEvent, readEvents } from "../../src/core/events";
import type { Proposal } from "../../src/core/proposals";
import type { GraphExtractionResult } from "../../src/indexer/graph-extraction";
import { akmIndex } from "../../src/indexer/indexer";
import type { MemoryInferenceResult } from "../../src/indexer/memory-inference";

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

describe("akm improve memory cleanup", () => {
  test("requireFeedbackSignal restricts planning to refs with recent feedback", async () => {
    const stashDir = makeTempDir("akm-improve-memory-signal-filter-");
    writeMemory(stashDir, "alpha", { description: "alpha memory" }, "Remember alpha details.");
    writeMemory(stashDir, "beta", { description: "beta memory" }, "Remember beta details.");
    await buildIndex(stashDir);

    const reflectedWithoutSignals: string[] = [];

    const withoutSignals = await akmImprove({
      scope: "memory",
      stashDir,
      requireFeedbackSignal: true,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async ({ ref }) => {
        if (ref) reflectedWithoutSignals.push(ref);
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
    expect(withoutSignals.plannedRefs).toEqual([]);
    expect(reflectedWithoutSignals).toEqual([]);

    appendEvent({
      eventType: "feedback",
      ref: "memory:alpha",
      metadata: { signal: "positive", note: "helpful" },
    });

    const reflectedWithSignal: string[] = [];

    const withSignal = await akmImprove({
      scope: "memory",
      stashDir,
      requireFeedbackSignal: true,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async ({ ref }) => {
        if (ref) reflectedWithSignal.push(ref);
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
    expect(withSignal.plannedRefs).toEqual([{ ref: "memory:alpha", reason: "scope-type" }]);
    expect(reflectedWithSignal).toEqual(["memory:alpha"]);
  });

  test("derived memories never enter plannedRefs (skip-the-skip churn fix)", async () => {
    // Regression: prior to 2026-05-21, `.derived` memories were enqueued in
    // plannedRefs with reason="memory-cleanup", only to be immediately bounced
    // by the in-loop check that refuses to reflect on derived refs. Observed
    // effect: same 11 derived refs re-planned every hourly run with no real
    // work done. The cleanup phase (analyzeMemoryCleanup) inspects derived
    // memories independently of plannedRefs, so they should never appear.
    const stashDir = makeTempDir("akm-improve-derived-not-planned-");
    writeMemory(stashDir, "parent", { description: "parent memory" }, "Parent body.");
    writeMemory(
      stashDir,
      "parent.derived",
      {
        inferred: true,
        source: "memory:parent",
        description: "Derived inference from parent.",
      },
      "# Derived\n\nInferred content.",
    );
    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async ({ ref }) => {
        if (ref) reflectedRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:parent"),
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

    expect(result.ok).toBe(true);
    // The derived memory MUST NOT appear in plannedRefs.
    expect(result.plannedRefs.some((p) => p.ref.endsWith(".derived"))).toBe(false);
    // The synthetic `derived-memory-reflect-skipped` action is no longer
    // emitted because the ref never enters the loop.
    expect(
      result.actions?.some(
        (a) =>
          a.ref === "memory:parent.derived" &&
          a.mode === "distill-skipped" &&
          (a.result as { reason?: string } | undefined)?.reason === "derived-memory-reflect-skipped",
      ),
    ).toBe(false);
    // memorySummary still reports both the eligible total and the derived count
    // — the cleanup phase relies on these stats, not on plannedRefs.
    expect(result.memorySummary).toEqual({ eligible: 2, derived: 1 });
  });

  test("accepted refs bypass reflect cooldown during improve", async () => {
    const stashDir = makeTempDir("akm-improve-memory-accepted-bypass-");
    writeMemory(stashDir, "deploy", { description: "deploy memory" }, "Remember deploy details.");
    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];
    const now = Date.now();
    appendEvent({ eventType: "reflect_invoked", ref: "memory:deploy" }, { now: () => now - 24 * 60 * 60 * 1000 });
    appendEvent({ eventType: "promoted", ref: "memory:deploy" }, { now: () => now });

    await akmImprove({
      scope: "memory",
      stashDir,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
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

    expect(reflectedRefs).toContain("memory:deploy");
  });

  test("memory distill is skipped without recent feedback for non-ref scope", async () => {
    const stashDir = makeTempDir("akm-improve-memory-distill-skip-");
    writeMemory(stashDir, "deploy", { description: "deploy memory" }, "Remember deploy details.");
    await buildIndex(stashDir);

    const distilledRefs: string[] = [];

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        }) satisfies AkmReflectResult,
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

    expect(distilledRefs).toEqual([]);
    expect(
      result.actions?.some(
        (action) =>
          action.ref === "memory:deploy" &&
          action.mode === "distill-skipped" &&
          "reason" in action.result &&
          action.result.reason === "memory requires recent feedback signal",
      ),
    ).toBe(true);
  });

  test("improve runs memory inference after distill and skips refs promoted to knowledge", async () => {
    const stashDir = makeTempDir("akm-improve-memory-maintenance-");
    writeMemory(stashDir, "deploy", { description: "deploy memory" }, "Remember deploy details.");
    writeMemory(stashDir, "vpn", { description: "vpn memory" }, "Remember vpn details.");
    await buildIndex(stashDir);

    appendEvent({ eventType: "feedback", ref: "memory:deploy", metadata: { signal: "positive", note: "good" } });
    appendEvent({ eventType: "feedback", ref: "memory:vpn", metadata: { signal: "positive", note: "good" } });

    const inferredRefs: string[][] = [];
    const graphCalls: number[] = [];

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:missing"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => {
        if (ref === "memory:deploy") {
          return {
            schemaVersion: 1,
            ok: true,
            outcome: "queued",
            inputRef: ref,
            lessonRef: "knowledge:deploy",
            proposalRef: "knowledge:deploy",
            proposalKind: "knowledge",
          } satisfies AkmDistillResult;
        }
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
          proposalRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
          proposalKind: "lesson",
        } satisfies AkmDistillResult;
      },
      memoryInferenceFn: async (_config, _sources, _signal, _db, _reEnrich, _onProgress, options) => {
        inferredRefs.push([...(options?.candidateRefs ?? new Set<string>())].sort());
        return {
          considered: 1,
          splitParents: 1,
          writtenFacts: 1,
          skippedNoFacts: 0,

          cacheHits: 0,
        } satisfies MemoryInferenceResult;
      },
      graphExtractionFn: async () => {
        graphCalls.push(1);
        return {
          considered: 1,
          extracted: 1,
          totalEntities: 1,
          totalRelations: 0,
          written: true,
          quality: {
            consideredFiles: 1,
            extractedFiles: 1,
            entityCount: 1,
            relationCount: 0,
            extractionCoverage: 1,
            density: 0,
          },
        } satisfies GraphExtractionResult;
      },
    });

    // Item 9 fix: memory-inference no longer receives an explicit candidateRefs
    // filter from the orchestrator — it discovers candidates via its own
    // filesystem scan. The mock above pushes whatever options.candidateRefs is
    // (now undefined → empty Set), so we just assert the pass was invoked.
    expect(inferredRefs).toEqual([[]]);
    expect(graphCalls).toHaveLength(1);
    expect(result.memoryInference).toEqual({
      considered: 1,
      splitParents: 1,
      writtenFacts: 1,
      skippedNoFacts: 0,

      cacheHits: 0,
    });
    expect(result.graphExtraction?.written).toBe(true);
  });

  test("improve reindexes after memory inference before refreshing the graph", async () => {
    const stashDir = makeTempDir("akm-improve-memory-reindex-order-");
    writeMemory(stashDir, "vpn", { description: "vpn memory" }, "Remember vpn details.");
    await buildIndex(stashDir);

    appendEvent({ eventType: "feedback", ref: "memory:vpn", metadata: { signal: "positive", note: "good" } });

    const callOrder: string[] = [];

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => {
        callOrder.push("reindex");
        return { schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 };
      },
      reflectFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        proposal: makeProposal(ref ?? "memory:missing"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued",
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        proposalRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        proposalKind: "lesson",
      }),
      memoryInferenceFn: async () => {
        callOrder.push("memoryInference");
        return {
          considered: 1,
          splitParents: 1,
          writtenFacts: 1,
          skippedNoFacts: 0,

          cacheHits: 0,
        } satisfies MemoryInferenceResult;
      },
      graphExtractionFn: async (_config, _sources, _signal, _db, _reEnrich, _onProgress, options) => {
        callOrder.push("graphExtraction");
        // Phase 1 perf fix: improve now passes candidatePaths filtered to refs
        // actually touched this run (here: memory:vpn). The set must include
        // the resolved file for the processed memory so graph extraction can
        // rescan only the changed files.
        expect(options?.candidatePaths).toBeDefined();
        expect(options?.candidatePaths?.size).toBeGreaterThan(0);
        return {
          considered: 1,
          extracted: 1,
          totalEntities: 1,
          totalRelations: 0,
          written: true,
          quality: {
            consideredFiles: 1,
            extractedFiles: 1,
            entityCount: 1,
            relationCount: 0,
            extractionCoverage: 1,
            density: 0,
          },
        } satisfies GraphExtractionResult;
      },
    });

    expect(callOrder).toEqual(["memoryInference", "reindex", "graphExtraction"]);
    expect(result.memoryInference?.writtenFacts).toBe(1);
    expect(result.graphExtraction?.written).toBe(true);
  });

  test("improve emits incremental graph extraction progress lines", async () => {
    const stashDir = makeTempDir("akm-improve-graph-progress-");
    writeMemory(stashDir, "vpn", { description: "vpn memory" }, "Remember vpn details.");
    await buildIndex(stashDir);

    appendEvent({ eventType: "feedback", ref: "memory:vpn", metadata: { signal: "positive", note: "good" } });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await akmImprove({
        scope: "memory",
        stashDir,
        ensureIndexFn: async () => false,
        reflectFn: async ({ ref }) => ({
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        }),
        distillFn: async ({ ref }) => ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
          proposalRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
          proposalKind: "lesson",
        }),
        graphExtractionFn: async (_config, _sources, _signal, _db, _reEnrich, onProgress) => {
          onProgress?.({
            processed: 1,
            total: 3,
            extracted: 1,
            totalEntities: 2,
            totalRelations: 1,
            currentPath: path.join(stashDir, "memories", "vpn.md"),
          });
          onProgress?.({
            processed: 2,
            total: 3,
            extracted: 1,
            totalEntities: 2,
            totalRelations: 1,
            currentPath: path.join(stashDir, "memories", "deploy.md"),
          });
          onProgress?.({
            processed: 3,
            total: 3,
            extracted: 2,
            totalEntities: 4,
            totalRelations: 2,
            currentPath: path.join(stashDir, "memories", "release.md"),
          });
          return {
            considered: 3,
            extracted: 2,
            totalEntities: 4,
            totalRelations: 2,
            written: true,
            quality: {
              consideredFiles: 3,
              extractedFiles: 2,
              entityCount: 4,
              relationCount: 2,
              extractionCoverage: 2 / 3,
              density: 2,
            },
          } satisfies GraphExtractionResult;
        },
      });

      const lines = warnSpy.mock.calls
        .map((args) => args.map((arg) => String(arg)).join(" "))
        .filter((line) => line.startsWith("[improve] graph extraction "));

      expect(lines.some((line) => line.includes("1/3") && line.includes("vpn.md"))).toBe(true);
      expect(lines.some((line) => line.includes("2/3") && line.includes("deploy.md"))).toBe(true);
      expect(lines.some((line) => line.includes("3/3") && line.includes("release.md"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("improve emits maintenance action counts in completed events", async () => {
    const stashDir = makeTempDir("akm-improve-memory-completed-event-");
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
        proposal: makeProposal(ref ?? "memory:missing"),
        ref: ref ?? "",
        agentProfile: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued",
        inputRef: ref,
        lessonRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        proposalRef: `lesson:${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        proposalKind: "lesson",
      }),
      memoryInferenceFn: async () => ({
        considered: 1,
        splitParents: 1,
        writtenFacts: 1,
        skippedNoFacts: 0,

        cacheHits: 0,
      }),
      graphExtractionFn: async () => ({
        considered: 1,
        extracted: 1,
        totalEntities: 1,
        totalRelations: 0,
        written: true,
        quality: {
          consideredFiles: 1,
          extractedFiles: 1,
          entityCount: 1,
          relationCount: 0,
          extractionCoverage: 1,
          density: 0,
        },
      }),
    });

    expect(result.actions?.map((action) => action.mode)).toEqual([
      "reflect",
      "distill",
      "memory-inference",
      "graph-extraction",
    ]);

    const { events } = readEvents({ type: "improve_completed" });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      plannedRefs: 1,
      reflectActions: 1,
      distillActions: 1,
      memoryInferenceActions: 1,
      graphExtractionActions: 1,
      memoryInferenceWrites: 1,
      graphExtractionExtractedFiles: 1,
      memoryEligible: 1,
      memoryDerived: 0,
    });
  });

  test("stale consolidate journal error gives actionable improve recovery guidance", async () => {
    const stashDir = makeTempDir("akm-improve-stale-journal-abort-");
    fs.mkdirSync(path.join(stashDir, ".akm"), { recursive: true });
    fs.writeFileSync(
      path.join(stashDir, ".akm", "consolidate-journal.json"),
      JSON.stringify(
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          operations: [{ op: "delete", ref: "memory:old", reason: "stale" }],
          completed: [],
          backupTimestamp: "2026-01-01T00-00-00-000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(
      akmImprove({
        scope: "memory",
        stashDir,
        config: {
          semanticSearchMode: "off",
          profiles: {
            llm: { default: { endpoint: "http://localhost/chat/completions", model: "test" } },
            improve: { default: { processes: { consolidate: { enabled: true } } } },
          },
          defaults: { llm: "default" },
        },
        ensureIndexFn: async () => false,
        reindexFn: async () => ({
          schemaVersion: 1,
          ok: true,
          indexed: 0,
          warnings: [],
          errors: [],
          durationMs: 0,
        }),
      }),
    ).rejects.toThrow("--consolidate-recovery clean");
    await expect(
      akmImprove({
        scope: "memory",
        stashDir,
        config: {
          semanticSearchMode: "off",
          profiles: {
            llm: { default: { endpoint: "http://localhost/chat/completions", model: "test" } },
            improve: { default: { processes: { consolidate: { enabled: true } } } },
          },
          defaults: { llm: "default" },
        },
        ensureIndexFn: async () => false,
        reindexFn: async () => ({
          schemaVersion: 1,
          ok: true,
          indexed: 0,
          warnings: [],
          errors: [],
          durationMs: 0,
        }),
      }),
    ).rejects.not.toThrow("akm consolidate --clean");
  });

  test("consolidate recovery clean removes stale journal and allows improve to continue", async () => {
    const stashDir = makeTempDir("akm-improve-stale-journal-clean-");
    const staleBackupTs = "2026-01-01T00-00-00-000Z";
    fs.mkdirSync(path.join(stashDir, ".akm", "consolidate-backup", staleBackupTs), { recursive: true });
    fs.writeFileSync(
      path.join(stashDir, ".akm", "consolidate-journal.json"),
      JSON.stringify(
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          operations: [{ op: "delete", ref: "memory:old", reason: "stale" }],
          completed: [],
          backupTimestamp: staleBackupTs,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      config: {
        semanticSearchMode: "off",
        profiles: {
          llm: { default: { endpoint: "http://localhost/chat/completions", model: "test" } },
          improve: { default: { processes: { consolidate: { enabled: true } } } },
        },
        defaults: { llm: "default" },
      },
      ensureIndexFn: async () => false,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      consolidateOptions: { recoveryMode: "clean" },
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, ".akm", "consolidate-journal.json"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, ".akm", "consolidate-backup", staleBackupTs))).toBe(false);
  });
});
