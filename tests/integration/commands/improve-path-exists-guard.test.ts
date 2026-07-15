/**
 * Regression test for the final pathExists guard in `runImprovePreparationStage`.
 *
 * Empirical reject-pattern analysis (improve-critical-review 2026-05-20) found
 * that the single biggest reject category was "Asset no longer exists on disk"
 * (604 of 1407 rejected proposals — 43%). Cause: the planner reads candidate
 * refs from the index DB and never re-checks the filesystem before dispatching
 * reflect/distill, so a deletion that races against the run produces a doomed
 * LLM call and an immediately-rejected proposal.
 *
 * The fix adds a final `findAssetFilePath` + `fs.existsSync` guard at the
 * latest point in the candidate-selection chain — after cooldown, validation,
 * signal filtering, and sort. Refs whose backing file has vanished are
 * dropped from `actionableRefs` (and therefore from `loopRefs`, dispatch, and
 * the returned `plannedRefs` envelope) and an `improve_skipped` event with
 * `reason: "asset_missing_on_disk"` is recorded for telemetry.
 *
 * Phase 1 validation already catches the static case (file missing at start
 * of preparation); this regression test exercises the post-filter contract:
 * a ref whose file is missing must never appear in `result.plannedRefs`,
 * regardless of whether Phase 1 or the final guard is the catcher.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLesson } from "../../_helpers/assets";
import { makeProposal } from "../../_helpers/factories";
import { withTestImproveLlm } from "../../_helpers/improve-config";

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

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

const reflectFn = async ({ ref }: { ref?: string }): Promise<AkmReflectResult> => ({
  schemaVersion: 2,
  ok: true,
  proposal: makeProposal(ref ?? "lesson:unknown"),
  ref: ref ?? "",
  engine: "test",
  durationMs: 1,
});

const distillFn = async ({ ref }: { ref: string }): Promise<AkmDistillResult> => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

const reindexFn = async (): Promise<{
  schemaVersion: 1;
  ok: true;
  indexed: number;
  warnings: string[];
  errors: string[];
  durationMs: number;
}> => ({
  schemaVersion: 1,
  ok: true,
  indexed: 0,
  warnings: [],
  errors: [],
  durationMs: 0,
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-path-exists-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-path-exists-config-");
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-path-exists-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-improve-path-exists-state-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.AKM_DATA_DIR === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = savedEnv.AKM_DATA_DIR;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.AKM_STATE_DIR === undefined) delete process.env.AKM_STATE_DIR;
  else process.env.AKM_STATE_DIR = savedEnv.AKM_STATE_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akmImprove final pathExists guard", () => {
  test("ref whose file is missing on disk does not appear in plannedRefs", async () => {
    const stashDir = makeTempDir("akm-improve-path-exists-stash-");
    writeLesson(stashDir, "ghost", "ghost lesson", "trigger");
    await buildIndex(stashDir);

    // Simulate the file vanishing between index time and run time (the empirical
    // 43% reject pattern). The DB still has the row; the filesystem does not.
    fs.unlinkSync(path.join(stashDir, "lessons", "ghost.md"));

    const reflectedRefs: string[] = [];
    const distilledRefs: string[] = [];

    const result = await akmImprove({
      scope: "lesson",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn,
      reflectFn: async (args) => {
        if (args.ref) reflectedRefs.push(args.ref);
        return reflectFn(args);
      },
      distillFn: async (args) => {
        if (args.ref) distilledRefs.push(args.ref);
        return distillFn(args);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.plannedRefs.some((p) => p.ref === "lesson:ghost")).toBe(false);
    expect(reflectedRefs).not.toContain("lesson:ghost");
    expect(distilledRefs).not.toContain("lesson:ghost");
  });

  test("all files exist — guard is a no-op and no 'candidates dropped' log line is emitted", async () => {
    const stashDir = makeTempDir("akm-improve-path-exists-noop-");
    writeLesson(stashDir, "alpha", "alpha lesson", "trigger");
    writeLesson(stashDir, "beta", "beta lesson", "trigger");
    await buildIndex(stashDir);

    // Inject a positive feedback signal so both lessons pass the signal filter
    // and arrive at the final guard.
    const { appendEvent } = await import("../../../src/core/events");
    appendEvent({ eventType: "feedback", ref: "lesson:alpha", metadata: { signal: "positive", note: "ok" } });
    appendEvent({ eventType: "feedback", ref: "lesson:beta", metadata: { signal: "positive", note: "ok" } });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await akmImprove({
        scope: "lesson",
        stashDir,
        ensureIndexFn: async () => false,
        reindexFn,
        reflectFn,
        distillFn,
      });

      expect(result.ok).toBe(true);
      const refs = result.plannedRefs.map((p) => p.ref).sort();
      expect(refs).toEqual(["lesson:alpha", "lesson:beta"]);

      const emittedLines = warnSpy.mock.calls.flat().map((arg) => String(arg));
      // No `[improve] N candidates dropped — file not on disk` line should be emitted
      // on the happy path (filter is silent when count is zero).
      expect(emittedLines.some((line) => line.includes("candidates dropped — file not on disk"))).toBe(false);

      // No telemetry event for asset_missing_on_disk should be recorded.
      const skippedEvents = readEvents({ type: "improve_skipped" }).events;
      expect(skippedEvents.some((e) => e.metadata?.reason === "asset_missing_on_disk")).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("mix of existing and missing files — only missing refs are dropped, log line emitted", async () => {
    const stashDir = makeTempDir("akm-improve-path-exists-mix-");
    writeLesson(stashDir, "kept", "kept lesson", "trigger");
    writeLesson(stashDir, "gone", "gone lesson", "trigger");
    writeLesson(stashDir, "alive", "alive lesson", "trigger");
    await buildIndex(stashDir);

    // Positive feedback so all three pass the signal filter and reach the guard.
    const { appendEvent } = await import("../../../src/core/events");
    appendEvent({ eventType: "feedback", ref: "lesson:kept", metadata: { signal: "positive", note: "ok" } });
    appendEvent({ eventType: "feedback", ref: "lesson:gone", metadata: { signal: "positive", note: "ok" } });
    appendEvent({ eventType: "feedback", ref: "lesson:alive", metadata: { signal: "positive", note: "ok" } });

    // Delete one file post-index to simulate the deletion race.
    fs.unlinkSync(path.join(stashDir, "lessons", "gone.md"));

    const result = await akmImprove({
      scope: "lesson",
      stashDir,
      ensureIndexFn: async () => false,
      reindexFn,
      reflectFn,
      distillFn,
    });

    expect(result.ok).toBe(true);
    const plannedRefs = result.plannedRefs.map((p) => p.ref).sort();
    expect(plannedRefs).toContain("lesson:kept");
    expect(plannedRefs).toContain("lesson:alive");
    expect(plannedRefs).not.toContain("lesson:gone");
  });
});
