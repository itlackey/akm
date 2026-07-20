// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.7 — focused unit coverage for the per-ref improve-loop pass extracted
 * from `runImproveLoopStage` (R31 decomposition, testability requirement).
 *
 * `processImproveLoopRef` is driven directly with injected `reflectFn` /
 * `distillFn` seams — no LLM, no index.db — and its returned {@link LoopRefTally}
 * is asserted instead of shared mutable loop state. `prepareImproveLoopEnv`
 * pins the derived guards the orchestrator hands every pass.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { deriveLessonRef } from "../../../src/commands/improve/distill";
import type { AkmImproveOptions, ImproveLoopState } from "../../../src/commands/improve/improve-run-types";
import {
  type ImproveLoopEnv,
  prepareImproveLoopEnv,
  processImproveLoopRef,
} from "../../../src/commands/improve/loop-stages";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { createRunContext } from "../../../src/commands/improve/run-context";
import type { Proposal } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { UsageError } from "../../../src/core/errors";
import type { EventEnvelope } from "../../../src/core/events";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshSandbox(): { stashDir: string; eventsDbPath: string } {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return { stashDir: stash.dir, eventsDbPath: `${dataSb.dir}/akm/state.db` };
}

function eligibleRef(ref: string): ImproveEligibleRef {
  return { ref, reason: "scope-type" };
}

function reflectOk(ref: string): AkmReflectResult {
  return {
    schemaVersion: 2,
    ok: true,
    proposal: { id: "prop-1", confidence: 0.9 } as unknown as Proposal,
    ref,
    engine: "test-engine",
    durationMs: 5,
  };
}

function reflectFail(reason: string, error = `${reason} error`): AkmReflectResult {
  return { schemaVersion: 2, ok: false, reason: reason as never, error, exitCode: null };
}

function distillQueued(ref: string, proposalKind: "lesson" | "knowledge") {
  return {
    schemaVersion: 1 as const,
    ok: true,
    outcome: "queued" as const,
    inputRef: ref,
    lessonRef: deriveLessonRef(ref),
    proposalKind,
    proposal: { id: "dp-1", confidence: 0.8 } as unknown as Proposal,
  };
}

/** Build a minimal `ImproveLoopEnv` around injected verb seams. */
function makeEnv(overrides: Partial<ImproveLoopEnv> & { stashDir: string }): ImproveLoopEnv {
  const options: AkmImproveOptions = { stashDir: overrides.stashDir, config: {} as AkmConfig };
  return {
    scope: { mode: "all" },
    options,
    reflectFn: () => {
      throw new Error("reflectFn not expected in this scenario");
    },
    distillFn: () => {
      throw new Error("distillFn not expected in this scenario");
    },
    signalBearingSet: new Set(),
    distillCooledRefs: new Set(),
    distillOnlyRefSet: new Set(),
    recentErrors: {},
    rejectedProposalsByRef: new Map(),
    improveProfile: {},
    resolvedPlan: {
      processes: { reflect: { runner: null }, distill: { runner: null } },
    } as unknown as ImproveLoopEnv["resolvedPlan"],
    skipDistillDueToRequirePlannedRefs: false,
    pendingProposalRefSet: new Set(),
    remainingBudgetMs: () => 60_000,
    ...overrides,
  };
}

describe("processImproveLoopRef — reflect half", () => {
  test("successful reflect records a `reflect` action and no error pushes", async () => {
    const { stashDir } = freshSandbox();
    const seen: unknown[] = [];
    const env = makeEnv({
      stashDir,
      reflectFn: (args) => {
        seen.push(args);
        return Promise.resolve(reflectOk("knowledge/guide.md"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef("knowledge/guide.md"), env);

    // The distill half always records its type-filter skip for knowledge refs
    // (default distill allowedTypes is ["memory"]) — same as the inline loop did.
    expect(tally.actions.map((a) => a.mode)).toEqual(["reflect", "distill-skipped"]);
    expect(tally.recentErrorPushes).toEqual([]);
    expect(tally.reflectsWithErrorContext).toBe(0);
    expect(tally.memoryRefsForInference).toEqual([]);
    // knowledge: refs are not distill candidates — the distill half is silent.
    expect(seen).toHaveLength(1);
  });

  test.each([
    ["cooldown", "reflect-cooldown", false],
    ["content_policy_reject", "reflect-guard-rejected", true],
    ["unsupported_type", "reflect-skipped", false],
    ["no_change", "reflect-skipped", false],
    ["agent_error", "reflect-failed", true],
  ] as const)("reflect failure reason %s → mode %s (error push: %p)", async (reason, mode, pushed) => {
    const { stashDir } = freshSandbox();
    const env = makeEnv({ stashDir, reflectFn: () => Promise.resolve(reflectFail(reason)) });

    const tally = await processImproveLoopRef(eligibleRef("knowledge/guide.md"), env);

    expect(tally.actions.map((a) => a.mode)).toEqual([mode, "distill-skipped"]);
    expect(tally.recentErrorPushes).toEqual(pushed ? [{ originator: "reflect", message: `${reason} error` }] : []);
  });

  test("recent reflect errors are injected as avoidPatterns and tallied", async () => {
    const { stashDir } = freshSandbox();
    let receivedAvoid: string[] | undefined;
    const env = makeEnv({
      stashDir,
      recentErrors: { reflect: ["boom 1", "boom 2"], "schema-repair": ["cross-task noise"] },
      reflectFn: (args) => {
        receivedAvoid = (args as { avoidPatterns?: string[] }).avoidPatterns;
        return Promise.resolve(reflectOk("knowledge/guide.md"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef("knowledge/guide.md"), env);

    // O-5 / #378: only reflect-originator errors reach the prompt.
    expect(receivedAvoid).toEqual(["boom 1", "boom 2"]);
    expect(tally.reflectsWithErrorContext).toBe(1);
  });

  test("profile type-filter records reflect-skipped without invoking the seam", async () => {
    const { stashDir } = freshSandbox();
    const env = makeEnv({
      stashDir,
      improveProfile: { processes: { reflect: { allowedTypes: ["memory"] } } } as ImproveLoopEnv["improveProfile"],
    });

    const tally = await processImproveLoopRef(eligibleRef("knowledge/guide.md"), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["reflect-skipped", "distill-skipped"]);
    expect(tally.actions[0].result).toEqual({ ok: true, reason: "type-filter" });
    expect(tally.actions[1].result).toEqual({ ok: true, reason: "type-filter" });
  });

  test(".derived memory refs skip reflect with the B6 synthetic action", async () => {
    const { stashDir } = freshSandbox();
    const env = makeEnv({ stashDir });

    const tally = await processImproveLoopRef(eligibleRef("memories/note.derived"), env);

    // B6 reflect skip, then the weak-signal distill skip (memory ref, no
    // feedback signal, non-ref scope) — both synthetic, no seam invoked.
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped", "distill-skipped"]);
    expect(tally.actions[0].result).toEqual({ ok: true, reason: "derived-memory-reflect-skipped" });
    expect(tally.actions[1].result).toEqual({ ok: true, reason: "memory requires recent feedback signal" });
  });
});

describe("processImproveLoopRef — distill half", () => {
  const memoryRef = "memories/finding-1";

  function distillOnlyEnv(overrides: Partial<ImproveLoopEnv> & { stashDir: string }): ImproveLoopEnv {
    // distill-only refs skip the reflect call entirely (Bug D2), isolating the
    // distill half; the ref bears a feedback signal so the weak-signal gate is open.
    return makeEnv({
      distillOnlyRefSet: new Set([memoryRef]),
      signalBearingSet: new Set([memoryRef]),
      ...overrides,
    });
  }

  test("queued lesson proposal records `distill` and queues the memory for inference", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({ stashDir, distillFn: () => Promise.resolve(distillQueued(memoryRef, "lesson")) });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
    expect(tally.memoryRefsForInference).toEqual([memoryRef]);
  });

  test("promotion to knowledge does NOT queue the memory for inference", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({ stashDir, distillFn: () => Promise.resolve(distillQueued(memoryRef, "knowledge")) });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
    expect(tally.memoryRefsForInference).toEqual([]);
  });

  test("pending proposal for the derived lesson ref short-circuits before the seam", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({
      stashDir,
      primaryStashDir: stashDir,
      pendingProposalRefSet: new Set([deriveLessonRef(memoryRef)]),
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
    expect(tally.actions[0].result).toEqual({ ok: true, reason: "pending proposal exists" });
  });

  test("a fresh proposal rejection opens the D-2 (#370) grace window", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({
      stashDir,
      primaryStashDir: stashDir,
      rejectedProposalsByRef: new Map([
        [deriveLessonRef(memoryRef), { ts: new Date().toISOString() } as EventEnvelope],
      ]),
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
    expect(tally.actions[0].result).toEqual({ ok: true, reason: "distill reject grace window" });
  });

  test("requirePlannedRefs guard skips distill-only refs", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({ stashDir, skipDistillDueToRequirePlannedRefs: true });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
    expect(tally.actions[0].result).toEqual({ ok: true, reason: "require_planned_refs" });
  });

  test("B7: a UsageError from distill is recorded as a validation_failed distill action", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({
      stashDir,
      distillFn: () => Promise.reject(new UsageError("frontmatter invalid")),
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
    expect(tally.actions[0].result).toMatchObject({ ok: false, outcome: "validation_failed" });
  });

  test("a non-Usage error from distill is recorded as a generic error action", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({ stashDir, distillFn: () => Promise.reject(new Error("engine crashed")) });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["error"]);
    expect(tally.actions[0].result).toEqual({ ok: false, error: "engine crashed" });
  });
});

describe("prepareImproveLoopEnv — derived guards", () => {
  // WI-9.10: ImproveRunContext is deleted — ImproveLoopState wraps a RunContext
  // (`ctx`) and keeps `primaryStashDir` as an honest optional (undefined here
  // when the caller sets no stashDir — the no-stash preload-tolerance path,
  // test below: "distillOnlyRefSet mirrors..."). `ctx.stashDir` is REQUIRED by
  // the RunContext contract, so the fixture falls back to "" for it; nothing
  // in these tests reads `ctx.stashDir`.
  function runCtx(overrides: Partial<ImproveLoopState>): ImproveLoopState {
    const stashDir = (overrides.options as { stashDir?: string } | undefined)?.stashDir;
    return {
      ctx: createRunContext({
        stashDir: stashDir ?? "",
        config: {} as AkmConfig,
        eventsCtx: {},
        proposalsCtx: {},
        getLlmConfig: () => null,
        sourceRun: "test-run",
        dryRun: false,
      }),
      primaryStashDir: stashDir,
      scope: { mode: "all" },
      options: { config: {} as AkmConfig },
      reflectFn: () => Promise.reject(new Error("unused")),
      distillFn: () => Promise.reject(new Error("unused")),
      loopRefs: [],
      actions: [],
      signalBearingSet: new Set(),
      distillCooledRefs: new Set(),
      distillOnlyRefs: [],
      recentErrors: {},
      rejectedProposalsByRef: new Map(),
      utilityMap: new Map(),
      startMs: Date.now(),
      budgetMs: 60_000,
      improveProfile: {},
      resolvedPlan: {
        processes: { reflect: { runner: null }, distill: { runner: null } },
      } as unknown as ImproveLoopState["resolvedPlan"],
      ...overrides,
    };
  }

  test("requirePlannedRefs trips only when every loop ref is distill-only", () => {
    const { stashDir } = freshSandbox();
    const profile = {
      processes: { distill: { requirePlannedRefs: true } },
    } as ImproveLoopState["improveProfile"];
    const base = {
      options: { stashDir, config: {} as AkmConfig },
      improveProfile: profile,
      distillOnlyRefs: [eligibleRef("memories/a")],
    };

    const allCooled = prepareImproveLoopEnv(runCtx({ ...base, loopRefs: [eligibleRef("memories/a")] }));
    expect(allCooled.skipDistillDueToRequirePlannedRefs).toBe(true);

    const withReflectEligible = prepareImproveLoopEnv(
      runCtx({ ...base, loopRefs: [eligibleRef("memories/a"), eligibleRef("knowledge/fresh.md")] }),
    );
    expect(withReflectEligible.skipDistillDueToRequirePlannedRefs).toBe(false);

    // Flag unset → guard never trips, even when all refs are distill-only.
    const flagUnset = prepareImproveLoopEnv(
      runCtx({ ...base, improveProfile: {}, loopRefs: [eligibleRef("memories/a")] }),
    );
    expect(flagUnset.skipDistillDueToRequirePlannedRefs).toBe(false);
  });

  test("distillOnlyRefSet mirrors distillOnlyRefs and the proposal preload tolerates a missing stash", () => {
    const env = prepareImproveLoopEnv(
      runCtx({ distillOnlyRefs: [eligibleRef("memories/a"), eligibleRef("memories/b")] }),
    );
    expect([...env.distillOnlyRefSet].sort()).toEqual(["memories/a", "memories/b"]);
    // No stashDir anywhere → the preload never queries and stays empty.
    expect(env.pendingProposalRefSet.size).toBe(0);
  });
});
