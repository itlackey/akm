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
import { setQuiet } from "../../src/core/warn";
import type { GraphExtractionResult } from "../../src/indexer/graph-extraction";
import { akmIndex } from "../../src/indexer/indexer";
import type { MemoryInferenceResult } from "../../src/indexer/memory-inference";
import { getWebsiteCachePaths } from "../../src/sources/website-ingest";

const tempDirs: string[] = [];

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
  // Env-var restoration is handled by the global harness (_preload.ts).
  // Only clean up temp dirs created in this test.
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
      // session_extraction defaults on (a30d7dd, 2026-05-26). When the host
      // happens to have `~/.claude/projects` or opencode session dirs (typical
      // for dev machines), getAvailableHarnesses() returns harnesses and the
      // extract pass runs — fails with "No LLM connection configured for
      // extract" because this test does not configure an LLM. Disable extract
      // here so the test's `memoryCleanup?.warnings` assertion is not
      // contaminated by host-env-dependent extract failures.
      config: {
        semanticSearchMode: "off",
        profiles: { improve: { default: { processes: { extract: { enabled: false } } } } },
      },
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

  // ── Merged from improve-memory-cleanup2.test.ts (same describe title) ────────

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
  }, 60_000);

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

  test("ref with new feedback signal after the last reflect proposal is reflect-eligible (0.8.0 signal-delta)", async () => {
    const stashDir = makeTempDir("akm-improve-memory-accepted-bypass-");
    writeMemory(stashDir, "deploy", { description: "deploy memory" }, "Remember deploy details.");
    await buildIndex(stashDir);

    const reflectedRefs: string[] = [];
    const now = Date.now();
    // Old reflect_invoked event, then a NEWER feedback event → signal-delta
    // gate passes (new signal arrived since the last proposal).
    appendEvent({ eventType: "reflect_invoked", ref: "memory:deploy" }, { now: () => now - 24 * 60 * 60 * 1000 });
    appendEvent({ eventType: "feedback", ref: "memory:deploy", metadata: { signal: "positive" } }, { now: () => now });

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
    // 0.8.0: refs without any new feedback signal are fully skipped at the
    // planner level (signal-delta gate). The synthetic distill-skipped
    // action carries the new "no new signal since last proposal" reason.
    expect(
      result.actions?.some(
        (action) =>
          action.ref === "memory:deploy" &&
          action.mode === "distill-skipped" &&
          "reason" in action.result &&
          (action.result.reason === "no new signal since last proposal" ||
            action.result.reason === "memory requires recent feedback signal"),
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
      memoryInferenceFn: async ({ options }) => {
        inferredRefs.push([...(options?.candidateRefs ?? new Set<string>())].sort());
        return {
          considered: 1,
          splitParents: 1,
          writtenFacts: 1,
          skippedNoFacts: 0,
          skippedChildExists: 0,
          skippedAborted: 0,
          unaccounted: 0,
          htmlErrorCount: 0,
          cacheHits: 0,
          retryAttempts: 0,
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
      skippedChildExists: 0,
      skippedAborted: 0,
      unaccounted: 0,
      htmlErrorCount: 0,
      cacheHits: 0,
      retryAttempts: 0,
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
          skippedChildExists: 0,
          skippedAborted: 0,
          unaccounted: 0,
          htmlErrorCount: 0,
          cacheHits: 0,
          retryAttempts: 0,
        } satisfies MemoryInferenceResult;
      },
      graphExtractionFn: async ({ options }) => {
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

    // setQuiet(false): the harness sets quiet=true by default; opt back into
    // noisy mode so that info()/warn() calls from production code reach the
    // warnSpy and the progress-line assertions below can see them.
    setQuiet(false);
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
        graphExtractionFn: async ({ onProgress }) => {
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
      setQuiet(true); // restore harness default before tripwire check
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
        skippedChildExists: 0,
        skippedAborted: 0,
        unaccounted: 0,
        htmlErrorCount: 0,
        cacheHits: 0,
        retryAttempts: 0,
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

  // 0.8.0: this test invokes akmImprove twice end-to-end against a real (empty)
  // stash; the planner + consolidate journal check together routinely take
  // 4–6 s, which exceeds Bun's 5 s default per-test timeout under full-suite
  // load. Give it a comfortable margin so it stays green when the suite is
  // warm and the system is busy.
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
            improve: { default: { processes: { consolidate: { enabled: true }, extract: { enabled: false } } } },
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
            improve: { default: { processes: { consolidate: { enabled: true }, extract: { enabled: false } } } },
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
  }, 30_000);

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
          improve: { default: { processes: { consolidate: { enabled: true }, extract: { enabled: false } } } },
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
