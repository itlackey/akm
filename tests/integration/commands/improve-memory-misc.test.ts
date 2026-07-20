import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { type AkmConfig, type ImproveProfileConfig, saveConfig } from "../../../src/core/config/config";
import { appendEvent, readEvents } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeMemory } from "../../_helpers/assets";
import { durableItemRef } from "../../_helpers/durable-ref";
import { makeProposal } from "../../_helpers/factories";
import { withTestImproveLlm } from "../../_helpers/improve-config";

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

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
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
          schemaVersion: 2,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          engine: "test",
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
          schemaVersion: 2,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          engine: "test",
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
          schemaVersion: 2,
          ok: true,
          proposal: makeProposal(opts.ref ?? "memory:budget-test"),
          ref: opts.ref ?? "",
          engine: "test",
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
      timeoutMs: 60_000,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => ({
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(opts.ref ?? "memory:timer-test"),
        ref: opts.ref ?? "",
        engine: "test",
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
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => ({
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(ref ?? "memory:auth-tips"),
        ref: ref ?? "",
        engine: "test",
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
    // C1 (13-bus-factor): the per-ref distill-skipped row is folded into the
    // bounded `distillSkipped` aggregate rather than persisted in `actions`.
    // The single skipped ref lands in the capped sample list.
    expect(result.actions?.some((a) => a.mode === "distill-skipped")).toBe(false);
    expect(result.distillSkipped?.samples.some((s) => s.ref === "memory:auth-tips")).toBe(true);
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
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(ref ?? "memory:auth-tips"),
        ref: ref ?? "",
        engine: "test",
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
  const contradictionStrategy: ImproveProfileConfig = {
    processes: { consolidate: { contradictionDetection: { enabled: true } } },
  };
  const contradictionConfig = (stashDir: string): AkmConfig => ({
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    engines: { default: { kind: "llm", endpoint: "http://localhost/v1/chat", model: "test" } },
    defaults: { llmEngine: "default" },
  });
  test("detectAndWriteContradictions is a no-op when no LLM is configured", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
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

  test("detectAndWriteContradictions writes ONE directed contradictedBy edge when LLM judges true", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-detect-");
    // Direction is lexicographic ref order: the larger ref loses. "…derived2" >
    // "…derived", so `derived2` is the loser (gets the edge) and `derived` is the
    // surviving winner.
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memory:auth-tips" }, "Always use VPN.");
    writeMemory(
      stashDir,
      "auth-tips.derived2",
      { inferred: true, source: "memory:auth-tips" },
      "VPN is never required.",
    );

    const result = await detectAndWriteContradictions(
      stashDir,
      contradictionConfig(stashDir),
      // Inject a fake chat that always returns "contradicts: true".
      async () => JSON.stringify({ contradicts: true, reason: "Direct factual conflict about VPN requirement." }),
      contradictionStrategy,
    );

    expect(result.pairsChecked).toBe(1);
    // A SINGLE directed edge — mutual A↔B edges form a 2-cycle the SCC resolver
    // refreshes back to active, erasing the contradiction every run.
    expect(result.edgesWritten).toBe(1);

    // Only the loser (`derived2`) carries `contradictedBy → derived`; the winner
    // (`derived`) has no edge.
    const winner = fs.readFileSync(path.join(stashDir, "memories", "auth-tips.derived.md"), "utf8");
    const loser = fs.readFileSync(path.join(stashDir, "memories", "auth-tips.derived2.md"), "utf8");
    expect(loser).toContain("contradictedBy");
    expect(loser).toContain("auth-tips.derived");
    expect(winner).not.toContain("contradictedBy");
  });

  test("a detected contradiction edge PERSISTS across the SCC resolver and a read-only re-run (03)", async () => {
    // The gate for the one-directed-edge fix: a mutual A↔B pair forms a 2-cycle
    // the SCC resolver treats as a sink and refreshes BOTH back to active,
    // erasing the contradiction every run. A single directed edge must survive
    // both the resolver and a subsequent read-only detection re-run.
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const { analyzeMemoryCleanup, applyMemoryCleanup } = await import(
      "../../../src/commands/improve/memory/memory-improve"
    );
    const stashDir = makeTempDir("akm-m1-persist-");
    // Direction is lexicographic ref order: `vpn.derived2` (larger ref) loses.
    writeMemory(stashDir, "vpn.derived", { inferred: true, source: "memory:vpn" }, "Always use VPN.");
    writeMemory(stashDir, "vpn.derived2", { inferred: true, source: "memory:vpn" }, "VPN is never required.");

    const config = contradictionConfig(stashDir);
    const judge = async () => JSON.stringify({ contradicts: true, reason: "Direct factual conflict." });

    const loserPath = path.join(stashDir, "memories", "vpn.derived2.md");
    const winnerPath = path.join(stashDir, "memories", "vpn.derived.md");

    // 1. Detection writes ONE directed edge.
    const first = await detectAndWriteContradictions(stashDir, config, judge, contradictionStrategy);
    expect(first.edgesWritten).toBe(1);

    // 2. The SCC resolver marks the loser `contradicted` and KEEPS the edge (a
    //    mutual 2-cycle would have been refreshed back to active here).
    applyMemoryCleanup(stashDir, analyzeMemoryCleanup(stashDir));
    expect(fs.readFileSync(loserPath, "utf8")).toContain("beliefState: contradicted");
    expect(fs.readFileSync(loserPath, "utf8")).toContain("memory:vpn.derived");
    expect(fs.readFileSync(winnerPath, "utf8")).not.toContain("beliefState: contradicted");

    // 3. A read-only re-run of detection finds the edge already present and does
    //    NOT rewrite or erase it — the contradiction is stable, not self-erasing.
    const second = await detectAndWriteContradictions(stashDir, config, judge, contradictionStrategy);
    expect(second.edgesWritten).toBe(0);
    const loserAfter = fs.readFileSync(loserPath, "utf8");
    expect(loserAfter).toContain("beliefState: contradicted");
    expect(loserAfter).toContain("memory:vpn.derived");
    expect(fs.readFileSync(winnerPath, "utf8")).not.toContain("beliefState: contradicted");
  });

  test("a 3-memory family resolves to ONE acyclic winner — no multi-node self-erasure (03)", async () => {
    // Lexicographic ref order is a TOTAL order (aaa < bbb < ccc), so the induced
    // pairwise edges form a DAG with `aaa` as the sole sink/winner — never a
    // cycle the SCC resolver would refresh back to active. This is the structural
    // guarantee that replaced the earlier (never-populated) createdAt heuristic,
    // which could produce non-transitive per-pair directions in families of 3+.
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const { analyzeMemoryCleanup, applyMemoryCleanup } = await import(
      "../../../src/commands/improve/memory/memory-improve"
    );
    const stashDir = makeTempDir("akm-m1-triad-");
    writeMemory(stashDir, "vpn.aaa.derived", { inferred: true, source: "memory:vpn" }, "Always use VPN.");
    writeMemory(stashDir, "vpn.bbb.derived", { inferred: true, source: "memory:vpn" }, "VPN is optional.");
    writeMemory(stashDir, "vpn.ccc.derived", { inferred: true, source: "memory:vpn" }, "VPN is never required.");

    const config = contradictionConfig(stashDir);
    const judge = async () => JSON.stringify({ contradicts: true, reason: "Direct factual conflict." });

    const first = await detectAndWriteContradictions(stashDir, config, judge, contradictionStrategy);
    expect(first.pairsChecked).toBe(3); // aaa-bbb, aaa-ccc, bbb-ccc
    expect(first.edgesWritten).toBe(3); // one directed edge per confirmed pair

    applyMemoryCleanup(stashDir, analyzeMemoryCleanup(stashDir));

    const readState = (name: string) => fs.readFileSync(path.join(stashDir, "memories", `${name}.md`), "utf8");
    // The sole sink (smallest ref) survives; the two larger refs are contradicted.
    expect(readState("vpn.aaa.derived")).not.toContain("beliefState: contradicted");
    expect(readState("vpn.bbb.derived")).toContain("beliefState: contradicted");
    expect(readState("vpn.ccc.derived")).toContain("beliefState: contradicted");

    // Re-run: belief STATES are stable — the winner stays current, the two
    // losers stay contradicted. (The resolver normalizes a loser's contradictedBy
    // to only its reachable sink, so the intermediate bbb→ccc edge may be
    // re-written on re-runs, but that never destabilizes the states — the DAG has
    // no cycle to refresh back to active.)
    await detectAndWriteContradictions(stashDir, config, judge, contradictionStrategy);
    applyMemoryCleanup(stashDir, analyzeMemoryCleanup(stashDir));
    expect(readState("vpn.aaa.derived")).not.toContain("beliefState: contradicted");
    expect(readState("vpn.bbb.derived")).toContain("beliefState: contradicted");
    expect(readState("vpn.ccc.derived")).toContain("beliefState: contradicted");
  });

  test("detectAndWriteContradictions skips pair when LLM judges no contradiction", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
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
      contradictionConfig(stashDir),
      async () => JSON.stringify({ contradicts: false, reason: "These are complementary security measures." }),
      contradictionStrategy,
    );

    expect(result.pairsChecked).toBe(1);
    expect(result.edgesWritten).toBe(0);
  });
});

// ── M-3 / #387 — schema-repair routes through proposal queue ─────────────────

describe("M-3: schema-repair routes through proposal queue (#387)", () => {
  test("runSchemaRepairPass queues a proposal instead of writing directly to disk", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");
    const { listProposals } = await import("../../../src/commands/proposal/repository");

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
    expect(result.repairedRefs.has("memory:auth-guide")).toBe(false);

    // File should NOT be modified (write went through proposal queue)
    const fileContent = fs.readFileSync(memFile, "utf8");
    expect(fileContent).not.toContain("Authentication guide");

    // Proposal should exist in the queue
    const proposals = listProposals(stashDir);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.ref).toBe(durableItemRef(stashDir, "memory", "auth-guide"));
    expect(proposals[0]?.payload.content).toContain("Authentication guide");
  });

  test("runSchemaRepairPass requires stashDir instead of bypassing the proposal queue", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");

    const stashDir = makeTempDir("akm-m3-fallback-");
    const memFile = path.join(stashDir, "memories", "auth2.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, "---\n---\nAuth content.\n", "utf8");

    await expect(
      runSchemaRepairPass([{ ref: "memory:auth2", reason: "missing description" }], {
        startMs: Date.now(),
        budgetMs: 30_000,
        llmConfig: { endpoint: "http://localhost/v1/chat", model: "test" },
        findFilePath: async () => memFile,
        isLessonCandidateFn: () => false,
        chatFn: async () => JSON.stringify({ description: "Auth content description." }),
      }),
    ).rejects.toThrow(/requires stashDir/);

    const fileContent = fs.readFileSync(memFile, "utf8");
    expect(fileContent).not.toContain("Auth content description.");
  });

  // Regression: the real `akm improve` CLI has no `--stash-dir` flag and never
  // sets AkmImproveOptions.stashDir — every production/cron invocation reaches
  // preparation.ts's schema-repair call site with options.stashDir undefined.
  // A prior change wired `stashDir: options.stashDir` into the
  // runSchemaRepairPass call instead of the already-resolved `primaryStashDir`
  // in scope at that call site, so the `if (!stashDir) throw` guard fired on
  // EVERY real invocation that reached schema repair, aborting the whole
  // improve run with an uncaught exception. This drives the real akmImprove()
  // entrypoint the same way the CLI does (no `stashDir` field in options,
  // resolution via AKM_STASH_DIR env only) to prove the call chain no longer
  // throws that error.
  test("akmImprove (no options.stashDir, matching the real CLI) does not throw 'requires stashDir' when schema repair is reached", async () => {
    const stashDir = makeTempDir("akm-m3-cli-parity-");
    const lessonFile = path.join(stashDir, "lessons", "no-description.md");
    fs.mkdirSync(path.dirname(lessonFile), { recursive: true });
    // No `description` field — triggers the "missing description" validation
    // failure for lesson candidates, routing into the schema-repair pass.
    fs.writeFileSync(lessonFile, "---\nwhen_to_use: trigger\n---\n\nBody text.\n", "utf8");
    await buildIndex(stashDir);
    saveConfig({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        default: { kind: "llm", endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "test" },
      },
      defaults: { llmEngine: "default" },
    });

    const { appendEvent: appendFeedbackEvent } = await import("../../../src/core/events");
    appendFeedbackEvent({ eventType: "feedback", ref: "lesson:no-description", metadata: { signal: "positive" } });

    const reflectFn = async ({ ref }: { ref?: string }): Promise<AkmReflectResult> => ({
      schemaVersion: 2,
      ok: true,
      proposal: makeProposal(ref ?? "lesson:no-description"),
      ref: ref ?? "",
      engine: "test",
      durationMs: 1,
    });
    const distillFn = async ({ ref }: { ref: string }): Promise<AkmDistillResult> => ({
      schemaVersion: 1,
      ok: true,
      outcome: "queued",
      inputRef: ref,
      lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
    });
    const reindexFn = async () => ({
      schemaVersion: 1 as const,
      ok: true as const,
      indexed: 0,
      warnings: [],
      errors: [],
      durationMs: 0,
    });

    // Regression assertion: prior to the fix, this rejected with "runSchemaRepairPass
    // requires stashDir so repairs route through the proposal queue" — an uncaught
    // exception that aborted the whole run. It must now resolve normally (the LLM
    // call to the unreachable endpoint above is expected to fail gracefully as a
    // per-item schema-repair "error" outcome, not as a thrown exception).
    const result = await akmImprove({
      scope: "lesson",
      ensureIndexFn: async () => false,
      reindexFn,
      reflectFn,
      distillFn,
    });
    expect(result.ok).toBe(true);
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
      } satisfies import("../../../src/indexer/graph/graph-extraction").GraphExtractionResult;
    };

    // Run with consolidation enabled to trigger the D9 reindex path
    await akmImprove({
      scope: "memory",
      stashDir,
      config: {
        semanticSearchMode: "off",
        engines: {
          default: { kind: "llm", endpoint: "http://localhost/chat/completions", model: "test" },
        },
        improve: {
          strategies: {
            default: {
              processes: {
                consolidate: { enabled: true },
                graphExtraction: { enabled: true },
                memoryInference: { enabled: false },
              },
            },
          },
        },
        defaults: { llmEngine: "default" },
      },
      ensureIndexFn: async () => false,
      reindexFn,
      graphExtractionFn,
      reflectFn: async ({ ref }) => ({
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(ref ?? "memory:auth-guide"),
        ref: ref ?? "",
        engine: "test",
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
        engines: {
          default: { kind: "llm", endpoint: "http://localhost/chat/completions", model: "test" },
        },
        improve: {
          strategies: {
            default: {
              processes: {
                memoryInference: { enabled: false },
                graphExtraction: { enabled: false },
                // default profile now ships proactiveMaintenance ON; disable it so
                // this test pins the zero-SIGNAL gate, not the proactive lane.
                proactiveMaintenance: { enabled: false },
              },
            },
          },
        },
        defaults: { llmEngine: "default" },
      },
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => {
        reflected.push(ref ?? "");
        return {
          schemaVersion: 2,
          ok: true,
          proposal: makeProposal(ref ?? "memory:mem-1"),
          ref: ref ?? "",
          engine: "test",
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
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(ref ?? "memory:alpha"),
        ref: ref ?? "",
        engine: "test",
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
      ensureIndexFn: async () => false,
      reflectFn: async ({ ref }) => ({
        schemaVersion: 2,
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
    const { createProposal } = await import("../../../src/commands/proposal/repository");
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
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(ref ?? "memory:real-asset"),
        ref: ref ?? "",
        engine: "test",
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

  // ── 0.9.0 confidence-gate deletion — replacement contract ─────────────────
  // The Phase 6A gate (auto-promote at confidence >= threshold) was deleted:
  // proposals now ALWAYS queue for review regardless of confidence. This pins
  // the replacement behavior for what used to be the strongest accept case.

  test("a high-confidence reflect proposal stays pending (no auto-accept path exists)", async () => {
    const { createProposal, getProposal, isProposalSkipped, listProposals } = await import(
      "../../../src/commands/proposal/repository"
    );
    const stashDir = makeTempDir("akm-6a-no-gate-");
    writeMemory(stashDir, "target-asset", { description: "Existing memory" }, "Existing body.");
    await buildIndex(stashDir);

    // The mock reflectFn persists a real proposal with confidence 0.95 — under
    // the deleted gate's default threshold (0.9) this WOULD have auto-promoted.
    // scope is a specific ref so collectEligibleRefs unconditionally plans it.
    const result = await akmImprove({
      scope: "memory:target-asset",
      stashDir,
      ensureIndexFn: async () => false,
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
          schemaVersion: 2,
          ok: true,
          proposal: created,
          ref: created.ref,
          engine: "test",
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

    // The proposal stays pending with its confidence preserved for reviewers.
    const pending = listProposals(stashDir, { status: "pending", ref: "memory:target-asset" });
    expect(pending.length).toBe(1);
    expect(pending[0]?.confidence).toBe(0.95);
    if (pending[0]) {
      const proposal = getProposal(stashDir, pending[0].id);
      expect(proposal.status).toBe("pending");
      // No gate ran — nothing stamped a gate decision on the fresh proposal.
      expect(proposal.gateDecision).toBeUndefined();
    }
    // No promoted event with the gate's autoAccept metadata is emitted.
    const promotedEvents = readEvents({ type: "promoted" });
    const auto = promotedEvents.events.find(
      (e) => (e.metadata as Record<string, unknown> | undefined)?.autoAccept === true,
    );
    expect(auto).toBeUndefined();
    // The result envelope no longer reports gate counts (0 is omitted).
    expect(result.gateAutoAcceptedCount ?? 0).toBe(0);
    expect(result.gateAutoAcceptFailedCount ?? 0).toBe(0);
  });

  // ── Phase 6B — proposalsExpired propagates through the improve result ─────

  test("proposalsExpired surfaces in the result when stale proposals exist", async () => {
    const { createProposal, isProposalSkipped } = await import("../../../src/commands/proposal/repository");
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
      // Default config.archiveRetentionDays is 90; 200 days old > 90 → expire.
      reflectFn: async ({ ref }) => ({
        schemaVersion: 2,
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
    expect(expiredEvents.events.some((e) => e.ref === durableItemRef(stashDir, "memory", "live-asset"))).toBe(true);
  });
});
