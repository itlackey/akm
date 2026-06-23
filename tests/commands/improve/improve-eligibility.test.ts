// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Signal-delta + pool-delta eligibility tests (0.8.0).
 *
 * The 0.8.0 redesign replaced the per-ref time-based reflect/distill cooldowns
 * with a *signal-delta* gate (re-eligible iff new feedback landed since the
 * last proposal for that ref+source) and the consolidate time cooldown with a
 * *pool-delta* gate (re-eligible iff any memory file mtime is newer than the
 * last consolidate_completed event). These tests pin the new gates.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { upsertAssetSalience } from "../../../src/commands/improve/salience";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent, readEvents } from "../../../src/core/events";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { closeDatabase, openExistingDatabase } from "../../../src/indexer/db/db";
import { akmIndex } from "../../../src/indexer/indexer";
import { insertUsageEvent } from "../../../src/indexer/usage/usage-events";

// Deterministic, strictly-ordered timestamps for signal-delta ordering.
// These replace `await sleep(10)` between two appendEvent() calls: instead of
// relying on the wall clock to advance between writes (flaky on a coarse
// clock), we inject explicit ts values via `appendEvent(input, { now })`.
// They must stay within the 30-day FEEDBACK_SIGNAL_WINDOW_DAYS so feedback
// events still count as "current signal", so they are anchored near now().
// NEWER_MS > OLDER_MS guarantees the lexicographic ISO comparison in
// improve.ts (`fb > lp`) resolves the intended ordering deterministically.
const OLDER_MS = Date.now() - 60_000;
const NEWER_MS = Date.now() - 30_000;

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

function writeMemory(stashDir: string, name: string, body: string, mtime?: Date): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
  if (mtime) fs.utimesSync(filePath, mtime, mtime);
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

// #553: these pool-delta / #551-gate tests use single-memory sandboxed pools.
// The default consolidate minPoolSize guard (500) would otherwise short-circuit
// the consolidation pass before the mtime-delta gate runs. Disable the pool-size
// guard (minPoolSize: 0) so these tests exercise the gate they pin, not the new
// guard. (A dedicated suite covers the minPoolSize guard itself.)
function configWithoutPoolGuard(): import("../../../src/core/config/config").AkmConfig {
  return {
    semanticSearchMode: "off",
    profiles: { improve: { default: { processes: { consolidate: { minPoolSize: 0 } } } } },
  } as import("../../../src/core/config/config").AkmConfig;
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 1,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    payload: { content: "# proposal" },
  },
  ref,
  agentProfile: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-elig-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-elig-config-");
  process.env.AKM_DATA_DIR = makeTempDir("akm-elig-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-elig-state-");
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string>)[k] = v;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Reflect signal-delta ────────────────────────────────────────────────────

describe("reflect signal-delta eligibility", () => {
  test("new feedback after last reflect proposal → eligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-eligible-");
    writeMemory(stash, "auth-tips", "Use VPN.");
    await buildIndex(stash);

    // Older reflect proposal recorded as reflect_invoked event.
    appendEvent({ eventType: "reflect_invoked", ref: "memory:auth-tips" }, { now: () => OLDER_MS });
    // Newer feedback event arrived after the reflect (injected ts strictly > reflect).
    appendEvent(
      {
        eventType: "feedback",
        ref: "memory:auth-tips",
        metadata: { signal: "negative" },
      },
      { now: () => NEWER_MS },
    );

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memory:auth-tips");
  });

  test("no new feedback since last reflect proposal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-no-signal-");
    writeMemory(stash, "stale", "Old content.");
    await buildIndex(stash);

    // Old feedback event THEN a reflect_invoked event (reflect is newer).
    appendEvent(
      {
        eventType: "feedback",
        ref: "memory:stale",
        metadata: { signal: "negative" },
      },
      { now: () => OLDER_MS },
    );
    appendEvent({ eventType: "reflect_invoked", ref: "memory:stale" }, { now: () => NEWER_MS });

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memory:stale");
  });

  test("never-reflected ref with feedback signal → eligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-first-time-");
    writeMemory(stash, "fresh", "Fresh content.");
    await buildIndex(stash);
    appendEvent({
      eventType: "feedback",
      ref: "memory:fresh",
      metadata: { signal: "positive" },
    });

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memory:fresh");
  });

  test("never-reflected ref without any signal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-silent-");
    writeMemory(stash, "silent", "Silent content.");
    await buildIndex(stash);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memory:silent");
  });
});

// ── Distill signal-delta ────────────────────────────────────────────────────

describe("distill signal-delta eligibility", () => {
  test("new feedback after last distill proposal → eligible", async () => {
    const stash = makeTempDir("akm-elig-distill-eligible-");
    writeMemory(stash, "auth-tips", "VPN required.");
    await buildIndex(stash);

    appendEvent(
      {
        eventType: "distill_invoked",
        ref: "memory:auth-tips",
        metadata: { outcome: "queued" },
      },
      { now: () => OLDER_MS },
    );
    appendEvent(
      {
        eventType: "feedback",
        ref: "memory:auth-tips",
        metadata: { signal: "negative" },
      },
      { now: () => NEWER_MS },
    );

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).toContain("memory:auth-tips");
  });

  test("no new feedback since last distill proposal → ineligible (for distill)", async () => {
    const stash = makeTempDir("akm-elig-distill-stale-");
    writeMemory(stash, "old-memory", "Stable content.");
    await buildIndex(stash);

    appendEvent(
      {
        eventType: "feedback",
        ref: "memory:old-memory",
        metadata: { signal: "negative" },
      },
      { now: () => OLDER_MS },
    );
    appendEvent(
      {
        eventType: "distill_invoked",
        ref: "memory:old-memory",
        metadata: { outcome: "queued" },
      },
      { now: () => NEWER_MS },
    );

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).not.toContain("memory:old-memory");
  });

  test("never-distilled memory with feedback signal → distill-eligible", async () => {
    const stash = makeTempDir("akm-elig-distill-first-");
    writeMemory(stash, "new-tip", "A new tip.");
    await buildIndex(stash);
    appendEvent({
      eventType: "feedback",
      ref: "memory:new-tip",
      metadata: { signal: "positive" },
    });

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).toContain("memory:new-tip");
  });

  test("never-distilled memory without signal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-distill-no-signal-");
    writeMemory(stash, "untouched", "Untouched memory.");
    await buildIndex(stash);

    const distilled: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return okDistill(ref ?? "");
      },
    });

    expect(distilled).not.toContain("memory:untouched");
  });
});

// ── Consolidate pool-delta ──────────────────────────────────────────────────

describe("consolidate pool-delta eligibility", () => {
  test("no memory updates since last consolidate_completed → ineligible (improve_skipped emitted)", async () => {
    const stash = makeTempDir("akm-elig-consolidate-skip-");
    writeMemory(stash, "old-mem", "Stable content.");
    await buildIndex(stash);
    // Emit a consolidate_completed event with ts well in the future so the
    // memory file's natural mtime (including any in-pipeline lint touches)
    // stays strictly less than the event ts. This is the canonical "nothing
    // new since the last successful consolidate" state.
    const farFutureMs = new Date("2099-01-01T00:00:00.000Z").getTime();
    appendEvent(
      {
        eventType: "consolidate_completed",
        ref: "memory:_consolidation",
        metadata: { processed: 1 },
      },
      { now: () => farFutureMs },
    );

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(),
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const skipped = readEvents({ type: "improve_skipped", ref: "memory:_consolidation" }).events;
    expect(skipped.some((e) => e.metadata?.reason === "consolidation_no_memory_updates")).toBe(true);
  });

  test("memory mtime > last consolidate_completed → consolidation skip event NOT emitted", async () => {
    const stash = makeTempDir("akm-elig-consolidate-runs-");
    // Old completion event (injected ts in the past), then a freshly-written
    // memory whose natural mtime is strictly newer than the completion event.
    appendEvent(
      {
        eventType: "consolidate_completed",
        ref: "memory:_consolidation",
        metadata: { processed: 1 },
      },
      { now: () => new Date("2020-01-01T00:00:00.000Z").getTime() },
    );
    writeMemory(stash, "fresh-mem", "Recent edit.");
    await buildIndex(stash);

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(),
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const skipped = readEvents({ type: "improve_skipped", ref: "memory:_consolidation" }).events;
    expect(skipped.some((e) => e.metadata?.reason === "consolidation_no_memory_updates")).toBe(false);
  });
});

// ── #551: consolidation runs before extract + smarter pool-delta gate ────────

describe("#551 consolidation reorder + adjacent-run promotion gate", () => {
  // (a) Consolidation now runs BEFORE the session-extract phase. We prove this
  // structurally: the consolidation decision event (here, the pool-delta skip)
  // is emitted strictly BEFORE `improve_invoked`, which is emitted AFTER the
  // extract phase inside the preparation stage. Events are returned in
  // monotonic insertion order (`ORDER BY id ASC`), so index comparison is
  // deterministic — no wall-clock dependency.
  test("consolidation phase is emitted before the extract phase (event order)", async () => {
    const stash = makeTempDir("akm-551-order-");
    writeMemory(stash, "settled-mem", "Stable content.");
    await buildIndex(stash);
    // Force the pool-delta SKIP path so a consolidation decision event fires
    // deterministically without an LLM: a far-future last-consolidate ts means
    // nothing on disk is newer.
    const farFutureMs = new Date("2099-01-01T00:00:00.000Z").getTime();
    appendEvent(
      { eventType: "consolidate_completed", ref: "memory:_consolidation", metadata: { processed: 1 } },
      { now: () => farFutureMs },
    );

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(),
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const all = readEvents({}).events;
    // THIS run's consolidation decision = the pool-delta skip event (carries the
    // reason). The seeded `consolidate_completed` is ignored deliberately.
    const consolidationIdx = all.findIndex(
      (e) =>
        e.eventType === "improve_skipped" &&
        e.ref === "memory:_consolidation" &&
        e.metadata?.reason === "consolidation_no_memory_updates",
    );
    const improveInvokedIdx = all.findIndex((e) => e.eventType === "improve_invoked");
    expect(consolidationIdx).toBeGreaterThanOrEqual(0);
    expect(improveInvokedIdx).toBeGreaterThanOrEqual(0);
    // Consolidation decision precedes the post-extract `improve_invoked` marker.
    expect(consolidationIdx).toBeLessThan(improveInvokedIdx);
  });

  // (b) REGRESSION the issue describes. A memory whose only post-consolidate
  // mtime bump came from its OWN auto-accept promotion (i.e. promoted by the
  // immediately-preceding run) must NOT trigger consolidation — it has no
  // settled merge/contradiction candidates yet. BEFORE the fix the raw
  // mtime>lastConsolidate check fired and consolidation RAN; AFTER the fix the
  // file is excluded via its `promoted` event and the gate SKIPS.
  test("memory whose only delta is its own promotion → gate SKIPS (emits skip event)", async () => {
    const stash = makeTempDir("akm-551-promoted-skip-");
    // Last consolidate well in the past.
    appendEvent(
      { eventType: "consolidate_completed", ref: "memory:_consolidation", metadata: { processed: 1 } },
      { now: () => new Date("2020-01-01T00:00:00.000Z").getTime() },
    );
    // Freshly-promoted memory: file mtime is naturally newer than 2020. WITHOUT
    // the #551 gate this alone makes mtime>lastConsolidate true → consolidation
    // runs. The `promoted` event below (carrying its assetPath) marks it as a
    // same-cohort promotion to be excluded.
    writeMemory(stash, "just-promoted", "Single-source memory, no merge candidates yet.");
    await buildIndex(stash);
    const assetPath = path.join(stash, "memories", "just-promoted.md");
    appendEvent({
      eventType: "promoted",
      ref: "memory:just-promoted",
      metadata: { assetPath, source: "extract", autoAccept: true },
    });

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(),
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const skipped = readEvents({ type: "improve_skipped", ref: "memory:_consolidation" }).events;
    expect(skipped.some((e) => e.metadata?.reason === "consolidation_no_memory_updates")).toBe(true);
  });

  // (c) A genuinely-settled memory from a PRIOR run (no promotion since the last
  // consolidate — e.g. edited by feedback/manual) still triggers consolidation:
  // the skip event is NOT emitted. This guards against the gate over-skipping.
  test("settled prior-run memory (no same-cohort promotion) → consolidation NOT skipped", async () => {
    const stash = makeTempDir("akm-551-settled-runs-");
    appendEvent(
      { eventType: "consolidate_completed", ref: "memory:_consolidation", metadata: { processed: 1 } },
      { now: () => new Date("2020-01-01T00:00:00.000Z").getTime() },
    );
    // Two memories edited after the last consolidate, with NO `promoted` event
    // tying their mtime to a same-cohort promotion → real work to do.
    writeMemory(stash, "edited-a", "Edited by feedback loop.");
    writeMemory(stash, "edited-b", "Also edited.");
    await buildIndex(stash);

    await akmImprove({
      scope: "memory",
      config: configWithoutPoolGuard(),
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const skipped = readEvents({ type: "improve_skipped", ref: "memory:_consolidation" }).events;
    expect(skipped.some((e) => e.metadata?.reason === "consolidation_no_memory_updates")).toBe(false);
  });
});

// ── P0-A high-retrieval fallback revival ─────────────────────────────────────

/**
 * Seed `count` `search` usage events (with a populated entry_ref) into the
 * freshly-built index.db so getRetrievalCounts sees the ref as high-retrieval.
 * Must run AFTER buildIndex() (the DB has to exist).
 */
function seedRetrievals(ref: string, count: number): void {
  const db = openExistingDatabase(getDbPath());
  try {
    for (let i = 0; i < count; i++) {
      insertUsageEvent(db, { event_type: "search", entry_ref: ref, query: "q", source: "user" });
    }
  } finally {
    closeDatabase(db);
  }
}

describe("P0-A high-retrieval fallback (zero-feedback assets)", () => {
  test("zero-feedback ref above retrieval threshold → reflected (revived P0-A)", async () => {
    const stash = makeTempDir("akm-p0a-rescue-");
    writeMemory(stash, "popular", "Frequently retrieved, never rated.");
    await buildIndex(stash);
    // No feedback events at all — previously this fell into the fullySkipped
    // bucket and never reached the high-retrieval fallback. Seed retrievals so
    // it clears the threshold.
    seedRetrievals("memory:popular", 6);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memory:popular");
  });

  test("zero-feedback ref below retrieval threshold → not reflected", async () => {
    const stash = makeTempDir("akm-p0a-below-");
    writeMemory(stash, "rarely", "Retrieved once, never rated.");
    await buildIndex(stash);
    seedRetrievals("memory:rarely", 1); // below threshold of 5

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memory:rarely");
  });

  test("P0-A fires at most once per asset (prior reflect proposal blocks re-rescue)", async () => {
    const stash = makeTempDir("akm-p0a-once-");
    writeMemory(stash, "already", "High retrieval but already reflected once.");
    await buildIndex(stash);
    seedRetrievals("memory:already", 10);
    // A reflect proposal already exists for this ref → P0-A must not re-fire.
    appendEvent({ eventType: "reflect_invoked", ref: "memory:already" });

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memory:already");
  });
});

// ── Layer 3: high-salience admission gate (#608) ──────────────────────────────

describe("high-salience admission gate (#608)", () => {
  function seedSalience(ref: string, encoding: number): void {
    const db = openStateDatabase();
    try {
      upsertAssetSalience(db, ref, { encoding, outcome: 0, retrieval: 0, rankScore: 0.2 });
    } finally {
      db.close();
    }
  }

  test("zero-feedback ref with encoding_salience ≥ threshold and no prior reflect → reflected", async () => {
    const stash = makeTempDir("akm-hs-rescue-");
    writeMemory(stash, "salient", "Newly distilled, never surfaced to a user.");
    await buildIndex(stash);
    // High encoding_salience, no retrieval, no feedback — only the high-salience
    // lane can rescue it (memory type-weight fallback is 0.5, below threshold).
    seedSalience("memory:salient", 0.9);

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).toContain("memory:salient");
  });

  test("high-salience fires at most once per asset (prior reflect proposal blocks re-rescue)", async () => {
    const stash = makeTempDir("akm-hs-once-");
    writeMemory(stash, "salient", "High salience but already reflected once.");
    await buildIndex(stash);
    seedSalience("memory:salient", 0.9);
    // A reflect proposal already exists for this ref. Without the cooldown guard
    // the high-salience lane re-selected it every run (auto-accept emits a
    // `promoted` event, not `feedback`, so it never leaves noFeedbackCandidates),
    // burning LLM calls and churning the asset. The guard must block re-rescue.
    appendEvent({ eventType: "reflect_invoked", ref: "memory:salient" });

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("memory:salient");
  });

  // #653: regression for the candidateRefs-scope gap. The reflect cooldown map
  // (`lastReflectProposalTs`) used to be built ONLY over `candidateRefs`, while
  // the high-salience lane iterates the broader no-feedback pool. For a rescue-
  // lane ref absent from that map, `!has(ref)` was vacuously true and the
  // once-per-asset guard never fired — the production lore-writer case
  // (57 reflect_invoked events in one day, still re-selected 57×). The fix
  // rebuilds the cooldown maps over the UNION of every lane's candidate refs, so
  // the guard now blocks a recently-reflected high-salience ref even when it is
  // outside candidateRefs. This test runs a mixed population: a feedback-bearing
  // ref (signal-delta lane = candidateRefs) plus two high-salience refs — one
  // with a prior reflect (must be blocked) and one without (must still fire).
  test("#653: high-salience ref with recent reflect is blocked even alongside other lanes; sibling without reflect still fires", async () => {
    const stash = makeTempDir("akm-hs-union-");
    // Signal-delta (candidateRefs) population.
    writeMemory(stash, "rated", "Has fresh feedback — signal-delta lane.");
    // High-salience population (no feedback, no retrieval).
    writeMemory(stash, "salient-cooled", "High salience, already reflected.");
    writeMemory(stash, "salient-fresh", "High salience, never reflected.");
    await buildIndex(stash);

    // Feedback ref: feedback newer than its last reflect → signal-delta eligible.
    appendEvent({ eventType: "reflect_invoked", ref: "memory:rated" }, { now: () => OLDER_MS });
    appendEvent(
      { eventType: "feedback", ref: "memory:rated", metadata: { signal: "negative" } },
      { now: () => NEWER_MS },
    );

    seedSalience("memory:salient-cooled", 0.9);
    seedSalience("memory:salient-fresh", 0.9);
    // Only salient-cooled has a recent reflect proposal → union-scoped guard
    // must exclude it; salient-fresh has none → must be admitted.
    appendEvent({ eventType: "reflect_invoked", ref: "memory:salient-cooled" });

    const reflected: string[] = [];
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    // Cooled high-salience ref is blocked by the union-scoped guard…
    expect(reflected).not.toContain("memory:salient-cooled");
    // …while the never-reflected high-salience sibling is still admitted (guard
    // does not over-block), and the signal-delta ref is unchanged.
    expect(reflected).toContain("memory:salient-fresh");
    expect(reflected).toContain("memory:rated");
  });
});

// ── Aggregated no_new_signal skip event ──────────────────────────────────────

describe("aggregated no_new_signal skip event", () => {
  test("stale-feedback refs emit a single counted improve_skipped, not one per ref", async () => {
    const stash = makeTempDir("akm-no-new-signal-");
    // Two refs with feedback on record but a NEWER reflect+distill proposal →
    // signal-delta gate rejects both for reflect AND distill (fully skipped).
    writeMemory(stash, "stale-a", "Stable A.");
    writeMemory(stash, "stale-b", "Stable B.");
    await buildIndex(stash);

    for (const name of ["stale-a", "stale-b"]) {
      const ref = `memory:${name}`;
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "negative" } }, { now: () => OLDER_MS });
      appendEvent({ eventType: "reflect_invoked", ref }, { now: () => NEWER_MS });
      appendEvent({ eventType: "distill_invoked", ref, metadata: { outcome: "queued" } }, { now: () => NEWER_MS });
    }

    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    const noNewSignal = readEvents({ type: "improve_skipped" }).events.filter(
      (e) => e.metadata?.reason === "no_new_signal",
    );
    // Exactly ONE aggregated event (not one per ref), carrying the ref count.
    expect(noNewSignal.length).toBe(1);
    expect(noNewSignal[0]?.ref).toBeUndefined();
    expect(noNewSignal[0]?.metadata?.count).toBe(2);
  });
});

// ── Attribution: eligibilitySource lane tagging ──────────────────────────────
//
// Each eligibility lane must stamp the ref it selects with the correct
// `eligibilitySource` so the planner can thread it to reflect/distill and onto
// the persisted proposal. The improve harness mocks reflectFn/distillFn, so we
// capture the `eligibilitySource` option the planner passes per ref. The real
// reflect/distill event + proposal stamping is covered by reflect-propose.test
// and distill.test; proactive lane tagging is in proactive-maintenance-flow.test.

describe("attribution: eligibilitySource lane tagging", () => {
  test("signal-delta lane stamps eligibilitySource='signal-delta'", async () => {
    const stash = makeTempDir("akm-attr-signal-");
    writeMemory(stash, "rated", "Has fresh feedback.");
    await buildIndex(stash);
    appendEvent({ eventType: "reflect_invoked", ref: "memory:rated" }, { now: () => OLDER_MS });
    appendEvent(
      { eventType: "feedback", ref: "memory:rated", metadata: { signal: "negative" } },
      { now: () => NEWER_MS },
    );

    const seen = new Map<string, string | undefined>();
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) seen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(seen.get("memory:rated")).toBe("signal-delta");
  });

  test("high-retrieval lane stamps eligibilitySource='high-retrieval'", async () => {
    const stash = makeTempDir("akm-attr-highret-");
    writeMemory(stash, "popular", "Frequently retrieved, never rated.");
    await buildIndex(stash);
    seedRetrievals("memory:popular", 6);

    const seen = new Map<string, string | undefined>();
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) seen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(seen.get("memory:popular")).toBe("high-retrieval");
  });

  test("explicit --scope <ref> bypass stamps eligibilitySource='scope'", async () => {
    const stash = makeTempDir("akm-attr-scope-");
    writeMemory(stash, "targeted", "Explicitly targeted, no feedback at all.");
    await buildIndex(stash);

    const seen = new Map<string, string | undefined>();
    await akmImprove({
      scope: "memory:targeted",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) seen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(seen.get("memory:targeted")).toBe("scope");
  });

  test("precedence: a ref with BOTH fresh feedback and high retrieval is attributed to signal-delta", async () => {
    const stash = makeTempDir("akm-attr-prec-");
    writeMemory(stash, "both", "Rated AND frequently retrieved.");
    await buildIndex(stash);
    // Fresh feedback signal (reactive feedback lane).
    appendEvent({ eventType: "reflect_invoked", ref: "memory:both" }, { now: () => OLDER_MS });
    appendEvent(
      { eventType: "feedback", ref: "memory:both", metadata: { signal: "negative" } },
      { now: () => NEWER_MS },
    );
    // Also above the retrieval threshold (would qualify for high-retrieval too).
    seedRetrievals("memory:both", 10);

    const seen = new Map<string, string | undefined>();
    await akmImprove({
      scope: "memory",
      stashDir: stash,
      minRetrievalCount: 5,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) seen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    // signal-delta > high-retrieval: feedback wins.
    expect(seen.get("memory:both")).toBe("signal-delta");
  });
});

// Removed keys (cooldownByType, cooldownDays, feedbackDistillation) are
// rejected by the strict() default on the affected schema objects — no
// custom test coverage needed beyond zod's own.
