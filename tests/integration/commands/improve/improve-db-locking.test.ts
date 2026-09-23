// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * DB-locking regression tests for the improve maintenance pass.
 *
 * #584 — close index.db before reindexFn:
 *   `runImproveMaintenancePasses` held an open index.db handle while calling
 *   `reindexFn`, which opens its own write handle on the same WAL file. The
 *   two concurrent connections produced SQLITE_BUSY / "database is locked" in
 *   production. The fix closes the maintenance handle BEFORE every reindex and
 *   reopens it after (both reindex call sites route through one helper).
 *
 * #585 — reuse eventsCtx.db in the post-loop purge:
 *   The events/improve_runs retention purge opened a SECOND state.db write
 *   connection while the long-lived eventsCtx.db connection was still open —
 *   two simultaneous writers on the same WAL file ("database is locked"). The
 *   fix reuses eventsCtx.db when present; only the dbPath fallback path opens
 *   (and then owns and closes) its own handle.
 *
 * r3-1 — post-consolidation reindex requires an actual mutation:
 *   The post-consolidation branch of the same reindex seam used to fire
 *   whenever `consolidation.processed > 0` (memories the LLM judged), not
 *   whenever consolidation actually wrote anything. Merge/delete/contradict
 *   ops are advisory and never auto-applied (consolidate.ts), and the one op
 *   that does execute — promote — writes a proposal to state.db, not to the
 *   stash, so `processed > 0` was true on nearly every consolidating run
 *   while the reindex's own precondition (files on disk changed) almost
 *   never held.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmImprove, runImproveMaintenancePasses } from "../../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../../src/core/config/config";
import { loadConfig, saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { getDbPath } from "../../../../src/core/paths";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { GraphExtractionResult } from "../../../../src/indexer/graph/graph-extraction";
import { akmIndex } from "../../../../src/indexer/indexer";
import type { MemoryInferenceResult } from "../../../../src/indexer/passes/memory-inference";
import { _setChatCompletionForTests } from "../../../../src/llm/client";
import type { Database } from "../../../../src/storage/database";
import { insertEvent } from "../../../../src/storage/repositories/events-repository";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { getEntryByRef } from "../../../../src/storage/repositories/index-entries-repository";
import { withImproveAutonomy, withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage } from "../../../_helpers/sandbox";
import { overrideSeam } from "../../../_helpers/seams";

let storage: IsolatedAkmStorage;
const extraCleanups: Array<() => void> = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const cleanup of extraCleanups.splice(0)) cleanup();
  storage.cleanup();
});

async function indexStash(stashDir: string): Promise<void> {
  saveConfig(
    withImproveAutonomy(
      withTestImproveLlm({
        semanticSearchMode: "off",
        // Consolidation is a separate, still-full-reindex trigger (D9) —
        // disabled so these DB-locking tests exercise exactly the reindex
        // site each one names, not whichever one consolidation also fires.
        improve: { strategies: { default: { processes: { consolidate: { enabled: false } } } } },
      }),
    ),
  );
  await akmIndex({ stashDir, full: true });
}

function writeMemory(stashDir: string, name: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: memory ${name}\n---\n\nRemember ${name}.\n`, "utf8");
}

/** Path to a dedicated state.db in its own sandboxed temp dir. */
function makeStateDbPath(): string {
  const { dir, cleanup } = makeSandboxDir("akm-db-locking-statedb");
  extraCleanups.push(cleanup);
  return path.join(dir, "state.db");
}

/** True when the handle can still serve queries (i.e. it has NOT been closed). */
function isHandleOpen(db: Database | undefined): boolean {
  if (!db) return false;
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function stubMemoryInferenceResult(overrides?: Partial<MemoryInferenceResult>): MemoryInferenceResult {
  return {
    considered: 0,
    cacheHits: 0,
    retryAttempts: 0,
    splitParents: 0,
    writtenFacts: 0,
    skippedNoFacts: 0,
    skippedChildExists: 0,
    skippedAborted: 0,
    unaccounted: 0,
    htmlErrorCount: 0,
    writtenPaths: [],
    ...overrides,
  };
}

const stubGraphExtractionResult: GraphExtractionResult = {
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
  telemetry: { cacheHits: 0, cacheMisses: 0, truncationCount: 0, failureCount: 0, retryAttempts: 0 },
  warnings: [],
};

describe("#584: index.db handle is closed before reindexFn runs", () => {
  // #R78: memory inference's writes used to trigger a FULL reindex through
  // this same `reindexFn` seam (call site 1) — replaced with `indexWrittenAssets`
  // over exactly the paths the pass wrote. `indexWrittenAssets` opens its own
  // write handle on the same index.db WAL file, so the #584 discipline (close
  // the maintenance handle first, reopen a fresh one after, even on failure)
  // still applies — just around the incremental call instead of `reindexFn`.
  test("maintenance handle is closed during the post-inference index update and a fresh handle is used afterwards", async () => {
    const stash = storage.stashDir;
    writeMemory(stash, "alpha");
    await indexStash(stash);

    // A real file for indexWrittenAssets to upsert — the derived child memory
    // inference would have written.
    const derivedPath = path.join(stash, "memories", "alpha.derived.md");
    fs.writeFileSync(derivedPath, "---\ninferred: true\ndescription: derived alpha\n---\n\nDerived fact.\n", "utf8");

    let capturedInferenceDb: Database | undefined;
    let reindexCalls = 0;
    let handleOpenDuringGraphExtraction: boolean | undefined;
    let graphDb: Database | undefined;

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reflectFn: async (o) => ({
        schemaVersion: 2,
        ok: true,
        ref: o.ref ?? "unknown",
        engine: "test-agent",
        durationMs: 1,
        proposal: {
          id: `reflect-${(o.ref ?? "unknown").replace(/[^a-z0-9]/gi, "-")}`,
          ref: o.ref ?? "unknown",
          status: "pending",
          source: "reflect",
          createdAt: "2026-06-11T00:00:00.000Z",
          updatedAt: "2026-06-11T00:00:00.000Z",
          payload: { content: "# stub reflect" },
          changes: [{ path: "lessons/proposal.md", after: "# stub reflect", op: "update" }],
          proposedTarget: { source: "stash", root: "/tmp/stash" },
        },
      }),
      distillFn: async (o) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued",
        inputRef: o.ref,
        proposalRef: "lessons/stub",
      }),
      // Report a written path so the maintenance pass triggers the
      // post-inference incremental index (#584 call site 1, now indexWrittenAssets).
      memoryInferenceFn: async (ctx) => {
        capturedInferenceDb = ctx.db;
        return stubMemoryInferenceResult({
          considered: 1,
          splitParents: 1,
          writtenFacts: 1,
          writtenPaths: [derivedPath],
        });
      },
      reindexFn: async () => {
        reindexCalls += 1;
      },
      // Graph extraction runs after the incremental index and receives the
      // maintenance handle — it must be a fresh, usable handle.
      graphExtractionFn: async (ctx) => {
        graphDb = ctx.db;
        handleOpenDuringGraphExtraction = isHandleOpen(ctx.db);
        return stubGraphExtractionResult;
      },
    });

    expect(result.ok).toBe(true);
    // The incremental index path never calls the full-reindex seam.
    expect(reindexCalls).toBe(0);
    // The maintenance pass's index.db handle (captured above) must be CLOSED
    // by the time indexWrittenAssets ran — it opens its own write handle on
    // the same WAL file and a still-open sibling caused SQLITE_BUSY (#584).
    expect(isHandleOpen(capturedInferenceDb)).toBe(false);
    expect(handleOpenDuringGraphExtraction).toBe(true);
    // The post-index handle is a NEW connection, not the closed original.
    expect(graphDb).toBeDefined();
    expect(graphDb).not.toBe(capturedInferenceDb);

    // The derived file is indexed without a full reindex.
    const checkDb = openIndexDatabase(getDbPath());
    try {
      expect(getEntryByRef(checkDb, "memories/alpha.derived")).not.toBeNull();
    } finally {
      closeDatabase(checkDb);
    }
  });
});

describe("#585: post-loop purge reuses the long-lived eventsCtx.db connection", () => {
  test("purge runs through eventsCtx.db instead of opening a second state.db connection", async () => {
    const stash = storage.stashDir;
    writeMemory(stash, "alpha");
    await indexStash(stash);

    // A dedicated state.db, distinct from the sandbox default path: if the
    // purge (incorrectly) opened its own connection via the default path, it
    // would purge a DIFFERENT database and this handle would keep the old row.
    const stateDbPath = makeStateDbPath();
    const eventsDb = openStateDatabase(stateDbPath);
    try {
      const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
      insertEvent(eventsDb, { eventType: "feedback", ts: oldTs, ref: "memories/alpha", metadata: {} });

      const allWarnings: string[] = [];
      await runImproveMaintenancePasses({
        options: {
          stashDir: stash,
          config: { ...loadConfig(), improve: { eventRetentionDays: 1 } },
          memoryInferenceFn: async () => stubMemoryInferenceResult(),
        },
        primaryStashDir: stash,
        actionableRefs: [],
        memoryRefsForInference: new Set<string>(),
        allWarnings,
        reindexFn: async () => undefined,
        eventsCtx: { db: eventsDb },
      });

      expect(allWarnings).toEqual([]);
      // The stale event was purged through THE SAME handle...
      const countRow = eventsDb.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'feedback'").get() as {
        n: number;
      };
      expect(countRow.n).toBe(0);
      // ...and the purge audit events landed in it too.
      const eventTypes = (eventsDb.prepare("SELECT event_type FROM events").all() as Array<{ event_type: string }>).map(
        (r) => r.event_type,
      );
      expect(eventTypes).toContain("events_purged");
      expect(eventTypes).toContain("improve_runs_purged");
      // The connection is still open afterwards — the purge must not close a
      // handle it does not own (akmImprove closes it in its own finally).
      expect(isHandleOpen(eventsDb)).toBe(true);
      // Nothing leaked into the sandbox-default state.db.
      expect(readEvents({ type: "events_purged" }).events).toHaveLength(0);
    } finally {
      try {
        eventsDb.close();
      } catch {
        // already closed
      }
    }
  });

  test("dbPath fallback (no live eventsCtx.db) opens and closes its own connection", async () => {
    const stash = storage.stashDir;
    writeMemory(stash, "alpha");
    await indexStash(stash);

    const stateDbPath = makeStateDbPath();
    const seedDb = openStateDatabase(stateDbPath);
    const oldTs = new Date(Date.now() - 10 * 86_400_000).toISOString();
    insertEvent(seedDb, { eventType: "feedback", ts: oldTs, ref: "memories/alpha", metadata: {} });
    seedDb.close();

    const allWarnings: string[] = [];
    await runImproveMaintenancePasses({
      options: {
        stashDir: stash,
        config: { ...loadConfig(), improve: { eventRetentionDays: 1 } },
        memoryInferenceFn: async () => stubMemoryInferenceResult(),
      },
      primaryStashDir: stash,
      actionableRefs: [],
      memoryRefsForInference: new Set<string>(),
      allWarnings,
      reindexFn: async () => undefined,
      eventsCtx: { dbPath: stateDbPath },
    });

    expect(allWarnings).toEqual([]);
    const checkDb = openStateDatabase(stateDbPath);
    try {
      const countRow = checkDb.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'feedback'").get() as {
        n: number;
      };
      expect(countRow.n).toBe(0);
      const eventTypes = (checkDb.prepare("SELECT event_type FROM events").all() as Array<{ event_type: string }>).map(
        (r) => r.event_type,
      );
      expect(eventTypes).toContain("events_purged");
    } finally {
      checkDb.close();
    }
  });
});

/** Config with consolidate enabled (default-off gates: minPoolSize 0 set explicitly, no cooldown on a fresh stash). */
function consolidateEnabledConfig(): AkmConfig {
  return withImproveAutonomy(
    withTestImproveLlm({
      semanticSearchMode: "off",
      improve: {
        strategies: { default: { processes: { consolidate: { enabled: true, minPoolSize: 0 } } } },
      },
    } as unknown as AkmConfig),
  );
}

describe("r2-1 (tier1-0917-r4): consolidationRan gates R5's collapse detector on processed > 0", () => {
  test("consolidation judges a memory but writes nothing — cycle metrics are still recorded", async () => {
    const stash = storage.stashDir;
    writeMemory(stash, "alpha");
    saveConfig(consolidateEnabledConfig());
    await akmIndex({ stashDir: stash, full: true });

    overrideSeam(_setChatCompletionForTests, async () => JSON.stringify({ operations: [] }));

    const result = await akmImprove({
      stashDir: stash,
      scope: "memory",
      ensureIndexFn: async () => undefined,
      memoryInferenceFn: async () => stubMemoryInferenceResult(),
      graphExtractionFn: async () => stubGraphExtractionResult,
      reindexFn: async () => undefined,
    });

    // Fixture shape: `processed > 0`, `merged === 0`, `deleted === 0`,
    // `promoted.length === 0`, `contradicted === 0` — the LLM judged the pool
    // and proposed nothing.
    expect(result.consolidation?.processed).toBeGreaterThan(0);
    expect(result.consolidation?.merged).toBe(0);
    expect(result.consolidation?.deleted).toBe(0);
    expect(result.consolidation?.promoted).toEqual([]);
    expect(result.consolidation?.contradicted).toBe(0);
    // R5's collapse detector is the only production consumer of
    // consolidationRan (loop-stages.ts:859) — a qualifying cycle (consolidate
    // did work) must produce a snapshot even though nothing was written.
    expect(result.cycleMetrics).toBeDefined();
  });

  test("consolidation is skipped (pool below minPoolSize) — no cycle metrics are recorded", async () => {
    const stash = storage.stashDir;
    writeMemory(stash, "alpha");
    saveConfig(
      withImproveAutonomy(
        withTestImproveLlm({
          semanticSearchMode: "off",
          improve: {
            strategies: { default: { processes: { consolidate: { enabled: true, minPoolSize: 5 } } } },
          },
        } as unknown as AkmConfig),
      ),
    );
    await akmIndex({ stashDir: stash, full: true });

    const result = await akmImprove({
      stashDir: stash,
      scope: "memory",
      ensureIndexFn: async () => undefined,
      memoryInferenceFn: async () => stubMemoryInferenceResult(),
      graphExtractionFn: async () => stubGraphExtractionResult,
      reindexFn: async () => undefined,
    });

    // The single-memory pool is below minPoolSize 5, so consolidation never
    // judges anything — the negative case: without it, a do-nothing gate
    // (e.g. one that fires unconditionally) would still pass the test above.
    expect(result.consolidation?.processed ?? 0).toBe(0);
    expect(result.cycleMetrics).toBeUndefined();
  });
});
