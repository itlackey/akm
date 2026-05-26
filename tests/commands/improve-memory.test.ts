import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../src/commands/distill";
import { akmImprove } from "../../src/commands/improve";
import type { AkmReflectResult } from "../../src/commands/reflect";
import { akmSearch } from "../../src/commands/search";
import { saveConfig } from "../../src/core/config";
import { appendEvent } from "../../src/core/events";
import type { Proposal } from "../../src/core/proposals";
import { akmIndex } from "../../src/indexer/indexer";
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

    // 0.8.0: signal-delta gate requires recent feedback to make the parent
    // memory eligible for reflect/distill. Without this the test's
    // reflectFn / distillFn assertions don't fire.
    appendEvent({
      eventType: "feedback",
      ref: "memory:deploy",
      metadata: { signal: "positive" },
    });

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
});
