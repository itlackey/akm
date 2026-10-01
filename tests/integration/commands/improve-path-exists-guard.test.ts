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
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import type { AkmDistillResult, AkmReflectResult } from "../../../src/core/improve-types";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLesson } from "../../_helpers/assets";
import { makeProposal } from "../../_helpers/factories";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  mutateScopedEnv,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

const dirCleanups: (() => void)[] = [];

function makeTempDir(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  dirCleanups.push(cleanup);
  return dir;
}

async function buildIndex(stashDir: string): Promise<void> {
  mutateScopedEnv("AKM_BUNDLE_DIR", stashDir);
  saveConfig(
    withTestImproveLlm({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
    }),
  );
  await akmIndex({ stashDir, full: true });
}

function durableRef(ref: string): string {
  return `stash//${ref}`;
}

const reflectFn = async ({ ref }: { ref?: string }): Promise<AkmReflectResult> => ({
  schemaVersion: 2,
  ok: true,
  proposal: makeProposal(ref ?? "lessons/unknown"),
  ref: ref ?? "",
  engine: "test",
  durationMs: 1,
});

const distillFn = async ({ ref }: { ref: string }): Promise<AkmDistillResult> => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  proposalRef: `lessons/${ref.replace(/[:/]/g, "-")}-lesson`,
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

let storage: IsolatedAkmStorage;

beforeEach(() => {
  const akmDataDir = makeSandboxDir("akm-improve-path-exists-data-");
  const akmStateDir = makeSandboxDir("akm-improve-path-exists-state-");
  dirCleanups.push(akmDataDir.cleanup, akmStateDir.cleanup);
  storage = withIsolatedAkmStorage({ AKM_DATA_DIR: akmDataDir.dir, AKM_STATE_DIR: akmStateDir.dir });
});

afterEach(() => {
  storage.cleanup();
  for (const cleanup of dirCleanups.splice(0)) cleanup();
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
    expect(result.plannedRefs.some((p) => p.ref === "lessons/ghost")).toBe(false);
    expect(reflectedRefs).not.toContain("lessons/ghost");
    expect(distilledRefs).not.toContain("lessons/ghost");
  });

  test("all files exist — guard is a no-op and no 'candidates dropped' log line is emitted", async () => {
    const stashDir = makeTempDir("akm-improve-path-exists-noop-");
    writeLesson(stashDir, "alpha", "alpha lesson", "trigger");
    writeLesson(stashDir, "beta", "beta lesson", "trigger");
    await buildIndex(stashDir);

    // Inject a negative feedback signal (the one that plans a reflect) so both
    // lessons pass the signal filter and arrive at the final guard.
    const { appendEvent } = await import("../../../src/core/events");
    appendEvent({
      eventType: "feedback",
      ref: durableRef("lessons/alpha"),
      metadata: { signal: "negative", reason: "ok" },
    });
    appendEvent({
      eventType: "feedback",
      ref: durableRef("lessons/beta"),
      metadata: { signal: "negative", reason: "ok" },
    });

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
      expect(refs).toEqual(["lessons/alpha", "lessons/beta"]);

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

    // Negative feedback so all three pass the signal filter and reach the guard.
    const { appendEvent } = await import("../../../src/core/events");
    appendEvent({
      eventType: "feedback",
      ref: durableRef("lessons/kept"),
      metadata: { signal: "negative", reason: "ok" },
    });
    appendEvent({
      eventType: "feedback",
      ref: durableRef("lessons/gone"),
      metadata: { signal: "negative", reason: "ok" },
    });
    appendEvent({
      eventType: "feedback",
      ref: durableRef("lessons/alive"),
      metadata: { signal: "negative", reason: "ok" },
    });

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
    expect(plannedRefs).toContain("lessons/kept");
    expect(plannedRefs).toContain("lessons/alive");
    expect(plannedRefs).not.toContain("lessons/gone");
  });
});
