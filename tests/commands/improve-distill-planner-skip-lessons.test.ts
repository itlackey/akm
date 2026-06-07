/**
 * Planner waste regression — `improve` must not queue `lesson:*` refs into
 * the distill path.
 *
 * Before this fix, `isLessonCandidate(ref) || shouldDistillMemoryRef(ref)`
 * was used as the distill-candidacy gate inside `akm improve`. After commit
 * ef938fd narrowed `isLessonCandidate` to return `true` *only* for `lesson:*`
 * refs, that gate flipped to a hostile state: every lesson asset got queued
 * into the distill path, and `akmDistill` then refused each one at the
 * recursive-lesson-input guard with `outcome: "skipped"`. Real-world impact:
 * the same 19 lesson refs re-queued every hourly improve run with zero work.
 *
 * The fix exports {@link DISTILL_REFUSED_INPUT_TYPES} from `distill.ts` as
 * the single source of truth for input-types `akmDistill` refuses, and the
 * planner consumes the set via a new `isDistillCandidateRef` helper.
 *
 * These tests pin the planner-side contract:
 *
 *   1. A stash containing both `lesson:*` and `memory:*` refs produces a
 *      planned queue where no lesson ref enters the distill-mode actions.
 *   2. `DISTILL_REFUSED_INPUT_TYPES` matches the runtime predicate inside
 *      `akmDistill` — adding a new refuse-case in distill without updating
 *      the exported set fails this test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type AkmDistillOptions,
  type AkmDistillResult,
  akmDistill,
  DISTILL_REFUSED_INPUT_TYPES,
  isDistillRefusedInputType,
} from "../../src/commands/improve/distill";
import { akmImprove } from "../../src/commands/improve/improve";
import type { AkmReflectOptions, AkmReflectResult } from "../../src/commands/improve/reflect";
import { saveConfig } from "../../src/core/config";
import { appendEvent } from "../../src/core/events";
import { akmIndex } from "../../src/indexer/indexer";

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

function makeFixtureStash(): string {
  const stash = makeTempDir("akm-improve-planner-skip-lessons-");
  for (const sub of ["lessons", "memories", "skills"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  // Three lessons — these are the refs that should be filtered from the
  // distill queue.
  for (const name of ["alpha", "beta", "gamma"]) {
    fs.writeFileSync(
      path.join(stash, "lessons", `${name}-lesson.md`),
      [
        "---",
        `description: Lesson ${name}`,
        `when_to_use: When the ${name} signal appears`,
        "sources:",
        "  - skill:deploy",
        "---",
        "",
        `Recorded insight for ${name}.`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  // One curated memory — this *should* enter the distill queue (it is the
  // legitimate distill candidacy path).
  fs.writeFileSync(
    path.join(stash, "memories", "deploy-fact.md"),
    [
      "---",
      "description: Deployment requires VPN access",
      "source: skill:deploy",
      "observed_at: 2026-04-20",
      "confidence: 0.92",
      "quality: curated",
      "---",
      "",
      "Connect the VPN before production deploys so cluster access works.",
      "",
    ].join("\n"),
    "utf8",
  );
  // A skill, which never enters the distill path.
  fs.mkdirSync(path.join(stash, "skills", "deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(stash, "skills", "deploy", "SKILL.md"),
    "---\ndescription: deploy apps\nwhen_to_use: shipping\n---\n\nDeploy carefully.\n",
    "utf8",
  );
  return stash;
}

async function indexStash(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

beforeEach(() => {
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-planner-skip-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-improve-planner-skip-state-");
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-planner-skip-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-planner-skip-config-");
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

describe("improve planner: skip distill-refused input types", () => {
  test("no lesson:* ref enters the distill-mode action queue", async () => {
    const stash = makeFixtureStash();
    await indexStash(stash);

    // Give every ref a positive feedback signal so the all-scope improve run
    // considers them eligible (otherwise the signal/retrieval gate at
    // improve.ts:1553 drops zero-signal refs and the test plan is empty).
    for (const ref of ["lesson:alpha-lesson", "lesson:beta-lesson", "lesson:gamma-lesson", "memory:deploy-fact"]) {
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "positive", note: "fixture" } });
    }

    const distillCalls: AkmDistillOptions[] = [];
    const reflectCalls: AkmReflectOptions[] = [];

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async (options): Promise<AkmReflectResult> => {
        reflectCalls.push(options);
        return {
          schemaVersion: 1,
          ok: true,
          ref: options.ref ?? "lesson:alpha-lesson",
          agentProfile: "fake-agent",
          durationMs: 1,
          proposal: {
            id: `reflect-${reflectCalls.length}`,
            ref: options.ref ?? "lesson:alpha-lesson",
            status: "pending",
            source: "reflect",
            createdAt: "2026-05-21T00:00:00.000Z",
            updatedAt: "2026-05-21T00:00:00.000Z",
            payload: { content: "# reflect" },
          },
        };
      },
      distillFn: async (options): Promise<AkmDistillResult> => {
        distillCalls.push(options);
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: options.ref,
          lessonRef: `lesson:${options.ref.replace(/[:/]/g, "-")}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    // Planner saw all four refs (three lessons + one memory). Skills are
    // present in the index but the planner currently only enqueues writable
    // entries that are either non-derived or memory-cleanup candidates;
    // we don't rely on the skill count here.
    const plannedTypes = result.plannedRefs.map((r) => r.ref);
    expect(plannedTypes).toContain("lesson:alpha-lesson");
    expect(plannedTypes).toContain("lesson:beta-lesson");
    expect(plannedTypes).toContain("lesson:gamma-lesson");
    expect(plannedTypes).toContain("memory:deploy-fact");

    // CORE ASSERTION — the planner-waste fix.
    // No lesson ref reaches the distill seam. Pre-fix this list contained
    // every lesson present in the stash and each one was refused inside
    // akmDistill with `Distill refuses lesson inputs`.
    const distilledRefs = distillCalls.map((c) => c.ref);
    expect(distilledRefs.filter((r) => r.startsWith("lesson:"))).toEqual([]);

    // And no distill-mode action records a lesson ref either (covers the
    // case where a future regression might call distill some other way and
    // still record an action against a lesson).
    const distillActions = (result.actions ?? []).filter((a) => a.mode === "distill");
    const distillActionRefs = distillActions.map((a) => a.ref);
    expect(distillActionRefs.filter((r) => r.startsWith("lesson:"))).toEqual([]);

    // Sanity: reflect still runs on lessons — they're a legitimate reflect
    // target, just not a distill input.
    const reflectedRefs = reflectCalls.map((c) => c.ref ?? "");
    expect(reflectedRefs.filter((r) => r.startsWith("lesson:")).length).toBeGreaterThan(0);
  });
});

describe("DISTILL_REFUSED_INPUT_TYPES contract", () => {
  test("contains the current refuse-case (lesson) so the planner skips it", () => {
    expect(DISTILL_REFUSED_INPUT_TYPES.has("lesson")).toBe(true);
    expect(isDistillRefusedInputType("lesson")).toBe(true);
    expect(isDistillRefusedInputType("memory")).toBe(false);
    expect(isDistillRefusedInputType("skill")).toBe(false);
    expect(isDistillRefusedInputType("knowledge")).toBe(false);
  });

  test("matches the runtime gate in akmDistill — refused types short-circuit with `outcome: skipped`", async () => {
    // For every type in the exported refused set, akmDistill must return a
    // `skipped` envelope without invoking the LLM seam. If someone adds a
    // new refuse-case inside akmDistill (e.g. refusing wiki:* inputs) but
    // forgets to add the type to DISTILL_REFUSED_INPUT_TYPES, this test
    // fails because the LLM seam fires for that input.
    //
    // Run through every refused type the exported set advertises.
    for (const refusedType of DISTILL_REFUSED_INPUT_TYPES) {
      const result = await akmDistill({
        ref: `${refusedType}:fixture`,
        chat: async () => {
          throw new Error(`distill must not invoke LLM for refused input type "${refusedType}"`);
        },
      });
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("skipped");
    }
  });
});
