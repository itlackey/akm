/**
 * Regression test: improve must not dispatch unsupported asset types (script,
 * vault, task, …) to the reflect path.
 *
 * Before this fix, `src/commands/reflect.ts` contained an internal guard
 * (REFLECT_ALLOWED_TYPES) that rejected non-markdown-canonical types with a
 * `parse_error`, but the improve loop dispatched those refs unconditionally —
 * they burned a reflect slot and recorded `reflect-failed` actions. In the
 * 2026-05-22T05:10 run, 2 of 4 reflect-failed actions were script-type rejections.
 *
 * The fix exports REFLECT_ALLOWED_TYPES from reflect.ts and adds a pre-check
 * in the improve loop at the reflect dispatch site: refs whose type is NOT in
 * the set are short-circuited with mode `reflect-skipped` and reason
 * `"unsupported-type"` instead of calling akmReflect.
 *
 * This test pins the planner-side contract:
 *
 *   1. A stash containing a `script:*` ref that would otherwise be a reflect
 *      candidate never causes akmReflect to be called.
 *   2. The action for that ref is recorded as `reflect-skipped` with reason
 *      `"type-filter"` (not `reflect-failed`) so the run summary is not polluted.
 *   3. A co-located `skill:*` ref (an allowed type) IS reflected normally —
 *      the guard does not accidentally block allowed types.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectOptions, AkmReflectResult } from "../../../src/commands/improve/reflect";
import { REFLECT_ALLOWED_TYPES } from "../../../src/commands/improve/reflect";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { withTestImproveLlm } from "../../_helpers/improve-config";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function indexStash(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

function makeStubReflectResult(ref: string): AkmReflectResult {
  return {
    schemaVersion: 2,
    ok: true,
    ref,
    engine: "test-agent",
    durationMs: 1,
    proposal: {
      id: `reflect-${ref.replace(/[^a-z0-9]/gi, "-")}`,
      ref,
      status: "pending",
      source: "reflect",
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
      payload: { content: "# stub reflect" },
      changes: [{ path: "", after: "# stub reflect", op: "update" }],
    },
  };
}

function makeStubDistillResult(ref: string): AkmDistillResult {
  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef: ref,
    lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
  };
}

beforeEach(() => {
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-reflect-unsupported-type-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-improve-reflect-unsupported-type-state-");
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-reflect-unsupported-type-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-reflect-unsupported-type-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.AKM_DATA_DIR === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = savedEnv.AKM_DATA_DIR;
  if (savedEnv.AKM_STATE_DIR === undefined) delete process.env.AKM_STATE_DIR;
  else process.env.AKM_STATE_DIR = savedEnv.AKM_STATE_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("REFLECT_ALLOWED_TYPES export", () => {
  test("does not include 'script'", () => {
    expect(REFLECT_ALLOWED_TYPES.has("script")).toBe(false);
  });

  test("does not include 'vault'", () => {
    expect(REFLECT_ALLOWED_TYPES.has("vault")).toBe(false);
  });

  test("does not include 'task'", () => {
    expect(REFLECT_ALLOWED_TYPES.has("task")).toBe(false);
  });

  test("includes all markdown-canonical types", () => {
    for (const t of ["knowledge", "memory", "lesson", "skill", "agent", "command", "workflow"]) {
      expect(REFLECT_ALLOWED_TYPES.has(t)).toBe(true);
    }
  });
});

describe("improve loop: unsupported-type reflect pre-check", () => {
  test("script:* ref is recorded as reflect-skipped, not reflect-failed, and akmReflect is NOT called", async () => {
    const stash = makeTempDir("akm-improve-reflect-unsupported-stash-");

    // Create a script asset — stored under scripts/ with a .sh extension.
    fs.mkdirSync(path.join(stash, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(stash, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho 'deploy'\n", "utf8");

    // Also create a skill so we can assert that allowed types still flow through.
    fs.mkdirSync(path.join(stash, "skills", "deploy-guide"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "deploy-guide", "SKILL.md"),
      "---\ndescription: Deploy guide\nwhen_to_use: When deploying\n---\n\nDeploy carefully.\n",
      "utf8",
    );

    await indexStash(stash);

    // Inject positive feedback so both refs pass the signal filter inside improve.
    appendEvent({ eventType: "feedback", ref: "script:deploy.sh", metadata: { signal: "positive", note: "fixture" } });
    appendEvent({
      eventType: "feedback",
      ref: "skill:deploy-guide",
      metadata: { signal: "positive", note: "fixture" },
    });

    const reflectCalls: AkmReflectOptions[] = [];

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async (options): Promise<AkmReflectResult> => {
        reflectCalls.push(options);
        return makeStubReflectResult(options.ref ?? "unknown");
      },
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    // Core assertion 1: akmReflect was never called for the script ref.
    const reflectedRefs = reflectCalls.map((c) => c.ref ?? "");
    expect(reflectedRefs.filter((r) => r.startsWith("script:"))).toEqual([]);

    // Core assertion 2: 2026-05-27 planner pre-filter — script:* refs are
    // refused by BOTH reflect and distill on the default profile, so the
    // planner drops them before queueing. They MUST NOT appear in
    // `plannedRefs` and they MUST NOT produce any per-ref action (no
    // reflect-skipped, no distill-skipped). Previously each such ref produced
    // 2× synthetic skip actions per cron run; that audit trail is now a
    // single `improve_skipped` event with reason `strategy_filtered_all_passes`
    // plus an envelope entry under `strategyFilteredRefs`.
    const scriptRefsInPlan = (result.plannedRefs ?? []).filter((p) => p.ref === "script:deploy.sh");
    expect(scriptRefsInPlan).toEqual([]);
    const scriptActions = (result.actions ?? []).filter((a) => a.ref === "script:deploy.sh");
    expect(scriptActions).toEqual([]);
    const strategyFiltered = result.strategyFilteredRefs ?? [];
    const scriptFiltered = strategyFiltered.filter((p) => p.ref === "script:deploy.sh");
    expect(scriptFiltered.length).toBe(1);
    expect(scriptFiltered[0]?.reason).toBe("strategy_filtered_all_passes");

    // Core assertion 3: the allowed-type skill ref IS reflected normally (type
    // guard must not block allowed types).
    const skillActions = (result.actions ?? []).filter((a) => a.ref === "skill:deploy-guide");
    const skillReflectActions = skillActions.filter((a) => a.mode === "reflect");
    expect(skillReflectActions.length).toBeGreaterThan(0);
  });
});

describe("improve loop: inner reflect type-guard fallback maps to reflect-skipped (not failed)", () => {
  test("reflectFn returning reason `unsupported_type` is recorded as `reflect-skipped`, not `reflect-failed`", async () => {
    // This covers the residual case where the planner-side `shouldSkipRef`
    // pre-check is bypassed (e.g. an allowed-type ref is dispatched but
    // reflect's internal type guard still fires due to an out-of-band classify
    // mismatch). Previously, reflect.ts returned `reason: "parse_error"` and
    // the loop emitted `reflect-failed`, inflating the LLM-failure rate by
    // ~9% on the user's stack. After the 2026-05-26 follow-up, reflect.ts
    // returns `reason: "unsupported_type"` and the loop maps it to
    // `reflect-skipped`. See metrics-taxonomy-review §1a.
    const stash = makeTempDir("akm-improve-reflect-typerefused-fallback-stash-");
    fs.mkdirSync(path.join(stash, "skills", "deploy-guide"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "deploy-guide", "SKILL.md"),
      "---\ndescription: Deploy guide\nwhen_to_use: When deploying\n---\n\nDeploy carefully.\n",
      "utf8",
    );
    await indexStash(stash);
    appendEvent({
      eventType: "feedback",
      ref: "skill:deploy-guide",
      metadata: { signal: "positive", note: "fixture" },
    });

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      // Force the inner-guard return path: simulate reflect.ts refusing the
      // ref with the new `unsupported_type` reason even though the planner
      // dispatched it (an allowed-type skill ref).
      reflectFn: async (options): Promise<AkmReflectResult> => ({
        schemaVersion: 2,
        ok: false,
        reason: "unsupported_type",
        error: `Reflect refused: asset type "script" is not supported by reflect.`,
        ref: options.ref ?? "unknown",
        exitCode: null,
      }),
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    const skillActions = (result.actions ?? []).filter((a) => a.ref === "skill:deploy-guide");
    expect(skillActions.length).toBeGreaterThan(0);
    // MUST be reflect-skipped, NOT reflect-failed.
    expect(skillActions.filter((a) => a.mode === "reflect-failed")).toEqual([]);
    expect(skillActions.filter((a) => a.mode === "reflect-skipped").length).toBeGreaterThan(0);
  });
});

describe("improve envelope: per-phase wall-clock durations are emitted at the top level", () => {
  test("memoryInferenceDurationMs and graphExtractionDurationMs surface on the result envelope when the passes run", async () => {
    // The `health.ts#summarizeImproveRuns` `wallTime.byPhase` aggregator (and
    // the older `metrics.{memoryInference,graphExtraction}.durationMs`
    // rollups) all read these fields directly off the top of the envelope.
    // Until the 2026-05-26 follow-up they were captured locally in
    // improve.ts and only emitted on the `improve_completed` event — never
    // on the persisted result envelope — so every byPhase median came back
    // as zero. This test pins the top-level surfacing so the aggregator
    // has data to chew on.
    const stash = makeTempDir("akm-improve-byphase-emission-stash-");
    fs.mkdirSync(path.join(stash, "skills", "byphase-fixture"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "byphase-fixture", "SKILL.md"),
      "---\ndescription: Fixture\nwhen_to_use: When testing byPhase emission\n---\n\nFixture body.\n",
      "utf8",
    );
    await indexStash(stash);
    // graph_extraction defaults enabled when the feature key is absent
    // (see tests/llm-feature-gate.test.ts) — no explicit config opt-in.
    appendEvent({
      eventType: "feedback",
      ref: "skill:byphase-fixture",
      metadata: { signal: "positive", note: "fixture" },
    });

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async (options): Promise<AkmReflectResult> => ({
        schemaVersion: 2,
        ok: true,
        ref: options.ref ?? "unknown",
        engine: "test-agent",
        durationMs: 1,
        proposal: {
          id: `reflect-${(options.ref ?? "x").replace(/[^a-z0-9]/gi, "-")}`,
          ref: options.ref ?? "unknown",
          status: "pending",
          source: "reflect",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          payload: { content: "# stub reflect" },
          changes: [{ path: "", after: "# stub reflect", op: "update" }],
        },
      }),
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
      // Inject memory inference + graph extraction passes that simulate
      // taking measurable wall-clock time. The improve loop wraps these
      // calls with Date.now() bookends, so the envelope MUST end up with
      // a non-zero `memoryInferenceDurationMs` / `graphExtractionDurationMs`
      // at the top level.
      memoryInferenceFn: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          schemaVersion: 1 as const,
          considered: 0,
          splitParents: 0,
          writtenFacts: 0,
          retiredParents: 0,
          skippedNoFacts: 0,
          skippedConflict: 0,
          skippedRateLimited: 0,
          skippedBudget: 0,
          unaccounted: 0,
          htmlErrorCount: 0,
          cacheHits: 0,
          retryAttempts: 0,
          skippedChildExists: 0,
          skippedAborted: 0,
          warnings: [],
        };
      },
      graphExtractionFn: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          schemaVersion: 1 as const,
          considered: 0,
          extracted: 0,
          totalEntities: 0,
          totalRelations: 0,
          written: false,
          quality: {
            consideredFiles: 0,
            extractedFiles: 0,
            emptyFiles: 0,
            failedFiles: 0,
            extractionCoverage: 0,
            density: 0,
            entityCount: 0,
            relationCount: 0,
            genericEntityRatio: 0,
            lowConfidenceRatio: 0,
          },
          files: [],
          telemetry: {
            failureCount: 0,
            failuresByReason: {},
            cacheHits: 0,
            cacheMisses: 0,
            truncationCount: 0,
            retryAttempts: 0,
          },
        };
      },
    });

    // Top-level emission contract — both fields land on the envelope and
    // carry a strictly-positive duration. The aggregator filters by `> 0`,
    // so a zero would silently drop the sample.
    expect(typeof result.memoryInferenceDurationMs).toBe("number");
    expect(result.memoryInferenceDurationMs ?? 0).toBeGreaterThan(0);
    expect(typeof result.graphExtractionDurationMs).toBe("number");
    expect(result.graphExtractionDurationMs ?? 0).toBeGreaterThan(0);
  });
});
