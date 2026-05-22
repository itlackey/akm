/**
 * Regression test: improve must not dispatch unsupported asset types (script,
 * vault, task, …) to the reflect path.
 *
 * Before this fix, `src/commands/reflect.ts` contained an internal guard
 * (REFLECT_ALLOWED_TYPES) that rejected non-markdown-canonical types with a
 * `parse_error`, but the improve loop dispatched those refs unconditionally —
 * they burned a reflect slot and recorded `reflect-failed` actions. In the
 * 2026-05-22T05:10 run, 2 of 4 reflect-failed actions were script-type rejections.
 *
 * The fix exports REFLECT_ALLOWED_TYPES from reflect.ts and adds a pre-check
 * in the improve loop at the reflect dispatch site: refs whose type is NOT in
 * the set are short-circuited with mode `reflect-skipped` and reason
 * `"unsupported-type"` instead of calling akmReflect.
 *
 * This test pins the planner-side contract:
 *
 *   1. A stash containing a `script:*` ref that would otherwise be a reflect
 *      candidate never causes akmReflect to be called.
 *   2. The action for that ref is recorded as `reflect-skipped` with reason
 *      `"type-filter"` (not `reflect-failed`) so the run summary is not polluted.
 *   3. A co-located `skill:*` ref (an allowed type) IS reflected normally —
 *      the guard does not accidentally block allowed types.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmDistillResult } from "../../src/commands/distill";
import { akmImprove } from "../../src/commands/improve";
import type { AkmReflectOptions, AkmReflectResult } from "../../src/commands/reflect";
import { REFLECT_ALLOWED_TYPES } from "../../src/commands/reflect";
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

async function indexStash(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

function makeStubReflectResult(ref: string): AkmReflectResult {
  return {
    schemaVersion: 1,
    ok: true,
    ref,
    agentProfile: "test-agent",
    durationMs: 1,
    proposal: {
      id: `reflect-${ref.replace(/[^a-z0-9]/gi, "-")}`,
      ref,
      status: "pending",
      source: "reflect",
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
      payload: { content: "# stub reflect" },
    },
  };
}

function makeStubDistillResult(ref: string): AkmDistillResult {
  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef: ref,
    lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
  };
}

beforeEach(() => {
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-reflect-unsupported-type-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-improve-reflect-unsupported-type-state-");
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-reflect-unsupported-type-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-reflect-unsupported-type-config-");
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

describe("REFLECT_ALLOWED_TYPES export", () => {
  test("does not include 'script'", () => {
    expect(REFLECT_ALLOWED_TYPES.has("script")).toBe(false);
  });

  test("does not include 'vault'", () => {
    expect(REFLECT_ALLOWED_TYPES.has("vault")).toBe(false);
  });

  test("does not include 'task'", () => {
    expect(REFLECT_ALLOWED_TYPES.has("task")).toBe(false);
  });

  test("includes all markdown-canonical types", () => {
    for (const t of ["knowledge", "memory", "lesson", "wiki", "skill", "agent", "command", "workflow"]) {
      expect(REFLECT_ALLOWED_TYPES.has(t)).toBe(true);
    }
  });
});

describe("improve loop: unsupported-type reflect pre-check", () => {
  test("script:* ref is recorded as reflect-skipped, not reflect-failed, and akmReflect is NOT called", async () => {
    const stash = makeTempDir("akm-improve-reflect-unsupported-stash-");

    // Create a script asset — stored under scripts/ with a .sh extension.
    fs.mkdirSync(path.join(stash, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(stash, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho 'deploy'\n", "utf8");

    // Also create a skill so we can assert that allowed types still flow through.
    fs.mkdirSync(path.join(stash, "skills", "deploy-guide"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "deploy-guide", "SKILL.md"),
      "---\ndescription: Deploy guide\nwhen_to_use: When deploying\n---\n\nDeploy carefully.\n",
      "utf8",
    );

    await indexStash(stash);

    // Inject positive feedback so both refs pass the signal filter inside improve.
    appendEvent({ eventType: "feedback", ref: "script:deploy.sh", metadata: { signal: "positive", note: "fixture" } });
    appendEvent({
      eventType: "feedback",
      ref: "skill:deploy-guide",
      metadata: { signal: "positive", note: "fixture" },
    });

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
        return makeStubReflectResult(options.ref ?? "unknown");
      },
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    // Core assertion 1: akmReflect was never called for the script ref.
    const reflectedRefs = reflectCalls.map((c) => c.ref ?? "");
    expect(reflectedRefs.filter((r) => r.startsWith("script:"))).toEqual([]);

    // Core assertion 2: the script ref action is recorded as reflect-skipped.
    const scriptActions = (result.actions ?? []).filter((a) => a.ref === "script:deploy.sh");
    expect(scriptActions.length).toBeGreaterThan(0);
    const reflectFailedActions = scriptActions.filter((a) => a.mode === "reflect-failed");
    expect(reflectFailedActions).toEqual([]);
    const reflectSkippedActions = scriptActions.filter((a) => a.mode === "reflect-skipped");
    expect(reflectSkippedActions.length).toBeGreaterThan(0);
    // Reason must be "type-filter" (profile-driven) — not a generic failure.
    // (Previously "unsupported-type" — unified to "type-filter" with the profile system.)
    for (const action of reflectSkippedActions) {
      expect((action.result as { reason?: string }).reason).toBe("type-filter");
    }

    // Core assertion 3: the allowed-type skill ref IS reflected normally (type
    // guard must not block allowed types).
    const skillActions = (result.actions ?? []).filter((a) => a.ref === "skill:deploy-guide");
    const skillReflectActions = skillActions.filter((a) => a.mode === "reflect");
    expect(skillReflectActions.length).toBeGreaterThan(0);
  });
});
