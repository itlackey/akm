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
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmImprove, runImproveMaintenancePasses } from "../../../../src/commands/improve/improve";
import { loadConfig, saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { GraphExtractionResult } from "../../../../src/indexer/graph/graph-extraction";
import { probeIndexWriterLease } from "../../../../src/indexer/index-writer-lock";
import { akmIndex } from "../../../../src/indexer/indexer";
import type { MemoryInferenceResult } from "../../../../src/indexer/passes/memory-inference";
import type { Database } from "../../../../src/storage/database";
import { insertEvent } from "../../../../src/storage/repositories/events-repository";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

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
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
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
  test("maintenance handle is closed during reindex and a fresh handle is used afterwards", async () => {
    const stash = storage.stashDir;
    writeMemory(stash, "alpha");
    await indexStash(stash);

    let capturedInferenceDb: Database | undefined;
    let reindexCalls = 0;
    let handleOpenDuringReindex: boolean | undefined;
    let handleOpenDuringGraphExtraction: boolean | undefined;
    let leaseHeldDuringInference: boolean | undefined;
    let leaseHeldDuringGraphExtraction: boolean | undefined;
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
          changes: [{ path: "", after: "# stub reflect", op: "update" }],
        },
      }),
      distillFn: async (o) => ({
        schemaVersion: 1,
        ok: true,
        outcome: "queued",
        inputRef: o.ref,
        lessonRef: "lesson:stub",
      }),
      // Report written facts so the maintenance pass triggers the
      // post-inference reindex (#584 call site 1).
      memoryInferenceFn: async (ctx) => {
        capturedInferenceDb = ctx.db;
        const probe = probeIndexWriterLease();
        leaseHeldDuringInference = probe.state === "held" && probe.holderPid === process.pid;
        return stubMemoryInferenceResult({ considered: 1, splitParents: 1, writtenFacts: 1 });
      },
      reindexFn: async () => {
        reindexCalls += 1;
        // The maintenance pass's index.db handle (captured above) must be
        // CLOSED while reindex runs — reindex opens its own write handle on
        // the same WAL file and a still-open sibling caused SQLITE_BUSY.
        handleOpenDuringReindex = isHandleOpen(capturedInferenceDb);
      },
      // Graph extraction runs after the reindex sites and receives the
      // maintenance handle — it must be a fresh, usable post-reindex handle.
      graphExtractionFn: async (ctx) => {
        graphDb = ctx.db;
        handleOpenDuringGraphExtraction = isHandleOpen(ctx.db);
        const probe = probeIndexWriterLease();
        leaseHeldDuringGraphExtraction = probe.state === "held" && probe.holderPid === process.pid;
        return stubGraphExtractionResult;
      },
    });

    expect(result.ok).toBe(true);
    expect(reindexCalls).toBeGreaterThanOrEqual(1);
    expect(handleOpenDuringReindex).toBe(false);
    expect(handleOpenDuringGraphExtraction).toBe(true);
    expect(leaseHeldDuringInference).toBe(true);
    expect(leaseHeldDuringGraphExtraction).toBe(true);
    // The post-reindex handle is a NEW connection, not the closed original.
    expect(graphDb).toBeDefined();
    expect(graphDb).not.toBe(capturedInferenceDb);
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
      insertEvent(eventsDb, { eventType: "feedback", ts: oldTs, ref: "memory:alpha", metadata: {} });

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
    insertEvent(seedDb, { eventType: "feedback", ts: oldTs, ref: "memory:alpha", metadata: {} });
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
