import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import { type AkmConfig, type ImproveProfileConfig, saveConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { appendEvent, readEvents } from "../../../src/core/events";
import type { AkmDistillResult, AkmReflectResult } from "../../../src/core/improve-types";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeMemory } from "../../_helpers/assets";
import { makeProposal } from "../../_helpers/factories";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { testLlmRunner } from "../../_helpers/llm-runner";
import { type IsolatedAkmStorage, mutateScopedEnv, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function configureStash(stashDir: string): void {
  saveConfig(
    withTestImproveLlm({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
    }),
  );
}

async function buildIndex(stashDir: string): Promise<void> {
  mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
  configureStash(stashDir);
  await akmIndex({ stashDir, full: true });
}

function durableRef(ref: string): string {
  return `stash//${ref}`;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
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
    appendEvent(
      { eventType: "reflect_invoked", ref: durableRef("memories/auth-tips") },
      { now: () => now - 60 * 1000 },
    );

    await akmImprove({
      scope: "memories/auth-tips",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflectedRefs.push(ref);
        return {
          schemaVersion: 2,
          ok: true,
          proposal: makeProposal(ref ?? "memories/missing"),
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
          proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(reflectedRefs).toContain("memories/auth-tips");
  });

  test("non-ref scope (scope: 'memory') still respects reflect cooldown", async () => {
    const stashDir = makeTempDir("akm-o2-no-bypass-");
    writeMemory(stashDir, "auth-tips-2", { description: "auth memory 2" }, "Auth tips 2.");
    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];
    const now = Date.now();
    appendEvent(
      { eventType: "reflect_invoked", ref: durableRef("memories/auth-tips-2") },
      { now: () => now - 60 * 1000 },
    );

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
          proposal: makeProposal(ref ?? "memories/missing"),
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
          proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(reflectedRefs).not.toContain("memories/auth-tips-2");
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
      scope: "memories/budget-test",
      stashDir,
      timeoutMs: 60_000,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => {
        capturedTimeouts.push(opts.timeoutMs);
        return {
          schemaVersion: 2,
          ok: true,
          proposal: makeProposal(opts.ref ?? "memories/budget-test"),
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
          proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
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
      scope: "memories/timer-test",
      stashDir,
      timeoutMs: 60_000,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => ({
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(opts.ref ?? "memories/timer-test"),
        ref: opts.ref ?? "",
        engine: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued",
        inputRef: ref,
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
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
      { eventType: "proposal_rejected", ref: "lessons/memory-auth-tips-lesson", metadata: { reason: "Too generic" } },
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
        proposal: makeProposal(ref ?? "memories/auth-tips"),
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
          proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(result.ok).toBe(true);
    expect(distilledRefs).not.toContain("memories/auth-tips");
    // C1 (13-bus-factor): the per-ref distill-skipped row is folded into the
    // bounded `distillSkipped` aggregate rather than persisted in `actions`.
    // The single skipped ref lands in the capped sample list.
    expect(result.actions?.some((a) => a.mode === "distill-skipped")).toBe(false);
    expect(result.distillSkipped?.samples.some((s) => s.ref === "memories/auth-tips")).toBe(true);
  });

  test("D-2: --scope <ref> bypasses distill reject cooldown (O-2 interaction)", async () => {
    const stashDir = makeTempDir("akm-d2-scope-bypass-");
    writeMemory(stashDir, "auth-tips", { description: "auth memory" }, "Auth tips content.");
    await buildIndex(stashDir);

    const distilledRefs: string[] = [];
    const now = Date.now();
    appendEvent(
      { eventType: "proposal_rejected", ref: "lessons/memory-auth-tips-lesson", metadata: { reason: "Too generic" } },
      { now: () => now - 60 * 1000 },
    );

    await akmImprove({
      scope: "memories/auth-tips",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => ({
        schemaVersion: 2,
        ok: true,
        proposal: makeProposal(ref ?? "memories/auth-tips"),
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
          proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(distilledRefs).toContain("memories/auth-tips");
  });
});

// ── M-1 / #367 — contradiction-detection unit tests ──────────────────────────

describe("M-1: contradiction-detection pass writes contradictedBy edges (#367)", () => {
  const contradictionStrategy: ImproveProfileConfig = {
    processes: { consolidate: { contradictionDetection: { enabled: true } } },
  };
  const contradictionConfig = (stashDir: string): AkmConfig => ({
    semanticSearchMode: "auto",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    engines: { default: { kind: "llm", endpoint: "http://localhost/v1/chat", model: "test" } },
    defaults: { llmEngine: "default" },
  });
  test("detectAndWriteContradictions is a no-op when no LLM is configured", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-no-llm-");
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memories/auth-tips" }, "Always use VPN.");
    writeMemory(stashDir, "auth-tips.derived2", { inferred: true, source: "memories/auth-tips" }, "VPN is optional.");

    const result = await detectAndWriteContradictions(stashDir, {
      bundles: { stash: { path: stashDir, writable: true } } as AkmConfig["bundles"],
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      // No llm config — should be a no-op.
    } as Parameters<typeof detectAndWriteContradictions>[1]);

    // No LLM → no pairs checked → no edges written.
    expect(result.pairsChecked).toBe(0);
    expect(result.edgesWritten).toBe(0);
  });

  test("disabled contradiction detection returns before execution planning", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-disabled-before-planning-");
    const disabledStrategy: ImproveProfileConfig = {
      processes: { consolidate: { contradictionDetection: { enabled: false } } },
    };
    const incompatibleConfig: AkmConfig = {
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      engines: { "claude-agent": { kind: "agent", platform: "claude" } },
      defaults: { llmEngine: "claude-agent" },
    };

    const result = await detectAndWriteContradictions(stashDir, incompatibleConfig, undefined, disabledStrategy);

    expect(result).toEqual({ familiesExamined: 0, pairsChecked: 0, edgesWritten: 0, warnings: [] });
  });

  test("detectAndWriteContradictions writes ONE directed contradictedBy edge when LLM judges true", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-detect-");
    // Direction is lexicographic ref order: the larger ref loses. "…derived2" >
    // "…derived", so `derived2` is the loser (gets the edge) and `derived` is the
    // surviving winner.
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memories/auth-tips" }, "Always use VPN.");
    writeMemory(
      stashDir,
      "auth-tips.derived2",
      { inferred: true, source: "memories/auth-tips" },
      "VPN is never required.",
    );

    const result = await detectAndWriteContradictions(
      stashDir,
      contradictionConfig(stashDir),
      // Inject a fake chat that always returns "contradicts: true".
      async () =>
        JSON.stringify({
          contradicts: true,
          confidence: 1,
          reason: "Direct factual conflict about VPN requirement.",
        }),
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
    writeMemory(stashDir, "vpn.derived", { inferred: true, source: "memories/vpn" }, "Always use VPN.");
    writeMemory(stashDir, "vpn.derived2", { inferred: true, source: "memories/vpn" }, "VPN is never required.");

    const config = contradictionConfig(stashDir);
    const judge = async () => JSON.stringify({ contradicts: true, confidence: 1, reason: "Direct factual conflict." });

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
    writeMemory(stashDir, "vpn.aaa.derived", { inferred: true, source: "memories/vpn" }, "Always use VPN.");
    writeMemory(stashDir, "vpn.bbb.derived", { inferred: true, source: "memories/vpn" }, "VPN is optional.");
    writeMemory(stashDir, "vpn.ccc.derived", { inferred: true, source: "memories/vpn" }, "VPN is never required.");

    const config = contradictionConfig(stashDir);
    const judge = async () => JSON.stringify({ contradicts: true, confidence: 1, reason: "Direct factual conflict." });

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

  test("a missing operation credential leaves a contradiction triad completely unstamped", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-triad-required-credential-");
    for (const [name, body] of [
      ["vpn.aaa.derived", "Always use VPN."],
      ["vpn.bbb.derived", "VPN is optional."],
      ["vpn.ccc.derived", "VPN is never required."],
    ] as const) {
      writeMemory(stashDir, name, { inferred: true, source: "memories/vpn" }, body);
    }
    const config = contradictionConfig(stashDir);
    config.engines = {
      default: {
        kind: "llm",
        endpoint: "http://localhost/v1/chat",
        model: "test",
        apiKey: "$AKM_CONTRADICTION_TRIAD_KEY",
      },
    };
    const before = fs
      .readdirSync(path.join(stashDir, "memories"))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(stashDir, "memories", name), "utf8")] as const);

    await withEnv({ AKM_CONTRADICTION_TRIAD_KEY: undefined }, async () => {
      await expect(
        detectAndWriteContradictions(
          stashDir,
          config,
          async () => JSON.stringify({ contradicts: true, confidence: 1, reason: "conflict" }),
          contradictionStrategy,
        ),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    expect(
      fs
        .readdirSync(path.join(stashDir, "memories"))
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(stashDir, "memories", name), "utf8")] as const),
    ).toEqual(before);
    expect(before.every(([, content]) => !content.includes("contradictedBy") && !content.includes("beliefState"))).toBe(
      true,
    );
  });

  test("each contradiction-pair call reads the credential current at its dispatch", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-triad-rotation-");
    for (const [name, body] of [
      ["vpn.aaa.derived", "Always use VPN."],
      ["vpn.bbb.derived", "VPN is optional."],
      ["vpn.ccc.derived", "VPN is never required."],
    ] as const) {
      writeMemory(stashDir, name, { inferred: true, source: "memories/vpn" }, body);
    }
    const config = contradictionConfig(stashDir);
    config.engines = {
      default: {
        kind: "llm",
        endpoint: "http://localhost/v1/chat",
        model: "test",
        apiKey: "$AKM_CONTRADICTION_ROTATING_KEY",
      },
    };
    const observed: Array<string | undefined> = [];
    const original = "contradiction-original-secret";
    const rotated = "contradiction-rotated-secret";

    const result = await withEnv({ AKM_CONTRADICTION_ROTATING_KEY: original }, () =>
      detectAndWriteContradictions(
        stashDir,
        config,
        async (connection) => {
          observed.push(connection.apiKey);
          if (observed.length === 1) mutateScopedEnv("AKM_CONTRADICTION_ROTATING_KEY", rotated);
          return JSON.stringify({ contradicts: true, confidence: 1, reason: "conflict" });
        },
        contradictionStrategy,
      ),
    );

    expect(result.edgesWritten).toBe(3);
    expect(observed).toEqual([original, rotated, rotated]);
  });

  test("detectAndWriteContradictions skips pair when LLM judges no contradiction", async () => {
    const { detectAndWriteContradictions } = await import(
      "../../../src/commands/improve/memory/memory-contradiction-detect"
    );
    const stashDir = makeTempDir("akm-m1-no-contradiction-");
    writeMemory(stashDir, "auth-tips.derived", { inferred: true, source: "memories/auth-tips" }, "Use VPN for prod.");
    writeMemory(
      stashDir,
      "auth-tips.derived2",
      { inferred: true, source: "memories/auth-tips" },
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
  test("runSchemaRepairPass preserves a missing symbolic credential as a hard config failure", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");
    const stashDir = makeTempDir("akm-m3-schema-credential-");
    const memFile = path.join(stashDir, "memories", "credential.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, "---\n---\nCredential-bound content.\n", "utf8");
    configureStash(stashDir);
    let chatCalls = 0;

    const failure = withEnv({ AKM_SCHEMA_REPAIR_REQUIRED_KEY: undefined }, () =>
      runSchemaRepairPass([{ ref: "memories/credential", reason: "missing description" }], {
        startMs: Date.now(),
        budgetMs: 30_000,
        stashDir,
        llmRunner: {
          kind: "llm",
          engine: "repair",
          connection: { endpoint: "http://localhost/v1/chat", model: "test" },
          credential: { names: ["AKM_SCHEMA_REPAIR_REQUIRED_KEY"], required: true },
        },
        findFilePath: async () => memFile,
        isLessonCandidateFn: () => false,
        chatFn: async () => {
          chatCalls += 1;
          return JSON.stringify({ description: "wrong" });
        },
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toMatchObject({ code: "INVALID_CONFIG_FILE" });
    expect(chatCalls).toBe(0);
    const { listProposals } = await import("../../../src/commands/proposal/repository");
    expect(listProposals(stashDir)).toEqual([]);
    expect(fs.readFileSync(memFile, "utf8")).toBe("---\n---\nCredential-bound content.\n");
  });

  test("runSchemaRepairPass queues a proposal instead of writing directly to disk", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");
    const { listProposals } = await import("../../../src/commands/proposal/repository");

    const stashDir = makeTempDir("akm-m3-schema-repair-");
    const memFile = path.join(stashDir, "memories", "auth-guide.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, "---\n---\nAuth guide content.\n", "utf8");
    configureStash(stashDir);

    const result = await runSchemaRepairPass([{ ref: "memories/auth-guide", reason: "missing description" }], {
      startMs: Date.now(),
      budgetMs: 30_000,
      stashDir,
      llmRunner: testLlmRunner({ endpoint: "http://localhost/v1/chat", model: "test" }),
      findFilePath: async () => memFile,
      isLessonCandidateFn: () => false,
      chatFn: async () => JSON.stringify({ description: "Authentication guide for the service." }),
    });

    // M-3: proposal queued (not written to disk directly)
    expect(result.repairs.length).toBe(1);
    const repair = result.repairs[0];
    expect(repair?.outcome).toBe("queued");
    expect(repair?.proposalId).toBeDefined();
    expect(result.repairedRefs.has("memories/auth-guide")).toBe(false);

    // File should NOT be modified (write went through proposal queue)
    const fileContent = fs.readFileSync(memFile, "utf8");
    expect(fileContent).not.toContain("Authentication guide");

    // Proposal should exist in the queue
    const proposals = listProposals(stashDir);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.ref).toBe(durableRef("memories/auth-guide"));
    expect(proposals[0]?.payload.content).toContain("Authentication guide");
  });

  test("two-item schema repair validates a required credential before any proposal or event", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");
    const { listProposals } = await import("../../../src/commands/proposal/repository");
    const stashDir = makeTempDir("akm-m3-schema-batch-required-");
    const files = new Map<string, string>();
    for (const name of ["first", "second"]) {
      const ref = `memories/${name}`;
      const file = path.join(stashDir, "memories", `${name}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\n---\n${name} body.\n`, "utf8");
      files.set(ref, file);
    }
    configureStash(stashDir);

    await withEnv({ AKM_SCHEMA_BATCH_KEY: undefined }, async () => {
      await expect(
        runSchemaRepairPass(
          [
            { ref: "memories/first", reason: "missing description" },
            { ref: "memories/second", reason: "missing description" },
          ],
          {
            startMs: Date.now(),
            budgetMs: 30_000,
            stashDir,
            llmRunner: {
              kind: "llm",
              engine: "repair",
              connection: { endpoint: "http://localhost/v1/chat", model: "test" },
              credential: { names: ["AKM_SCHEMA_BATCH_KEY"], required: true },
            },
            findFilePath: async (ref) => files.get(ref) ?? null,
            isLessonCandidateFn: () => false,
            chatFn: async () => JSON.stringify({ description: "must not run" }),
          },
        ),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    expect(listProposals(stashDir)).toEqual([]);
    expect(readEvents({ type: "schema_repair_invoked" }).events).toEqual([]);
  });

  test("each schema-repair dispatch reads the credential current at that call", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");
    const { listProposals } = await import("../../../src/commands/proposal/repository");
    const stashDir = makeTempDir("akm-m3-schema-batch-rotation-");
    const files = new Map<string, string>();
    for (const name of ["first", "second"]) {
      const ref = `memories/${name}`;
      const file = path.join(stashDir, "memories", `${name}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\n---\n${name} body.\n`, "utf8");
      files.set(ref, file);
    }
    configureStash(stashDir);
    const original = "schema-original-secret";
    const rotated = "schema-rotated-secret";
    const observed: Array<string | undefined> = [];

    const result = await withEnv({ AKM_SCHEMA_BATCH_KEY: original }, () =>
      runSchemaRepairPass(
        [
          { ref: "memories/first", reason: "missing description" },
          { ref: "memories/second", reason: "missing description" },
        ],
        {
          startMs: Date.now(),
          budgetMs: 30_000,
          stashDir,
          llmRunner: {
            kind: "llm",
            engine: "repair",
            connection: { endpoint: "http://localhost/v1/chat", model: "test" },
            credential: { names: ["AKM_SCHEMA_BATCH_KEY"], required: true },
          },
          findFilePath: async (ref) => files.get(ref) ?? null,
          isLessonCandidateFn: () => false,
          chatFn: async (connection) => {
            observed.push(connection.apiKey);
            if (observed.length === 1) mutateScopedEnv("AKM_SCHEMA_BATCH_KEY", rotated);
            return JSON.stringify({ description: `Description ${observed.length}` });
          },
        },
      ),
    );

    expect(result.repairs.map((repair) => repair.outcome)).toEqual(["queued", "queued"]);
    expect(observed).toEqual([original, rotated]);
    const persisted = JSON.stringify(listProposals(stashDir));
    expect(persisted).not.toContain(original);
    expect(persisted).not.toContain(rotated);
  });

  test("runSchemaRepairPass requires stashDir instead of bypassing the proposal queue", async () => {
    const { runSchemaRepairPass } = await import("../../../src/commands/sources/schema-repair");

    const stashDir = makeTempDir("akm-m3-fallback-");
    const memFile = path.join(stashDir, "memories", "auth2.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, "---\n---\nAuth content.\n", "utf8");

    await expect(
      runSchemaRepairPass([{ ref: "memories/auth2", reason: "missing description" }], {
        startMs: Date.now(),
        budgetMs: 30_000,
        llmRunner: testLlmRunner({ endpoint: "http://localhost/v1/chat", model: "test" }),
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
  // resolution via AKM_BUNDLE_DIR env only) to prove the call chain no longer
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
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      engines: {
        default: { kind: "llm", endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "test" },
      },
      defaults: { llmEngine: "default" },
    });

    const { appendEvent: appendFeedbackEvent } = await import("../../../src/core/events");
    appendFeedbackEvent({
      eventType: "feedback",
      ref: durableRef("lessons/no-description"),
      metadata: { signal: "positive" },
    });

    const reflectFn = async ({ ref }: { ref?: string }): Promise<AkmReflectResult> => ({
      schemaVersion: 2,
      ok: true,
      proposal: makeProposal(ref ?? "lessons/no-description"),
      ref: ref ?? "",
      engine: "test",
      durationMs: 1,
    });
    const distillFn = async ({ ref }: { ref: string }): Promise<AkmDistillResult> => ({
      schemaVersion: 1,
      ok: true,
      outcome: "queued",
      inputRef: ref,
      proposalRef: `lessons/${ref.replace(/[:/]/g, "-")}-lesson`,
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
        proposal: makeProposal(ref ?? "memories/auth-guide"),
        ref: ref ?? "",
        engine: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
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
                // Keep this explicit so the test pins the zero-SIGNAL gate,
                // independent of strategy defaults.
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
          proposal: makeProposal(ref ?? "memories/mem-1"),
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
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
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
        proposal: makeProposal(ref ?? "memories/alpha"),
        ref: ref ?? "",
        engine: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // Both fields must be present and be non-negative integers.
    expect(typeof result.orphansPurged).toBe("number");
    expect(result.orphansPurged).toBeGreaterThanOrEqual(0);
    expect(typeof result.reflectCooldownActions).toBe("number");
    expect(result.reflectCooldownActions).toBeGreaterThanOrEqual(0);
  });

  test("orphansPurged increments for pending proposals targeting refs absent from disk", async () => {
    const { createProposal } = await import("../../../src/commands/proposal/repository");
    const stashDir = makeTempDir("akm-m8-orphan-");
    // Write one real memory so improve has something to process.
    writeMemory(stashDir, "real-asset", { description: "Real memory" }, "Real content.");
    await buildIndex(stashDir);

    // Seed a pending reflect proposal for a ref that does NOT exist on disk.
    createProposal(stashDir, {
      ref: "memories/ghost-asset",
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
        proposal: makeProposal(ref ?? "memories/real-asset"),
        ref: ref ?? "",
        engine: "test",
        durationMs: 1,
      }),
      distillFn: async ({ ref }) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued" as const,
        inputRef: ref,
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
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
    const { createProposal, getProposal, listProposals } = await import("../../../src/commands/proposal/repository");
    const stashDir = makeTempDir("akm-6a-no-gate-");
    writeMemory(stashDir, "target-asset", { description: "Existing memory" }, "Existing body.");
    await buildIndex(stashDir);

    // The mock reflectFn persists a real proposal with confidence 0.95 — under
    // the deleted gate's default threshold (0.9) this WOULD have auto-promoted.
    // scope is a specific ref so collectEligibleRefs unconditionally plans it.
    const result = await akmImprove({
      scope: "memories/target-asset",
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
          ref: ref ?? "memories/target-asset",
          source: "reflect",
          sourceRun: "test-confidence-high",
          payload: {
            content: `---\ndescription: Updated memory\n---\n\nNEW BODY.\n`,
            frontmatter: { description: "Updated memory" },
          },
          confidence: 0.95,
        });
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
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    // The proposal stays pending with its confidence preserved for reviewers.
    const pending = listProposals(stashDir, { status: "pending", ref: "memories/target-asset" });
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
    const { createProposal } = await import("../../../src/commands/proposal/repository");
    const stashDir = makeTempDir("akm-6b-expired-");
    writeMemory(stashDir, "live-asset", { description: "Live memory" }, "Live body.");
    await buildIndex(stashDir);

    // Seed a stale proposal that should be expired. We seed it on a ref that
    // exists on disk so the orphan-purge pass does not race the expiration
    // pass and pre-archive it.
    const STALE_AGE_MS = 200 * 86_400_000;
    createProposal(
      stashDir,
      {
        ref: "memories/live-asset",
        source: "reflect",
        sourceRun: "test-stale",
        payload: { content: "# Stale proposal\nOld content." },
      },
      { now: () => Date.now() - STALE_AGE_MS },
    );

    const result = await akmImprove({
      scope: "memories/live-asset",
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
        proposalRef: `lessons/${ref?.replace(/[:/]/g, "-") ?? "missing"}-lesson`,
      }),
    });

    expect(result.proposalsExpired).toBeGreaterThanOrEqual(1);
    // The expired proposal must have been emitted as a `proposal_expired` event.
    const expiredEvents = readEvents({ type: "proposal_expired" });
    expect(expiredEvents.events.some((e) => e.ref === durableRef("memories/live-asset"))).toBe(true);
  });
});
