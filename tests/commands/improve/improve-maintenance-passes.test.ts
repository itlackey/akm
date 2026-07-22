// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.7 — focused unit coverage for the maintenance passes extracted from
 * `runImproveMaintenancePasses` / its `withIndexWriterLease` callback (R31
 * decomposition, testability requirement).
 *
 * Each pass is driven directly with injected `memoryInferenceFn` /
 * `graphExtractionFn` / `reindexWithIndexDbReleased` seams — no LLM, no real
 * index.db — and its returned result object is asserted instead of the old
 * shared closure state. The #584/#585 db-handle and borrowed-connection
 * contracts keep their own integration suite (`improve-db-locking.test.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type IndexDbCell,
  type MaintenanceCtx,
  runGraphExtractionMaintenancePass,
  runMemoryInferenceMaintenancePass,
  runRetentionPurgePass,
} from "../../../src/commands/improve/loop-stages";
import type { AkmConfig } from "../../../src/core/config/config";
import type { GraphExtractionResult } from "../../../src/indexer/graph/graph-extraction";
import type { MemoryInferenceResult } from "../../../src/indexer/passes/memory-inference";
import type { Database } from "../../../src/storage/database";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshStash(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

const fakeDb = { __fake: "index-db" } as unknown as Database;

function inferenceResult(overrides: Partial<MemoryInferenceResult> = {}): MemoryInferenceResult {
  return { processed: 0, writtenFacts: 0, skippedNoFacts: 0, splitParents: 0, ...overrides } as MemoryInferenceResult;
}

function graphResult(): GraphExtractionResult {
  return {
    quality: { extractedFiles: 1, entityCount: 2, relationCount: 3 },
  } as unknown as GraphExtractionResult;
}

function makeCtx(stashDir: string, overrides: Partial<MaintenanceCtx> = {}): MaintenanceCtx {
  return {
    config: {} as AkmConfig,
    sources: [{ name: "primary", path: stashDir } as MaintenanceCtx["sources"][number]],
    primaryStashDir: stashDir,
    memoryInferenceFn: () => {
      throw new Error("memoryInferenceFn not expected in this scenario");
    },
    graphExtractionFn: () => {
      throw new Error("graphExtractionFn not expected in this scenario");
    },
    reindexWithIndexDbReleased: () => {
      throw new Error("reindex not expected in this scenario");
    },
    ...overrides,
  };
}

describe("runMemoryInferenceMaintenancePass", () => {
  test("profile-disabled gate skips without invoking the seam", async () => {
    const stash = freshStash();
    const ctx = makeCtx(stash, {
      improveProfile: { processes: { memoryInference: { enabled: false } } } as MaintenanceCtx["improveProfile"],
    });

    const out = await runMemoryInferenceMaintenancePass(ctx, { current: fakeDb }, new Set());

    expect(out.memoryInference).toBeUndefined();
    expect(out.action).toBeUndefined();
    expect(out.durationMs).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  test("minPendingCount gate skips when the stash has fewer pending parents", async () => {
    const stash = freshStash();
    const ctx = makeCtx(stash, {
      improveProfile: { processes: { memoryInference: { minPendingCount: 5 } } } as MaintenanceCtx["improveProfile"],
    });

    const out = await runMemoryInferenceMaintenancePass(ctx, { current: fakeDb }, new Set());

    expect(out.memoryInference).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  test("success returns the result, the memories/_inference action, and the pass duration", async () => {
    const stash = freshStash();
    const result = inferenceResult({ writtenFacts: 3, splitParents: 1 });
    let receivedDb: unknown;
    const ctx = makeCtx(stash, {
      memoryInferenceFn: (args) => {
        receivedDb = (args as { db?: unknown }).db;
        return Promise.resolve(result);
      },
    });

    const out = await runMemoryInferenceMaintenancePass(ctx, { current: fakeDb }, new Set(["memories/a"]));

    expect(out.memoryInference).toBe(result);
    expect(out.action).toEqual({ ref: "memories/_inference", mode: "memory-inference", result });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.warnings).toEqual([]);
    // The pass hands the CURRENT cell handle to the inference call (#584).
    expect(receivedDb).toBe(fakeDb);
  });

  test("a seam failure is converted to the exact legacy warning", async () => {
    const stash = freshStash();
    const ctx = makeCtx(stash, {
      memoryInferenceFn: () => Promise.reject(new Error("inference exploded")),
    });

    const out = await runMemoryInferenceMaintenancePass(ctx, { current: fakeDb }, new Set());

    expect(out.memoryInference).toBeUndefined();
    expect(out.action).toBeUndefined();
    expect(out.warnings).toEqual(["memory inference failed: inference exploded"]);
  });
});

describe("runGraphExtractionMaintenancePass", () => {
  const baseArgs = {
    actionableRefs: [],
    memoryRefsForInference: new Set<string>(),
    reindexedAfterInference: false,
  };

  test("profile-disabled gate skips without invoking the seam", async () => {
    const stash = freshStash();
    const ctx = makeCtx(stash, {
      improveProfile: { processes: { graphExtraction: { enabled: false } } } as MaintenanceCtx["improveProfile"],
    });

    const out = await runGraphExtractionMaintenancePass(ctx, { current: fakeDb }, baseArgs);

    expect(out.graphExtraction).toBeUndefined();
    expect(out.action).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  test("feature-gate off (no resolvedPlan) skips without invoking the seam", async () => {
    const stash = freshStash();
    // No resolvedPlan → the gate falls back to `index.graph.enabled` (default
    // ON — gate on the code, not comments); disable it explicitly.
    const ctx = makeCtx(stash, { config: { index: { graph: { enabled: false } } } as AkmConfig });

    const out = await runGraphExtractionMaintenancePass(ctx, { current: fakeDb }, baseArgs);

    expect(out.graphExtraction).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  test("D9: consolidationRan without a prior reindex triggers the released-handle reindex", async () => {
    const stash = freshStash();
    const calls: string[] = [];
    const cell: IndexDbCell = { current: fakeDb };
    const freshHandle = { __fake: "post-reindex" } as unknown as Database;
    let dbAtInvoke: unknown;
    const ctx = makeCtx(stash, {
      resolvedPlan: {
        processes: { graphExtraction: { runner: null }, memoryInference: { runner: null } },
      } as unknown as MaintenanceCtx["resolvedPlan"],
      reindexWithIndexDbReleased: (dir) => {
        calls.push(dir);
        cell.current = freshHandle; // the helper swaps in a fresh handle
        return Promise.resolve();
      },
      graphExtractionFn: (args) => {
        dbAtInvoke = (args as { db?: unknown }).db;
        return Promise.resolve(graphResult());
      },
    });

    const out = await runGraphExtractionMaintenancePass(ctx, cell, { ...baseArgs, consolidationRan: true });

    expect(calls).toEqual([stash]);
    // The extraction call must see the POST-reindex handle, not the stale one.
    expect(dbAtInvoke).toBe(freshHandle);
    expect(out.graphExtraction).toBeDefined();
    expect(out.action).toEqual({
      ref: "graph/_artifact",
      mode: "graph-extraction",
      result: out.graphExtraction as GraphExtractionResult,
    });
  });

  test("reindexedAfterInference=true suppresses the D9 reindex", async () => {
    const stash = freshStash();
    const calls: string[] = [];
    const ctx = makeCtx(stash, {
      resolvedPlan: {
        processes: { graphExtraction: { runner: null }, memoryInference: { runner: null } },
      } as unknown as MaintenanceCtx["resolvedPlan"],
      reindexWithIndexDbReleased: (dir) => {
        calls.push(dir);
        return Promise.resolve();
      },
      graphExtractionFn: () => Promise.resolve(graphResult()),
    });

    await runGraphExtractionMaintenancePass(
      ctx,
      { current: fakeDb },
      { ...baseArgs, consolidationRan: true, reindexedAfterInference: true },
    );

    expect(calls).toEqual([]);
  });

  test("profile knobs (fullScan/topN/batchSize/includeTypes) reach the extraction options", async () => {
    const stash = freshStash();
    let received: { candidatePaths?: Set<string>; includeTypes?: string[]; batchSize?: number; topN?: number } = {};
    const ctx = makeCtx(stash, {
      improveProfile: {
        processes: {
          graphExtraction: { fullScan: true, topN: 7, batchSize: 3, includeTypes: ["memory"] },
        },
      } as MaintenanceCtx["improveProfile"],
      resolvedPlan: {
        processes: { graphExtraction: { runner: null }, memoryInference: { runner: null } },
      } as unknown as MaintenanceCtx["resolvedPlan"],
      graphExtractionFn: (args) => {
        received = (args as { options: typeof received }).options;
        return Promise.resolve(graphResult());
      },
    });

    await runGraphExtractionMaintenancePass(ctx, { current: fakeDb }, baseArgs);

    // fullScan → candidatePaths stays undefined (extractor processes all files).
    expect(received.candidatePaths).toBeUndefined();
    expect(received.includeTypes).toEqual(["memory"]);
    expect(received.batchSize).toBe(3);
    expect(received.topN).toBe(7);
  });

  test("a seam failure is converted to the exact legacy warning", async () => {
    const stash = freshStash();
    const ctx = makeCtx(stash, {
      resolvedPlan: {
        processes: { graphExtraction: { runner: null }, memoryInference: { runner: null } },
      } as unknown as MaintenanceCtx["resolvedPlan"],
      graphExtractionFn: () => Promise.reject(new Error("graph exploded")),
    });

    const out = await runGraphExtractionMaintenancePass(ctx, { current: fakeDb }, baseArgs);

    expect(out.graphExtraction).toBeUndefined();
    expect(out.warnings).toEqual(["graph extraction failed: graph exploded"]);
  });
});

describe("runRetentionPurgePass", () => {
  test("retentionDays=0 disables every purge (no state.db or logs.db touch)", () => {
    const stash = freshStash();
    const ctx = makeCtx(stash, {
      config: { improve: { eventRetentionDays: 0 } } as AkmConfig,
    });

    const out = runRetentionPurgePass(ctx);

    expect(out.warnings).toEqual([]);
  });

  test("default window runs the purges against a sandboxed state.db without warnings", () => {
    const stash = freshStash();
    const ctx = makeCtx(stash); // default config → 90d window

    const out = runRetentionPurgePass(ctx);

    // Empty sandboxed DBs: all purges succeed with zero rows removed.
    expect(out.warnings).toEqual([]);
  });
});
