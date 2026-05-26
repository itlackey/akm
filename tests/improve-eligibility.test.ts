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
import type { AkmDistillResult } from "../src/commands/distill";
import { akmImprove } from "../src/commands/improve";
import type { AkmReflectResult } from "../src/commands/reflect";
import { saveConfig } from "../src/core/config";
import { appendEvent, readEvents } from "../src/core/events";
import { akmIndex } from "../src/indexer/indexer";

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
    appendEvent({ eventType: "reflect_invoked", ref: "memory:auth-tips" });
    // Sleep a tick so the next event has a strictly greater ts.
    await new Promise((r) => setTimeout(r, 10));
    // Newer feedback event arrived after the reflect.
    appendEvent({
      eventType: "feedback",
      ref: "memory:auth-tips",
      metadata: { signal: "negative" },
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

    expect(reflected).toContain("memory:auth-tips");
  });

  test("no new feedback since last reflect proposal → ineligible", async () => {
    const stash = makeTempDir("akm-elig-reflect-no-signal-");
    writeMemory(stash, "stale", "Old content.");
    await buildIndex(stash);

    // Old feedback event THEN a reflect_invoked event (reflect is newer).
    appendEvent({
      eventType: "feedback",
      ref: "memory:stale",
      metadata: { signal: "negative" },
    });
    await new Promise((r) => setTimeout(r, 10));
    appendEvent({ eventType: "reflect_invoked", ref: "memory:stale" });

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

    appendEvent({
      eventType: "distill_invoked",
      ref: "memory:auth-tips",
      metadata: { outcome: "queued" },
    });
    await new Promise((r) => setTimeout(r, 10));
    appendEvent({
      eventType: "feedback",
      ref: "memory:auth-tips",
      metadata: { signal: "negative" },
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

    expect(distilled).toContain("memory:auth-tips");
  });

  test("no new feedback since last distill proposal → ineligible (for distill)", async () => {
    const stash = makeTempDir("akm-elig-distill-stale-");
    writeMemory(stash, "old-memory", "Stable content.");
    await buildIndex(stash);

    appendEvent({
      eventType: "feedback",
      ref: "memory:old-memory",
      metadata: { signal: "negative" },
    });
    await new Promise((r) => setTimeout(r, 10));
    appendEvent({
      eventType: "distill_invoked",
      ref: "memory:old-memory",
      metadata: { outcome: "queued" },
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
    // Old completion event, then a freshly-written memory.
    appendEvent({
      eventType: "consolidate_completed",
      ref: "memory:_consolidation",
      metadata: { processed: 1 },
    });
    await new Promise((r) => setTimeout(r, 20));
    writeMemory(stash, "fresh-mem", "Recent edit.");
    await buildIndex(stash);

    await akmImprove({
      scope: "memory",
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

// Removed keys (cooldownByType, cooldownDays, feedbackDistillation) are
// rejected by the strict() default on the affected schema objects — no
// custom test coverage needed beyond zod's own.
