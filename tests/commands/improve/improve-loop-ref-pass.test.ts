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
import fs from "node:fs";
import path from "node:path";
import { deriveLessonRef } from "../../../src/commands/improve/distill";
import { deriveKnowledgeRef } from "../../../src/commands/improve/distill-promotion-policy";
import type { AkmImproveOptions, ImproveLoopState } from "../../../src/commands/improve/improve-run-types";
import {
  type ImproveLoopEnv,
  prepareImproveLoopEnv,
  processImproveLoopRef,
} from "../../../src/commands/improve/loop-stages";
import { createRunContext } from "../../../src/commands/improve/run-context";
import {
  archiveProposal,
  createProposal,
  isProposalSkipped,
  type Proposal,
} from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { UsageError } from "../../../src/core/errors";
import { appendEvent, readEvents } from "../../../src/core/events";
import type { EventEnvelope } from "../../../src/core/events-types";
import type { AkmReflectResult, ImproveEligibleRef } from "../../../src/core/improve-types";
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

// Minimal content the canonical lesson validator accepts (description +
// when_to_use) — mint-time proposal fixtures for the distill guard tests.
const VALID_LESSON =
  "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep.\n";

function distillQueued(ref: string, proposalKind: "lesson" | "knowledge") {
  return {
    schemaVersion: 1 as const,
    ok: true,
    outcome: "queued" as const,
    inputRef: ref,
    proposalRef: deriveLessonRef(ref),
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
    ["quality_rejected", "reflect-failed", false],
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
    expect(tally.actions[0]!.result).toEqual({ ok: true, reason: "type-filter" });
    expect(tally.actions[1]!.result).toEqual({ ok: true, reason: "type-filter" });
  });

  test(".derived memory refs skip reflect with the B6 synthetic action", async () => {
    const { stashDir } = freshSandbox();
    const env = makeEnv({ stashDir });

    const tally = await processImproveLoopRef(eligibleRef("memories/note.derived"), env);

    // B6 reflect skip, then the weak-signal distill skip (memory ref, no
    // feedback signal, non-ref scope) — both synthetic, no seam invoked.
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped", "distill-skipped"]);
    expect(tally.actions[0]!.result).toEqual({ ok: true, reason: "derived-memory-reflect-skipped" });
    expect(tally.actions[1]!.result).toEqual({ ok: true, reason: "memory requires recent feedback signal" });
  });
});

describe("processImproveLoopRef — reflect pre-generation guard (R9, tier2-0917)", () => {
  test("a fingerprint match skips the LLM call, lands in reflect-cooldown, and advances the signal cursor", async () => {
    const { stashDir } = freshSandbox();
    const target = { source: "stash", root: path.resolve(stashDir) };
    // A real proposal in state.db for this exact ref/source/target/model —
    // the guard's fingerprint lookup needs something to match against.
    const existing = createProposal(stashDir, {
      ref: "knowledge/guide.md",
      source: "reflect",
      target,
      payload: { content: "---\ndescription: existing\n---\n\nbody\n" },
    });
    if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");

    let reflectCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      options: { stashDir, sourceName: "stash", config: {} as AkmConfig },
      reflectFn: () => {
        reflectCalled = true;
        return Promise.reject(new Error("reflectFn must not be called on a guard hit"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef("knowledge/guide.md"), env);

    expect(reflectCalled).toBe(false);
    expect(tally.actions.map((a) => a.mode)).toEqual(["reflect-cooldown", "distill-skipped"]);
    const reflectAction = tally.actions[0]!.result as AkmReflectResult;
    if (reflectAction.ok) throw new Error("expected a failure envelope");
    expect(reflectAction.reason).toBe("cooldown");

    // buildLatestProposalTsMap (the signal-delta cursor) reads `reflect_invoked`
    // events regardless of outcome — it must still see one for this ref even
    // though reflectFn was never invoked.
    const { events } = readEvents({ type: "reflect_invoked" });
    expect(events.some((e) => e.ref === "knowledge/guide.md")).toBe(true);

    // Fix #3's invariant (observability 0.8.0): every reflect_invoked pairs
    // with a reflect_completed. reflectFn is never called on this path, so
    // reflect.ts's own emitFailed never runs — the guard-skip branch must
    // emit the pairing event itself.
    const { events: completedEvents } = readEvents({ type: "reflect_completed" });
    const completed = completedEvents.find((e) => e.ref === "knowledge/guide.md");
    expect(completed?.metadata).toMatchObject({
      source: "reflect",
      ok: false,
      reason: "cooldown",
      subreason: "pre_generation_guard",
    });
  });

  test("no guard hit falls through to the real reflectFn call as before", async () => {
    const { stashDir } = freshSandbox();
    let reflectCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      options: { stashDir, sourceName: "stash", config: {} as AkmConfig },
      reflectFn: (args) => {
        reflectCalled = true;
        return Promise.resolve(reflectOk(args.ref ?? "knowledge/guide.md"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef("knowledge/guide.md"), env);

    expect(reflectCalled).toBe(true);
    expect(tally.actions.map((a) => a.mode)).toEqual(["reflect", "distill-skipped"]);
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
    expect(tally.actions[0]!.result).toEqual({ ok: true, reason: "pending proposal exists" });
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
    expect(tally.actions[0]!.result).toEqual({ ok: true, reason: "distill reject grace window" });
  });

  test("requirePlannedRefs guard skips distill-only refs", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({ stashDir, skipDistillDueToRequirePlannedRefs: true });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
    expect(tally.actions[0]!.result).toEqual({ ok: true, reason: "require_planned_refs" });
  });

  test("B7: a UsageError from distill is recorded as a validation_failed distill action", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({
      stashDir,
      distillFn: () => Promise.reject(new UsageError("frontmatter invalid")),
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
    expect(tally.actions[0]!.result).toMatchObject({ ok: false, outcome: "validation_failed" });
  });

  test("a non-Usage error from distill is recorded as a generic error action", async () => {
    const { stashDir } = freshSandbox();
    const env = distillOnlyEnv({ stashDir, distillFn: () => Promise.reject(new Error("engine crashed")) });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(tally.actions.map((a) => a.mode)).toEqual(["error"]);
    expect(tally.actions[0]!.result).toEqual({ ok: false, error: "engine crashed" });
  });
});

describe("processImproveLoopRef — distill pre-generation guard (r2-6, tier2-0917)", () => {
  const memoryRef = "memories/finding-1";

  test("a fingerprint match on the derived lesson ref skips distillFn and advances the signal cursor", async () => {
    const { stashDir } = freshSandbox();
    const lessonRef = deriveLessonRef(memoryRef);
    // A real proposal in state.db for this exact derived ref/source/model —
    // the guard's fingerprint lookup needs something to match against.
    const existing = createProposal(stashDir, {
      ref: lessonRef,
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([memoryRef]),
      signalBearingSet: new Set([memoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.reject(new Error("distillFn must not be called on a guard hit"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(distillCalled).toBe(false);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
    expect(tally.actions[0]!.result).toMatchObject({ ok: true, reason: "fingerprint_match" });

    // buildLatestProposalTsMap (the signal-delta cursor, eligibility.ts)
    // reads `distill_invoked` events with a queued/skipped/validation_failed
    // outcome — it must still see one for this ref even though distillFn was
    // never invoked.
    const { events } = readEvents({ type: "distill_invoked" });
    const skipEvent = events.find((e) => e.ref === memoryRef);
    expect(skipEvent?.metadata).toMatchObject({ outcome: "skipped", skipReason: "fingerprint_match" });
  });

  test("a rejection-backoff hit on the derived lesson ref skips distillFn likewise", async () => {
    const { stashDir } = freshSandbox();
    const lessonRef = deriveLessonRef(memoryRef);
    const first = createProposal(stashDir, {
      ref: lessonRef,
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(first)) throw new Error("unexpected skip setting up the fixture");
    archiveProposal(stashDir, first.id, "rejected", "Test rejection for r2-6 backoff");

    // Materialize the target so the second check is a genuinely new
    // fingerprint — the retained backoff (not the fingerprint guard) must be
    // what fires, mirroring proposals.test.ts's rejection_backoff coverage.
    fs.mkdirSync(path.join(stashDir, "lessons"), { recursive: true });
    fs.writeFileSync(
      path.join(stashDir, "lessons", `${lessonRef.split("/")[1]}.md`),
      "On-disk target content.\n",
      "utf8",
    );

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([memoryRef]),
      signalBearingSet: new Set([memoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.reject(new Error("distillFn must not be called on a guard hit"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(distillCalled).toBe(false);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
    expect(tally.actions[0]!.result).toMatchObject({ ok: true, reason: "rejection_backoff" });
  });

  test("an existing proposal from a different source does not block distill — dispatches normally", async () => {
    const { stashDir } = freshSandbox();
    const lessonRef = deriveLessonRef(memoryRef);
    // A proposal already exists for the same derived ref, but minted by
    // "reflect" — cross-source independence (proposals.test.ts) means the
    // distill guard must not fire against it.
    const existing = createProposal(stashDir, {
      ref: lessonRef,
      source: "reflect",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([memoryRef]),
      signalBearingSet: new Set([memoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.resolve(distillQueued(memoryRef, "lesson"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(distillCalled).toBe(true);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
  });
});

describe("processImproveLoopRef — distill guard target precheck (PRECHECK, tier3-0917)", () => {
  const memoryRef = "memories/finding-1";
  const promotingMemoryRef = "memories/vpn-required-for-deploy";
  // Mirrors the "deploy-vpn-required" fixture in promotion-policy-corpus.ts
  // (verified to promote by distill-promotion-policy.test.ts): substantive
  // body, curated-looking frontmatter, and two reinforcing positive feedback
  // events push `assessMemoryKnowledgePromotionCandidate` — the same
  // deterministic heuristic distill.ts dispatches with — over the promotion
  // threshold, so distill's real target is the derived KNOWLEDGE ref, not
  // the lesson ref.
  const PROMOTING_MEMORY_CONTENT = [
    "---",
    "description: VPN required before deploy",
    "source: skill:deploy",
    "observed_at: 2026-04-20",
    "confidence: 0.95",
    "tags: [deploy, ops]",
    "---",
    "",
    "Always connect the VPN before starting production deploys.",
    "",
  ].join("\n");

  function seedPromotingMemory(stashDir: string, ref: string): void {
    fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "memories", `${ref.split("/")[1]}.md`), PROMOTING_MEMORY_CONTENT, "utf8");
    appendEvent({ eventType: "feedback", ref, metadata: { signal: "positive" } });
    appendEvent({ eventType: "feedback", ref, metadata: { signal: "positive" } });
  }

  test("knowledge ref guarded, distill would target the lesson (no promotion candidate) → dispatch happens", async () => {
    const { stashDir } = freshSandbox();
    // No memory file on disk for `memoryRef` — assessMemoryKnowledgePromotionCandidate
    // reports "missing-asset-content" and never promotes, so the real target
    // is always the derived lesson ref. Guard only the (irrelevant) knowledge ref.
    const knowledgeRef = deriveKnowledgeRef(memoryRef);
    const existing = createProposal(stashDir, {
      ref: knowledgeRef,
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([memoryRef]),
      signalBearingSet: new Set([memoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.resolve(distillQueued(memoryRef, "lesson"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(memoryRef), env);

    expect(distillCalled).toBe(true);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
  });

  test("the real target (knowledge ref) guarded for a promoting memory → skip with the paired distill_invoked event", async () => {
    const { stashDir } = freshSandbox();
    seedPromotingMemory(stashDir, promotingMemoryRef);
    const knowledgeRef = deriveKnowledgeRef(promotingMemoryRef);
    const existing = createProposal(stashDir, {
      ref: knowledgeRef,
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([promotingMemoryRef]),
      signalBearingSet: new Set([promotingMemoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.reject(new Error("distillFn must not be called on a guard hit"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(promotingMemoryRef), env);

    expect(distillCalled).toBe(false);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);

    const { events } = readEvents({ type: "distill_invoked" });
    const skipEvent = events.find((e) => e.ref === promotingMemoryRef);
    expect(skipEvent?.metadata).toMatchObject({ outcome: "skipped", proposalRef: knowledgeRef });
  });

  test("lesson ref guarded but a promoting memory's real target is knowledge → dispatch happens", async () => {
    const { stashDir } = freshSandbox();
    seedPromotingMemory(stashDir, promotingMemoryRef);
    const lessonRef = deriveLessonRef(promotingMemoryRef);
    const existing = createProposal(stashDir, {
      ref: lessonRef,
      source: "distill",
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([promotingMemoryRef]),
      signalBearingSet: new Set([promotingMemoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.resolve(distillQueued(promotingMemoryRef, "knowledge"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(promotingMemoryRef), env);

    expect(distillCalled).toBe(true);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill"]);
  });

  test("both the lesson and knowledge refs guarded for a promoting memory → skip", async () => {
    const { stashDir } = freshSandbox();
    seedPromotingMemory(stashDir, promotingMemoryRef);
    for (const ref of [deriveLessonRef(promotingMemoryRef), deriveKnowledgeRef(promotingMemoryRef)]) {
      const existing = createProposal(stashDir, { ref, source: "distill", payload: { content: VALID_LESSON } });
      if (isProposalSkipped(existing)) throw new Error("unexpected skip setting up the fixture");
    }

    let distillCalled = false;
    const env = makeEnv({
      stashDir,
      primaryStashDir: stashDir,
      distillOnlyRefSet: new Set([promotingMemoryRef]),
      signalBearingSet: new Set([promotingMemoryRef]),
      distillFn: () => {
        distillCalled = true;
        return Promise.reject(new Error("distillFn must not be called on a guard hit"));
      },
    });

    const tally = await processImproveLoopRef(eligibleRef(promotingMemoryRef), env);

    expect(distillCalled).toBe(false);
    expect(tally.actions.map((a) => a.mode)).toEqual(["distill-skipped"]);
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
