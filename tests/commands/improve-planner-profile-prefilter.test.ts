/**
 * Regression / contract test for the 2026-05-27 planner pre-filter.
 *
 * Spec & background: `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`
 *
 * Pre-2026-05-27, `collectEligibleRefs` queued every indexed (non-`.derived`)
 * entry, so the per-ref profile gates inside the in-loop dispatch had to fire
 * 2× per cron run for every ref the profile would never accept. On the
 * release/0.8.0 stack that meant 18 refs × 2 synthetic actions × ~24 runs/day
 * → 99.07% of the action stream in 7d was pure skip emission.
 *
 * After the fix:
 *   - Refs where EVERY per-ref pass (reflect + distill) on the active profile
 *     would refuse them are dropped at planner time.
 *   - The audit trail moves to a single `improve_skipped` event per ref with
 *     `reason: "profile_filtered_all_passes"` and an envelope entry under
 *     `profileFilteredRefs`.
 *   - Refs that some-but-not-all passes refuse still flow through (so the
 *     partial-pass work still happens).
 *   - Refs whose type IS accepted are unaffected.
 *   - Explicit `--scope <ref>` bypasses the pre-filter (user intent wins).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmDistillResult } from "../../src/commands/improve/distill";
import { akmImprove } from "../../src/commands/improve/improve";
import type { AkmReflectOptions, AkmReflectResult } from "../../src/commands/improve/reflect";
import { saveConfig } from "../../src/core/config/config";
import { appendEvent, readEvents } from "../../src/core/events";
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
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
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
  process.env.AKM_DATA_DIR = makeTempDir("akm-planner-prefilter-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-planner-prefilter-state-");
  process.env.XDG_CACHE_HOME = makeTempDir("akm-planner-prefilter-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-planner-prefilter-config-");
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

describe("planner pre-filter: profile_filtered_all_passes", () => {
  test("script:* refs are dropped at planner time (reflect AND distill both refuse them on default profile)", async () => {
    const stash = makeTempDir("akm-planner-prefilter-script-stash-");
    fs.mkdirSync(path.join(stash, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(stash, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho 'deploy'\n", "utf8");
    fs.writeFileSync(path.join(stash, "scripts", "build.sh"), "#!/usr/bin/env bash\necho 'build'\n", "utf8");
    // Co-located memory so the run has at least one real planned ref.
    fs.mkdirSync(path.join(stash, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "memory", "fixture.md"),
      "---\ntitle: Fixture memory\n---\n\nFixture body.\n",
      "utf8",
    );
    await indexStash(stash);

    const reflectCalls: AkmReflectOptions[] = [];
    const distillCalls: string[] = [];

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (options): Promise<AkmReflectResult> => {
        reflectCalls.push(options);
        return makeStubReflectResult(options.ref ?? "unknown");
      },
      distillFn: async (options): Promise<AkmDistillResult> => {
        distillCalls.push(options.ref);
        return makeStubDistillResult(options.ref);
      },
    });

    // Neither pass was called for the script refs.
    expect(reflectCalls.map((c) => c.ref ?? "").filter((r) => r.startsWith("script:"))).toEqual([]);
    expect(distillCalls.filter((r) => r.startsWith("script:"))).toEqual([]);

    // Scripts are absent from `plannedRefs` and `actions[]`.
    const plannedScripts = (result.plannedRefs ?? []).filter((p) => p.ref.startsWith("script:"));
    expect(plannedScripts).toEqual([]);
    const scriptActions = (result.actions ?? []).filter((a) => a.ref.startsWith("script:"));
    expect(scriptActions).toEqual([]);

    // They surface in `profileFilteredRefs` instead.
    const filteredRefs = (result.profileFilteredRefs ?? []).map((p) => p.ref).sort();
    expect(filteredRefs).toEqual(["script:build.sh", "script:deploy.sh"]);
    for (const entry of result.profileFilteredRefs ?? []) {
      expect(entry.reason).toBe("profile_filtered_all_passes");
    }
  });

  test("wiki:.../raw/... refs are dropped at planner time", async () => {
    const stash = makeTempDir("akm-planner-prefilter-rawwiki-stash-");
    // Wiki layout: <stash>/wikis/<wikiname>/raw/<page>.md → wiki:<wikiname>/raw/<page>
    const wikiDir = path.join(stash, "wikis", "research");
    fs.mkdirSync(path.join(wikiDir, "raw"), { recursive: true });
    // Minimal wiki scaffolding so the indexer recognises it as a wiki source.
    fs.writeFileSync(path.join(wikiDir, "INDEX.md"), "---\ndescription: Research wiki\n---\n# Research Wiki\n", "utf8");
    fs.writeFileSync(path.join(wikiDir, "raw", "draft.md"), "---\ndescription: raw paper\n---\n# raw paper\n", "utf8");
    await indexStash(stash);

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (options): Promise<AkmReflectResult> => makeStubReflectResult(options.ref ?? "unknown"),
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    // Raw-wiki ref must not be in plannedRefs and must appear in the
    // profile-filtered bucket with the new reason code.
    const rawWikiPlanned = (result.plannedRefs ?? []).filter((p) => p.ref.includes("/raw/"));
    expect(rawWikiPlanned).toEqual([]);
    const rawWikiFiltered = (result.profileFilteredRefs ?? []).filter((p) => p.ref.includes("/raw/"));
    expect(rawWikiFiltered.length).toBeGreaterThan(0);
    for (const entry of rawWikiFiltered) {
      expect(entry.reason).toBe("profile_filtered_all_passes");
    }
  });

  test("memory:* refs are NOT pre-filtered (both reflect and distill accept memory)", async () => {
    const stash = makeTempDir("akm-planner-prefilter-memory-stash-");
    fs.mkdirSync(path.join(stash, "memory"), { recursive: true });
    fs.writeFileSync(path.join(stash, "memory", "alpha.md"), "---\ntitle: Alpha memory\n---\n\nAlpha body.\n", "utf8");
    await indexStash(stash);

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (options): Promise<AkmReflectResult> => makeStubReflectResult(options.ref ?? "unknown"),
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    // Primary contract: memory is NOT in profileFilteredRefs (planner accepted
    // it). Downstream signal-delta / preparation-stage filtering is orthogonal.
    expect((result.profileFilteredRefs ?? []).some((p) => p.ref === "memory:alpha")).toBe(false);
  });

  test("skill:* refs are NOT pre-filtered (reflect accepts skill even though distill refuses it)", async () => {
    // Partial-pass refusal: distill's allowedTypes is just [memory], so it
    // rejects skill, but reflect's allowedTypes includes skill. The pre-
    // filter must only drop refs that ALL passes refuse — partial-pass refs
    // must still flow through so reflect work happens. The contract under
    // test is "skill is NOT in `profileFilteredRefs`"; downstream signal-
    // delta / preparation-stage filtering is orthogonal to this layer.
    const stash = makeTempDir("akm-planner-prefilter-skill-stash-");
    fs.mkdirSync(path.join(stash, "skills", "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "skills", "alpha", "SKILL.md"),
      "---\ndescription: Alpha skill\nwhen_to_use: Always\n---\n\nAlpha body.\n",
      "utf8",
    );
    await indexStash(stash);
    // Feedback signal so the preparation stage keeps the ref alive — otherwise
    // the skill ref is filtered out for "no signal", which would falsely look
    // like the planner pre-filter dropped it.
    appendEvent({
      eventType: "feedback",
      ref: "skill:alpha",
      metadata: { signal: "positive", note: "fixture" },
    });

    const result = await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (options): Promise<AkmReflectResult> => makeStubReflectResult(options.ref ?? "unknown"),
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    // Primary contract: skill is NOT in profileFilteredRefs.
    expect((result.profileFilteredRefs ?? []).some((p) => p.ref === "skill:alpha")).toBe(false);
    // And reflect actually ran for skill (partial-pass refusal kept it alive).
    expect((result.actions ?? []).some((a) => a.ref === "skill:alpha" && a.mode === "reflect")).toBe(true);
  });

  test("emits one improve_skipped event per pre-filtered ref with reason profile_filtered_all_passes", async () => {
    const stash = makeTempDir("akm-planner-prefilter-event-stash-");
    fs.mkdirSync(path.join(stash, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(stash, "scripts", "a.sh"), "#!/bin/sh\n", "utf8");
    fs.writeFileSync(path.join(stash, "scripts", "b.sh"), "#!/bin/sh\n", "utf8");
    fs.writeFileSync(path.join(stash, "scripts", "c.sh"), "#!/bin/sh\n", "utf8");
    await indexStash(stash);

    await akmImprove({
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (options): Promise<AkmReflectResult> => makeStubReflectResult(options.ref ?? "unknown"),
      distillFn: async (options): Promise<AkmDistillResult> => makeStubDistillResult(options.ref),
    });

    const events = readEvents({ type: "improve_skipped" }).events;
    const profileFilteredEvents = events.filter(
      (e) => (e.metadata as { reason?: string } | undefined)?.reason === "profile_filtered_all_passes",
    );
    const filteredScriptRefs = profileFilteredEvents.map((e) => e.ref).filter((r): r is string => !!r);
    expect(filteredScriptRefs.sort()).toEqual(["script:a.sh", "script:b.sh", "script:c.sh"]);
  });
});
