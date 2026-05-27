/**
 * Health aggregator contract: `distill.skipped` is sub-bucketed by reason.
 *
 * Mirrors the existing `reflect.skippedByReason` histogram (commit `b3c2328`).
 * Pre-2026-05-27, `mode === "distill-skipped"` actions were collapsed into a
 * single counter even though improve.ts emits 7+ distinct reasons. On
 * release/0.8.0 that meant 62 539 events over 7d had no sub-reason visibility
 * — see `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md` §3.
 *
 * Backwards-compat: the scalar `distill.skipped` remains. The new
 * `distill.skippedByReason` is additive; sum of its values MUST equal
 * `distill.skipped`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth } from "../../src/commands/health";
import type { AkmImproveResult } from "../../src/commands/improve";
import { appendEvent } from "../../src/core/events";
import { openStateDatabase, recordImproveRun } from "../../src/core/state-db";

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

function insertImproveRun(result: Record<string, unknown>, tsIso: string): void {
  const db = openStateDatabase();
  try {
    recordImproveRun(db, {
      id: `run-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: tsIso,
      completedAt: tsIso,
      stashDir: "/tmp/distill-skipreason-stash",
      dryRun: false,
      profile: null,
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: true,
      result: result as unknown as AkmImproveResult,
    });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  process.env.AKM_DATA_DIR = makeTempDir("akm-distill-skipreason-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-distill-skipreason-state-");
  process.env.XDG_CACHE_HOME = makeTempDir("akm-distill-skipreason-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-distill-skipreason-config-");
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

describe("akmHealth: distill.skippedByReason histogram", () => {
  test("collects sub-reasons from distill-skipped actions and totals match the scalar", () => {
    // Seed an improve_completed event so the run window is non-empty.
    const tsIso = new Date(Date.now() - 60_000).toISOString();
    appendEvent({ eventType: "improve_completed", metadata: {} });

    insertImproveRun(
      {
        schemaVersion: 1,
        ok: true,
        plannedRefs: [],
        actions: [
          {
            ref: "memory:a",
            mode: "distill-skipped",
            result: { ok: true, reason: "no new signal since last proposal" },
          },
          {
            ref: "memory:b",
            mode: "distill-skipped",
            result: { ok: true, reason: "no new signal since last proposal" },
          },
          { ref: "memory:c", mode: "distill-skipped", result: { ok: true, reason: "pending proposal exists" } },
          { ref: "memory:d", mode: "distill-skipped", result: { ok: true, reason: "type-filter" } },
          { ref: "memory:e", mode: "distill-skipped", result: { ok: true, reason: "derived-memory-reflect-skipped" } },
          { ref: "memory:f", mode: "distill-skipped", result: { ok: true } }, // missing reason
        ],
      },
      tsIso,
    );

    const result = akmHealth({ since: "7d" });
    expect(result.improve.actions.distill.skipped).toBe(6);
    expect(result.improve.actions.distill.skippedByReason).toEqual({
      "no new signal since last proposal": 2,
      "pending proposal exists": 1,
      "type-filter": 1,
      "derived-memory-reflect-skipped": 1,
      unknown: 1,
    });
    // Invariant: sum of histogram == scalar.
    const sum = Object.values(result.improve.actions.distill.skippedByReason).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.improve.actions.distill.skipped);
  });

  test("scalar `distill.skipped` is preserved (backwards-compat)", () => {
    const tsIso = new Date(Date.now() - 60_000).toISOString();
    appendEvent({ eventType: "improve_completed", metadata: {} });
    insertImproveRun(
      {
        schemaVersion: 1,
        ok: true,
        plannedRefs: [],
        actions: [{ ref: "memory:x", mode: "distill-skipped", result: { ok: true, reason: "distill signal-delta" } }],
      },
      tsIso,
    );

    const result = akmHealth({ since: "7d" });
    expect(result.improve.actions.distill.skipped).toBe(1);
  });
});
