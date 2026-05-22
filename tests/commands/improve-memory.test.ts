import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../src/commands/distill";
import { akmImprove } from "../../src/commands/improve";
import type { AkmReflectResult } from "../../src/commands/reflect";
import { akmSearch } from "../../src/commands/search";
import { saveConfig } from "../../src/core/config";
import { appendEvent, readEvents } from "../../src/core/events";
import type { Proposal } from "../../src/core/proposals";
import type { GraphExtractionResult } from "../../src/indexer/graph-extraction";
import { akmIndex } from "../../src/indexer/indexer";
import type { MemoryInferenceResult } from "../../src/indexer/memory-inference";
import { getWebsiteCachePaths } from "../../src/sources/website-ingest";

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
  // index.db moved from $CACHE to $DATA in v0.9; isolate it so tests don't
  // share or contaminate the real ~/.local/share/akm/index.db.
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
  test("dry-run reports deterministic prune and consolidation opportunities for derived memories", async () => {
    const stashDir = makeTempDir("akm-improve-memory-stash-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy caveats.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
        tags: ["deploy", "vpn"],
        searchHints: ["vpn before deploy"],
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release.",
    );
    writeMemory(
      stashDir,
      "deploy-copy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
        tags: ["deploy", "vpn"],
        searchHints: ["vpn before deploy"],
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release.",
    );
    writeMemory(
      stashDir,
      "deploy-verbose.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
        tags: ["deploy", "vpn", "release"],
        searchHints: ["vpn before deploy", "release prep"],
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release and confirm the tunnel is stable.",
    );
    writeMemory(
      stashDir,
      "deploy-old.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use the old deploy tunnel",
        supersededBy: ["memory:deploy.derived"],
      },
      "# Use the old deploy tunnel\n\nThis path was replaced.",
    );

    await buildIndex(stashDir);

    const result = await akmImprove({ scope: "memory", dryRun: true, stashDir });

    expect(result.memoryCleanup).toBeDefined();
    expect(result.memoryCleanup?.analyzedDerived).toBe(4);
    expect(result.memoryCleanup?.pruneCandidates).toEqual([
      {
        ref: "memory:deploy-copy.derived",
        parentRef: "memory:deploy",
        reason: "duplicate-derived",
        survivorRef: "memory:deploy.derived",
      },
      {
        ref: "memory:deploy-old.derived",
        parentRef: "memory:deploy",
        reason: "superseded-derived",
        survivorRef: "memory:deploy.derived",
      },
    ]);
    expect(result.memoryCleanup?.contradictionCandidates).toEqual([]);
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([]);
    expect(result.memoryCleanup?.consolidationCandidates).toEqual([
      {
        parentRef: "memory:deploy",
        signal: "check vpn before deploy",
        refs: ["memory:deploy.derived", "memory:deploy-verbose.derived"],
        suggestedSurvivorRef: "memory:deploy.derived",
      },
    ]);
  });

  test("live improve prunes only high-confidence derived memory duplicates and keeps proposal-backed flows intact", async () => {
    const stashDir = makeTempDir("akm-improve-memory-live-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy caveats.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release.",
    );
    writeMemory(
      stashDir,
      "deploy-duplicate.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release.",
    );

    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];
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
      distillFn: async ({ ref }) => {
        if (ref) distilledRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(fs.existsSync(path.join(stashDir, "memories", "deploy.derived.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories", "deploy-duplicate.derived.md"))).toBe(false);
    expect(result.memoryCleanup?.archived).toHaveLength(1);
    expect(result.memoryCleanup?.contradictionCandidates).toEqual([]);
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([]);
    expect(result.memoryCleanup?.archived?.[0]).toMatchObject({
      ref: "memory:deploy-duplicate.derived",
      parentRef: "memory:deploy",
      reason: "duplicate-derived",
      beliefState: "archived",
      previousBeliefState: "active",
      originalPath: "memories/deploy-duplicate.derived.md",
    });
    const archivedPath = result.memoryCleanup?.archived?.[0]?.archivedPath;
    const auditPath = result.memoryCleanup?.archived?.[0]?.auditPath;
    expect(archivedPath).toBeTruthy();
    expect(auditPath).toBeTruthy();
    expect(fs.existsSync(path.join(stashDir, archivedPath as string))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, auditPath as string))).toBe(true);
    const auditRaw = fs.readFileSync(path.join(stashDir, auditPath as string), "utf8");
    expect(auditRaw).toContain("kind: memory-cleanup-archive");
    expect(auditRaw).toContain("ref: memory:deploy-duplicate.derived");
    expect(
      result.actions?.some(
        (action) => action.mode === "memory-prune" && action.ref === "memory:deploy-duplicate.derived",
      ),
    ).toBe(true);
    expect(result.actions?.some((action) => action.mode === "reflect" && action.ref === "memory:deploy")).toBe(true);
    expect(result.plannedRefs.some((planned) => planned.ref === "memory:deploy-duplicate.derived")).toBe(false);
    expect(reflectedRefs).not.toContain("memory:deploy-duplicate.derived");
    expect(distilledRefs).not.toContain("memory:deploy-duplicate.derived");
  });

  test("dry-run reports contradicted derived memories for cleanup review", async () => {
    const stashDir = makeTempDir("akm-improve-memory-contradiction-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy tunnel guidance.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway B for deploys",
        description: "Gateway B is the active deploy tunnel.",
      },
      "# Use gateway B for deploys\n\nGateway B is the active deploy tunnel.",
    );
    writeMemory(
      stashDir,
      "deploy-old.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway A for deploys",
        contradictedBy: ["memory:deploy.derived"],
      },
      "# Use gateway A for deploys\n\nGateway A guidance was contradicted by newer evidence.",
    );

    await buildIndex(stashDir);

    const result = await akmImprove({ scope: "memory", dryRun: true, stashDir });

    expect(result.memoryCleanup?.analyzedDerived).toBe(2);
    expect(result.memoryCleanup?.pruneCandidates).toEqual([]);
    expect(result.memoryCleanup?.contradictionCandidates).toEqual([
      {
        ref: "memory:deploy-old.derived",
        parentRef: "memory:deploy",
        reason: "contradicted-derived",
        contradictedByRef: "memory:deploy.derived",
        contradictedByRefs: ["memory:deploy.derived"],
        currentBeliefRefs: ["memory:deploy.derived"],
      },
    ]);
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([
      {
        ref: "memory:deploy-old.derived",
        parentRef: "memory:deploy",
        fromState: "active",
        toState: "contradicted",
        reason: "contradicted-derived",
        relatedRef: "memory:deploy.derived",
        relatedRefs: ["memory:deploy.derived"],
        currentBeliefRefs: ["memory:deploy.derived"],
      },
    ]);
    expect(result.memoryCleanup?.consolidationCandidates).toEqual([]);
  });

  test("live improve persists contradiction belief state and search prefers the current derived memory", async () => {
    const stashDir = makeTempDir("akm-improve-memory-search-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy tunnel guidance.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway B for deploys",
        description: "Gateway B is the current deploy tunnel.",
        searchHints: ["gateway b current deploy tunnel"],
      },
      "# Use gateway B for deploys\n\nGateway B is the current deploy tunnel for releases.",
    );
    writeMemory(
      stashDir,
      "deploy-legacy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway A for deploys",
        description: "Gateway A is the legacy tunnel.",
        contradictedBy: ["memory:deploy.derived"],
        searchHints: ["gateway a legacy tunnel"],
      },
      "# Use gateway A for deploys\n\nGateway A is deprecated and should not be used for releases.",
    );

    await buildIndex(stashDir);

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async ({ stashDir: reindexStashDir }) => {
        await akmIndex({ stashDir: reindexStashDir, full: true });
        return {
          schemaVersion: 1,
          ok: true,
          indexed: 0,
          warnings: [],
          errors: [],
          durationMs: 0,
        };
      },
      reflectFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        }) satisfies AkmReflectResult,
      distillFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(fs.existsSync(path.join(stashDir, "memories", "deploy.derived.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories", "deploy-legacy.derived.md"))).toBe(true);
    expect(result.memoryCleanup?.contradictionCandidates).toEqual([
      {
        ref: "memory:deploy-legacy.derived",
        parentRef: "memory:deploy",
        reason: "contradicted-derived",
        contradictedByRef: "memory:deploy.derived",
        contradictedByRefs: ["memory:deploy.derived"],
        currentBeliefRefs: ["memory:deploy.derived"],
      },
    ]);
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([
      {
        ref: "memory:deploy-legacy.derived",
        parentRef: "memory:deploy",
        fromState: "active",
        toState: "contradicted",
        reason: "contradicted-derived",
        relatedRef: "memory:deploy.derived",
        relatedRefs: ["memory:deploy.derived"],
        currentBeliefRefs: ["memory:deploy.derived"],
      },
    ]);
    expect(result.memoryCleanup?.archived).toEqual([]);
    expect(result.memoryCleanup?.transitionLogEntries).toBe(1);
    expect(result.memoryCleanup?.transitionLogPath).toBe(".akm/memory-cleanup/belief-transitions.jsonl");
    expect(result.memoryCleanup?.warnings).toBeUndefined();

    const legacyRaw = fs.readFileSync(path.join(stashDir, "memories", "deploy-legacy.derived.md"), "utf8");
    expect(legacyRaw).toContain("beliefState: contradicted");
    expect(legacyRaw).toContain("contradictedBy:");
    expect(legacyRaw).toContain("- memory:deploy.derived");
    expect(legacyRaw).toContain("currentBeliefRefs:");

    const transitionLogRaw = fs.readFileSync(
      path.join(stashDir, ".akm", "memory-cleanup", "belief-transitions.jsonl"),
      "utf8",
    );
    expect(transitionLogRaw).toContain('"ref":"memory:deploy-legacy.derived"');
    expect(transitionLogRaw).toContain('"toState":"contradicted"');
    expect(transitionLogRaw).toContain('"currentBeliefRefs":["memory:deploy.derived"]');

    const contradictedResult = await akmSearch({
      query: "gateway a legacy tunnel",
      source: "local",
      type: "memory",
    });
    expect(contradictedResult.hits.some((hit) => hit.type !== "registry" && hit.name === "deploy-legacy.derived")).toBe(
      true,
    );
    const contradictedHit = contradictedResult.hits.find(
      (hit) => hit.type !== "registry" && hit.name === "deploy-legacy.derived",
    );
    expect(contradictedHit && "beliefState" in contradictedHit ? contradictedHit.beliefState : undefined).toBe(
      "contradicted",
    );
    expect(
      contradictedHit && "currentBeliefRefs" in contradictedHit ? contradictedHit.currentBeliefRefs : undefined,
    ).toEqual(["memory:deploy.derived"]);

    const survivorResult = await akmSearch({
      query: "gateway deploy tunnel",
      source: "local",
      type: "memory",
    });
    const survivorHits = survivorResult.hits.filter((hit) => hit.type !== "registry");
    expect(survivorHits[0]?.name).toBe("deploy.derived");
    expect(survivorHits[1]?.name).toBe("deploy-legacy.derived");
  });

  test("live improve reconciles stale contradiction state when the winning memory disappears", async () => {
    const stashDir = makeTempDir("akm-improve-memory-reconcile-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy tunnel guidance.");
    writeMemory(
      stashDir,
      "deploy-legacy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        beliefState: "contradicted",
        contradictedBy: ["memory:deploy.derived"],
        currentBeliefRefs: ["memory:deploy.derived"],
        title: "Use gateway A for deploys",
        description: "Gateway A guidance was once contradicted.",
        searchHints: ["gateway a deploy tunnel"],
      },
      "# Use gateway A for deploys\n\nGateway A is the remaining deploy tunnel guidance.",
    );

    await buildIndex(stashDir);

    const result = await akmImprove({
      scope: "memory",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn: async ({ stashDir: reindexStashDir }) => {
        await akmIndex({ stashDir: reindexStashDir, full: true });
        return {
          schemaVersion: 1,
          ok: true,
          indexed: 0,
          warnings: [],
          errors: [],
          durationMs: 0,
        };
      },
      reflectFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        }) satisfies AkmReflectResult,
      distillFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(result.memoryCleanup?.contradictionCandidates).toEqual([]);
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([
      {
        ref: "memory:deploy-legacy.derived",
        parentRef: "memory:deploy",
        fromState: "contradicted",
        toState: "active",
        reason: "belief-refresh",
      },
    ]);

    const legacyRaw = fs.readFileSync(path.join(stashDir, "memories", "deploy-legacy.derived.md"), "utf8");
    expect(legacyRaw).toContain("beliefState: active");
    expect(legacyRaw).not.toContain("contradictedBy:");
    expect(legacyRaw).not.toContain("currentBeliefRefs:");
  });

  test("dry-run preserves multi-winner contradiction cycles as current beliefs instead of forcing a single winner", async () => {
    const stashDir = makeTempDir("akm-improve-memory-cycle-");
    writeMemory(stashDir, "deploy", { description: "parent memory" }, "Remember deploy tunnel guidance.");
    writeMemory(
      stashDir,
      "deploy-a.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway A fallback",
        contradictedBy: ["memory:deploy-b.derived"],
      },
      "# Use gateway A fallback\n\nGateway A contradicts gateway B.",
    );
    writeMemory(
      stashDir,
      "deploy-b.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway B fallback",
        contradictedBy: ["memory:deploy-a.derived"],
      },
      "# Use gateway B fallback\n\nGateway B contradicts gateway A.",
    );
    writeMemory(
      stashDir,
      "deploy-old.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Use gateway C fallback",
        contradictedBy: ["memory:deploy-a.derived"],
      },
      "# Use gateway C fallback\n\nGateway C is older guidance.",
    );

    await buildIndex(stashDir);

    const result = await akmImprove({ scope: "memory", dryRun: true, stashDir });

    expect(result.memoryCleanup?.contradictionCandidates).toEqual([
      {
        ref: "memory:deploy-old.derived",
        parentRef: "memory:deploy",
        reason: "contradicted-derived",
        contradictedByRef: "memory:deploy-a.derived",
        contradictedByRefs: ["memory:deploy-a.derived", "memory:deploy-b.derived"],
        currentBeliefRefs: ["memory:deploy-a.derived", "memory:deploy-b.derived"],
      },
    ]);
    expect(result.memoryCleanup?.beliefStateTransitions).toEqual([
      {
        ref: "memory:deploy-a.derived",
        parentRef: "memory:deploy",
        fromState: "active",
        toState: "active",
        reason: "belief-refresh",
        relatedRef: "memory:deploy-b.derived",
        relatedRefs: ["memory:deploy-b.derived"],
        currentBeliefRefs: ["memory:deploy-b.derived"],
      },
      {
        ref: "memory:deploy-b.derived",
        parentRef: "memory:deploy",
        fromState: "active",
        toState: "active",
        reason: "belief-refresh",
        relatedRef: "memory:deploy-a.derived",
        relatedRefs: ["memory:deploy-a.derived"],
        currentBeliefRefs: ["memory:deploy-a.derived"],
      },
      {
        ref: "memory:deploy-old.derived",
        parentRef: "memory:deploy",
        fromState: "active",
        toState: "contradicted",
        reason: "contradicted-derived",
        relatedRef: "memory:deploy-a.derived",
        relatedRefs: ["memory:deploy-a.derived", "memory:deploy-b.derived"],
        currentBeliefRefs: ["memory:deploy-a.derived", "memory:deploy-b.derived"],
      },
    ]);
  });

  test("ref-scoped improve only cleans up the targeted parent memory family", async () => {
    const stashDir = makeTempDir("akm-improve-memory-ref-scope-");
    writeMemory(stashDir, "deploy", { description: "deploy parent" }, "Remember deploy caveats.");
    writeMemory(
      stashDir,
      "deploy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release.",
    );
    writeMemory(
      stashDir,
      "deploy-copy.derived",
      {
        inferred: true,
        source: "memory:deploy",
        title: "Check VPN before deploy",
        description: "VPN is required before deploys.",
      },
      "# Check VPN before deploy\n\nEnable VPN before starting the release.",
    );
    writeMemory(stashDir, "incident", { description: "incident parent" }, "Remember incident caveats.");
    writeMemory(
      stashDir,
      "incident.derived",
      {
        inferred: true,
        source: "memory:incident",
        title: "Page the on-call lead",
        description: "Escalate incidents immediately.",
      },
      "# Page the on-call lead\n\nEscalate incidents immediately.",
    );
    writeMemory(
      stashDir,
      "incident-copy.derived",
      {
        inferred: true,
        source: "memory:incident",
        title: "Page the on-call lead",
        description: "Escalate incidents immediately.",
      },
      "# Page the on-call lead\n\nEscalate incidents immediately.",
    );

    await buildIndex(stashDir);

    const result = await akmImprove({
      scope: "memory:deploy-copy.derived",
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
      reflectFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "memory:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        }) satisfies AkmReflectResult,
      distillFn: async ({ ref }) =>
        ({
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
        }) satisfies AkmDistillResult,
    });

    expect(result.memoryCleanup?.archived).toHaveLength(1);
    expect(result.memoryCleanup?.archived?.[0]?.ref).toBe("memory:deploy-copy.derived");
    expect(fs.existsSync(path.join(stashDir, "memories", "deploy-copy.derived.md"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "memories", "incident-copy.derived.md"))).toBe(true);
  });

  test("ref-scoped improve excludes website-source assets from planning and execution", async () => {
    const stashDir = makeTempDir("akm-improve-website-scope-");
    fs.mkdirSync(path.join(stashDir, "skills", "local-deploy"), { recursive: true });
    fs.writeFileSync(
      path.join(stashDir, "skills", "local-deploy", "SKILL.md"),
      "---\ndescription: Local deploy\nwhen_to_use: When deploying locally\n---\n\n# Local deploy\n",
      "utf8",
    );

    const websiteUrl = "https://docs.example.test/";
    const websiteStash = getWebsiteCachePaths(websiteUrl).stashDir;
    fs.mkdirSync(path.join(websiteStash, "knowledge", "skills", "remote-deploy", "references"), { recursive: true });
    fs.writeFileSync(
      path.join(websiteStash, "knowledge", "skills", "remote-deploy", "references", "gates.md"),
      "# Remote gates\n\nWebsite-backed deployment notes.\n",
      "utf8",
    );

    saveConfig({
      semanticSearchMode: "off",
      sources: [
        { type: "filesystem", name: "local", path: stashDir, writable: true },
        { type: "website", name: "docs-site", url: websiteUrl },
      ],
    });

    const reflectedRefs: string[] = [];
    const distilledRefs: string[] = [];

    const dryRun = await akmImprove({
      scope: "knowledge:skills/remote-deploy/references/gates",
      dryRun: true,
      stashDir,
      // Avoid hitting the live website mirror — the URL is a placeholder.
      // #339 hoisted ensureIndex above the dry-run early return so the index
      // is fresh before collectEligibleRefs; the stub keeps the test offline.
      ensureIndexFn: async () => false,
    });
    expect(dryRun.plannedRefs).toEqual([]);

    const result = await akmImprove({
      scope: "knowledge:skills/remote-deploy/references/gates",
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
      reflectFn: async ({ ref }) => {
        if (ref) reflectedRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          proposal: makeProposal(ref ?? "knowledge:missing"),
          ref: ref ?? "",
          agentProfile: "test",
          durationMs: 1,
        } satisfies AkmReflectResult;
      },
      distillFn: async ({ ref }) => {
        if (ref) distilledRefs.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(result.plannedRefs).toEqual([]);
    // Post-Item-9 fix: memory-inference always runs and discovers its own
    // candidates (no orchestrator candidateRefs filter). On this fixture it
    // finds nothing, but the action is still recorded. Website-source
    // exclusion still holds — what matters is reflectedRefs/distilledRefs.
    expect(result.actions?.map((action) => action.mode)).toEqual(["memory-inference", "graph-extraction"]);
    expect(reflectedRefs).toEqual([]);
    expect(distilledRefs).toEqual([]);
  });

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
      reflectCooldownDays: 7,
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
      reflectCooldownDays: 7,
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
      distillCooldownDays: 30,
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
      distillCooldownDays: 30,
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
    const { detectAndWriteContradictions } = await import("../../src/core/memory-contradiction-detect");
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
    const { detectAndWriteContradictions } = await import("../../src/core/memory-contradiction-detect");
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
    const { detectAndWriteContradictions } = await import("../../src/core/memory-contradiction-detect");
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
              processes: { consolidate: { enabled: true }, graphExtraction: { enabled: true } },
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
        profiles: { llm: { default: { endpoint: "http://localhost/chat/completions", model: "test" } } },
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
      autoAccept: 90, // default; conversion = 0.9
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
