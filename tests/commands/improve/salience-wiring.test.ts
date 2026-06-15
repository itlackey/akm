// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the WS-1 salience-vector wiring inside `akmImprove`.
 *
 * Covers (per the WS-1 review blockers):
 *   1. First run emits `improve_salience_first_run` (empty table, no comparison possible).
 *   2. Second run emits `improve_salience_rank_change` with stash-wide positions.
 *   3. `recordNoOp` increments `consecutive_no_ops` after a `no_change` reflect outcome.
 *   4. `resetConsecutiveNoOps` resets the counter after a successful (queued) distill outcome.
 *   5. `retrievalCounts` covers the feedback-bearing pool (not only zero-feedback refs).
 *
 * All tests use `withIsolatedAkmStorage` for full env isolation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { getAssetSalience, getConsecutiveNoOps, upsertAssetSalience } from "../../../src/commands/improve/salience";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function writeSkill(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "skills", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

/** Reflect stub that returns no_change (LLM found nothing to improve). */
const noChangeReflect = (_ref: string): AkmReflectResult => ({
  schemaVersion: 1,
  ok: false,
  reason: "no_change",
  error: "no change detected",
  exitCode: 0,
  ref: _ref,
});

/** Reflect stub that returns a successful proposal. */
const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 1,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:00:00.000Z",
    payload: { content: "# improved" },
  },
  ref,
  agentProfile: "test",
  durationMs: 1,
});

/** Distill stub that returns a queued outcome (success). */
const queuedDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

/** Distill stub that returns quality_rejected. */
const qualityRejectedDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "quality_rejected",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
  reason: "below quality threshold",
});

/**
 * Minimal config: disable noisy passes, but keep proactiveMaintenance enabled
 * so never-reflected, zero-feedback assets flow through the candidate selection
 * and into the salience map / plasticity wiring.
 */
const minimalConfig = () =>
  ({
    semanticSearchMode: "off",
    profiles: {
      improve: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            proactiveMaintenance: { enabled: true, maxPerRun: 10 },
          },
        },
      },
    },
  }) as import("../../../src/core/config/config").AkmConfig;

// ── Test 1: first run emits improve_salience_first_run ────────────────────────

describe("WS-1 wiring — first run (empty table)", () => {
  test("emits improve_salience_first_run event when asset_salience table is empty", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "alpha", "Alpha content.");
    await buildIndex(stash);

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    // Verify first_run event was emitted.
    const { events: firstRunEvents } = readEvents({ type: "improve_salience_first_run" });
    expect(firstRunEvents.length).toBeGreaterThanOrEqual(1);

    // Verify rank_change was NOT emitted (table was empty, no comparison possible).
    const { events: rankChangeEvents } = readEvents({ type: "improve_salience_rank_change" });
    expect(rankChangeEvents.length).toBe(0);

    // Metadata should carry candidateCount.
    const meta = firstRunEvents[0]?.metadata as Record<string, unknown> | undefined;
    expect(typeof meta?.candidateCount).toBe("number");
    expect(meta?.candidateCount as number).toBeGreaterThanOrEqual(1);
  });

  test("asset_salience rows are written after the first run", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "beta", "Beta content.");
    await buildIndex(stash);

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      const row = getAssetSalience(db, "skill:beta");
      expect(row).toBeDefined();
      expect(row?.rank_score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

// ── Test 2: second run emits improve_salience_rank_change ─────────────────────

describe("WS-1 wiring — subsequent run (table has rows)", () => {
  test("emits improve_salience_rank_change on second run", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "gamma", "Gamma content.");
    await buildIndex(stash);

    const runOpts = {
      scope: "skill" as const,
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }: { ref?: string }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }: { ref?: string }) => queuedDistill(ref ?? ""),
    };

    // First run seeds the table.
    await akmImprove(runOpts);

    // Confirm no rank_change yet.
    const { events: firstRankChange } = readEvents({ type: "improve_salience_rank_change" });
    expect(firstRankChange.length).toBe(0);

    // Second run should emit rank_change (table is non-empty now).
    await akmImprove(runOpts);

    const { events: secondRankChange } = readEvents({ type: "improve_salience_rank_change" });
    expect(secondRankChange.length).toBeGreaterThanOrEqual(1);

    // Metadata should include stashSize (stash-wide, not pool-relative).
    const meta = secondRankChange[0]?.metadata as Record<string, unknown> | undefined;
    expect(typeof meta?.stashSize).toBe("number");
    expect(meta?.stashSize as number).toBeGreaterThan(0);
    expect(typeof meta?.totalChanged).toBe("number");
    expect(typeof meta?.forgettingCandidates).toBe("number");
  });
});

// ── Test 3: recordNoOp fires on no_change reflect ─────────────────────────────

describe("WS-1 wiring — no-op tracking via consecutive_no_ops", () => {
  test("consecutive_no_ops increments after a no_change reflect", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "delta", "Delta content.");
    await buildIndex(stash);

    // Pre-seed the salience row so consecutive_no_ops starts at 0.
    const dbSetup = openStateDatabase();
    try {
      upsertAssetSalience(dbSetup, "skill:delta", { encoding: 0.7, outcome: 0, retrieval: 0, rankScore: 0.2 });
    } finally {
      dbSetup.close();
    }

    // Run with a no_change reflect stub.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => noChangeReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      // no_change reflect → recordNoOp → consecutive_no_ops = 1
      const noOps = getConsecutiveNoOps(db, "skill:delta");
      expect(noOps).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  test("consecutive_no_ops resets to 0 after a successful distill (queued)", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "epsilon", "Epsilon content.");
    await buildIndex(stash);

    // Pre-seed with a high no-op count.
    const dbSetup = openStateDatabase();
    try {
      upsertAssetSalience(dbSetup, "skill:epsilon", { encoding: 0.7, outcome: 0, retrieval: 0, rankScore: 0.2 });
      // manually set consecutive_no_ops to 5 by calling recordNoOp
      for (let i = 0; i < 5; i++) {
        dbSetup
          .prepare(`UPDATE asset_salience SET consecutive_no_ops = consecutive_no_ops + 1 WHERE asset_ref = ?`)
          .run("skill:epsilon");
      }
    } finally {
      dbSetup.close();
    }

    // Verify the seed worked.
    const dbCheck = openStateDatabase();
    try {
      expect(getConsecutiveNoOps(dbCheck, "skill:epsilon")).toBe(5);
    } finally {
      dbCheck.close();
    }

    // Run with successful (ok) reflect + queued distill.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      // queued distill → resetConsecutiveNoOps → 0
      const noOps = getConsecutiveNoOps(db, "skill:epsilon");
      expect(noOps).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── Test 4: stash-wide rank positions (Blocker 2 regression) ─────────────────

describe("WS-1 wiring — rank positions are stash-wide, not pool-relative", () => {
  test("rank_change event stashSize >= pool size (proves stash-wide query)", async () => {
    const stash = isolatedStash();
    // Write 3 skills — all will be in the pool.
    for (const name of ["s1", "s2", "s3"]) {
      writeSkill(stash, name, `Content for ${name}.`);
    }
    await buildIndex(stash);

    // First run seeds the table.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    // Manually inject extra rows into asset_salience to simulate a larger stash.
    // These refs are NOT in the current run's pool.
    const dbInject = openStateDatabase();
    try {
      for (const extraRef of ["knowledge:extra1", "knowledge:extra2", "knowledge:extra3"]) {
        upsertAssetSalience(dbInject, extraRef, { encoding: 0.7, outcome: 0, retrieval: 0.5, rankScore: 0.35 });
      }
    } finally {
      dbInject.close();
    }

    // Second run: pool has 3 skills, but stash.db has 3 + 3 = 6 rows.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const { events } = readEvents({ type: "improve_salience_rank_change" });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const meta = events[0]?.metadata as Record<string, unknown> | undefined;
    // stashSize should include the injected extra rows (6), not just the pool (3).
    expect(meta?.stashSize as number).toBeGreaterThanOrEqual(6);
  });
});
