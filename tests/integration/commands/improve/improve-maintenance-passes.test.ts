// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.7 — focused unit coverage for the maintenance passes extracted from
 * `runImproveMaintenancePasses` / its `withIndexWriterLease` callback (R31
 * decomposition, testability requirement).
 *
 * Each pass is driven directly with an injected `memoryInferenceFn` seam —
 * no LLM, no real index.db — and its returned result object is asserted
 * instead of the old shared closure state. The #584/#585 db-handle and
 * borrowed-connection contracts keep their own integration suite
 * (`improve-db-locking.test.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type MaintenanceCtx,
  runMemoryInferenceMaintenancePass,
  runRetentionPurgePass,
} from "../../../../src/commands/improve/loop-stages";
import type { AkmConfig } from "../../../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../../../src/core/state-db";
import { collectPendingMemories, type MemoryInferenceResult } from "../../../../src/indexer/passes/memory-inference";
import type { Database } from "../../../../src/storage/database";
import { insertEventStrict } from "../../../../src/storage/repositories/events-repository";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { computeBodyHash, upsertLlmCacheEntry } from "../../../../src/storage/repositories/index-llm-cache-repository";
import { STATE_DB_VACUUMED_EVENT } from "../../../../src/storage/state-db-integrity";
import { makeStashDir, type SandboxedDir, sandboxXdgCacheHome, sandboxXdgDataHome } from "../../../_helpers/sandbox";

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

function makeCtx(stashDir: string, overrides: Partial<MaintenanceCtx> = {}): MaintenanceCtx {
  return {
    config: {} as AkmConfig,
    sources: [{ name: "primary", path: stashDir } as MaintenanceCtx["sources"][number]],
    primaryStashDir: stashDir,
    memoryInferenceFn: () => {
      throw new Error("memoryInferenceFn not expected in this scenario");
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

  test("minPendingCount gate does not count a parent with a cached no-change decision (#1219)", async () => {
    const stash = freshStash();
    const file = path.join(stash, "memories", "note.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\ndescription: note\n---\n\nTool calls this session: Read 12.\n", "utf8");
    const db = openIndexDatabase(path.join(stash, "index.db"));
    try {
      upsertLlmCacheEntry(
        db,
        file,
        computeBodyHash(collectPendingMemories(stash)[0]!.effectiveInput),
        JSON.stringify({ noChange: true }),
        "memory-inference-v5",
      );
      const ctx = makeCtx(stash, {
        improveProfile: { processes: { memoryInference: { minPendingCount: 1 } } } as MaintenanceCtx["improveProfile"],
      });

      // Only a cached decision is pending: below the gate, so the seam is not reached.
      const out = await runMemoryInferenceMaintenancePass(ctx, { current: db }, new Set());
      expect(out.memoryInference).toBeUndefined();
      expect(out.warnings).toEqual([]);

      // Editing the body makes the parent count again, so the gate admits the pass.
      fs.writeFileSync(file, "---\ndescription: note\n---\n\nThe retry cap is 30s via http.retryCap.\n", "utf8");
      const admitted = await runMemoryInferenceMaintenancePass(ctx, { current: db }, new Set());
      expect(admitted.warnings).toEqual(["memory inference failed: memoryInferenceFn not expected in this scenario"]);
    } finally {
      closeDatabase(db);
    }
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

  // #951: per-run flat log files under getTaskLogDir() are a separate purge
  // target from task_logs (logs.db rows) — same retention window, own
  // try/catch, own event type (task_log_files_purged).
  test("purges per-run log files under getTaskLogDir() past the retention window", async () => {
    const stash = freshStash();
    const cacheSb = sandboxXdgCacheHome();
    disposers.push(cacheSb);
    const { getTaskLogDir } = await import("../../../../src/core/paths");

    const logDir = getTaskLogDir();
    const taskDir = path.join(logDir, "daily-improve");
    fs.mkdirSync(taskDir, { recursive: true });
    const oldFile = path.join(taskDir, "old.log");
    fs.writeFileSync(oldFile, "stale run");
    const oldMtime = new Date(Date.now() - 200 * 86_400_000);
    fs.utimesSync(oldFile, oldMtime, oldMtime);
    const newFile = path.join(taskDir, "new.log");
    fs.writeFileSync(newFile, "recent run");

    const ctx = makeCtx(stash); // default config → 90d window
    const out = runRetentionPurgePass(ctx);

    expect(out.warnings).toEqual([]);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  // #1168 §3.8: `$CACHE/logs/improve/<ISO>.log` and `$CACHE/logs/index/<ISO>.log`
  // are flat files outside the task log dir and were never purged.
  test("purges per-run improve and index log files past the retention window", async () => {
    const stash = freshStash();
    const cacheSb = sandboxXdgCacheHome();
    disposers.push(cacheSb);
    const { getRunLogDir } = await import("../../../../src/core/paths");

    const kept: string[] = [];
    const stale: string[] = [];
    for (const kind of ["improve", "index"] as const) {
      const dir = getRunLogDir(kind);
      fs.mkdirSync(dir, { recursive: true });
      const oldFile = path.join(dir, "2026-01-01T00-00-00-000Z.log");
      fs.writeFileSync(oldFile, "stale run");
      const oldMtime = new Date(Date.now() - 200 * 86_400_000);
      fs.utimesSync(oldFile, oldMtime, oldMtime);
      stale.push(oldFile);
      const newFile = path.join(dir, "2026-10-10T00-00-00-000Z.log");
      fs.writeFileSync(newFile, "recent run");
      kept.push(newFile);
    }

    const out = runRetentionPurgePass(makeCtx(stash)); // default config → 90d window

    expect(out.warnings).toEqual([]);
    for (const f of stale) expect(fs.existsSync(f)).toBe(false);
    for (const f of kept) expect(fs.existsSync(f)).toBe(true);
  });

  // R0 step 3 wires vacuumIfReclaimable into the
  // purge callback, reading the freelist off the same connection the purge
  // just used. Recipe (bulk-insert-then-delete) reused from
  // tests/integration/storage/state-db-integrity.test.ts:140-160, except the
  // "delete" here is the retention purge itself.
  test("VACUUMs state.db and appends state_db_vacuumed when the purge frees enough pages", () => {
    const stash = freshStash();
    const dbPath = getStateDbPath();
    const seedDb = openStateDatabase(dbPath);
    try {
      const oldTs = new Date(Date.now() - 200 * 86_400_000).toISOString();
      const bigMetadata = { blob: "x".repeat(2000) };
      for (let i = 0; i < 3000; i++) {
        insertEventStrict(seedDb, {
          eventType: "reflect_invoked",
          ts: oldTs,
          ref: `lessons/note-${i}`,
          metadata: bigMetadata,
        });
      }
    } finally {
      seedDb.close();
    }

    const ctx = makeCtx(stash, {
      config: { improve: { eventRetentionDays: 1 } } as AkmConfig,
    });
    const out = runRetentionPurgePass(ctx);

    expect(out.warnings).toEqual([]);
    const checkDb = openStateDatabase(dbPath);
    try {
      const event = checkDb
        .prepare("SELECT metadata_json FROM events WHERE event_type = ? ORDER BY id DESC LIMIT 1")
        .get(STATE_DB_VACUUMED_EVENT) as { metadata_json: string } | undefined;
      expect(event).toBeDefined();
      const metadata = JSON.parse(event?.metadata_json ?? "{}") as { pagesBefore: number; pagesAfter: number };
      expect(metadata.pagesAfter).toBeLessThan(metadata.pagesBefore);
    } finally {
      checkDb.close();
    }
  });

  test("does not VACUUM or append state_db_vacuumed when reclaimable space stays below threshold", () => {
    const stash = freshStash();
    const dbPath = getStateDbPath();
    // A fresh sandboxed state.db has nothing to purge, so its freelist ratio
    // never crosses STATE_DB_FREELIST_WARN_RATIO.
    const ctx = makeCtx(stash); // default config → 90d window

    const out = runRetentionPurgePass(ctx);

    expect(out.warnings).toEqual([]);
    const checkDb = openStateDatabase(dbPath);
    try {
      const event = checkDb.prepare("SELECT 1 FROM events WHERE event_type = ?").get(STATE_DB_VACUUMED_EVENT);
      expect(event).toBeNull();
    } finally {
      checkDb.close();
    }
  });
});
