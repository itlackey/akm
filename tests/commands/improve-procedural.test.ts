// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #615 — procedural-compilation pass (src/commands/improve/procedural.ts).
 *
 * The procedural pass is an OPT-IN post-loop improve stage (default disabled
 * by the built-in default strategy). It reads assets that carry an
 * `orderedActions` frontmatter list (captured by #619), detects RECURRING
 * successful action sequences across sessions (the SAME normalized ordered
 * step list appearing >= `minRecurrence` times with a non-failure
 * `outcomeData`), and emits ONE normal `type: workflow` proposal per recurring
 * sequence through the existing proposal queue + quality gate.
 *
 * Contract under test (the procedural API surface):
 *   - `akmProcedural(opts)` from `src/commands/improve/procedural.ts` returns a
 *     `ProceduralCompilationResult` and accepts an injected `proceduralLlmFn`
 *     seam (no real network).
 *   - `normalizeSequence(actions)` is exported and normalizes case / whitespace
 *     / trailing punctuation, order-sensitively.
 *   - `resolveProcessEnabled("procedural", profile)` is `false` by default.
 *   - `akmImprove({ proceduralFn, ... })` wires the pass in only when enabled
 *     (and not for ref-scope / dry-run) and attaches the result to
 *     `result.proceduralCompilation`.
 *
 * All tests use sandbox helpers, inject the LLM seam, and never touch real host
 * state — mirroring tests/commands/improve-recombine.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../src/commands/improve/distill";
import { akmImprove } from "../../src/commands/improve/improve";
import { resolveImproveStrategy, resolveProcessEnabled } from "../../src/commands/improve/improve-strategies";
// Imported from the module under test (now shipped).
import { akmProcedural, normalizeSequence } from "../../src/commands/improve/procedural";
import type { AkmReflectResult } from "../../src/commands/improve/reflect";
import { listProposals } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { saveConfig } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import { akmIndex } from "../../src/indexer/indexer";
import { parseWorkflow } from "../../src/workflows/parser";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const TIMEOUT_MS = 20_000;
const cleanups: Array<() => void> = [];

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

/**
 * Write an asset (default a memory) whose frontmatter carries an
 * `orderedActions` list and an `outcomeData` string — the #619 capture shape
 * the procedural pass reads back at run time via parseFrontmatter(raw).data.
 */
function writeOrderedActionsAsset(
  stashDir: string,
  opts: {
    name: string;
    type?: "memories" | "lessons" | "knowledge";
    orderedActions: string[];
    outcomeData?: string;
    body?: string;
  },
): void {
  const type = opts.type ?? "memories";
  const filePath = path.join(stashDir, type, `${opts.name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const actionsYaml = opts.orderedActions.map((a) => `  - ${JSON.stringify(a)}`).join("\n");
  const outcomeYaml = opts.outcomeData !== undefined ? `outcomeData: ${JSON.stringify(opts.outcomeData)}\n` : "";
  const fm = `---\ndescription: ${opts.name}\norderedActions:\n${actionsYaml}\n${outcomeYaml}---\n`;
  fs.writeFileSync(filePath, `${fm}\n${opts.body ?? `Body for ${opts.name}.`}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

/** A successful three-step deploy sequence shared across assets. */
const DEPLOY_SEQUENCE = ["Run tests", "Build the bundle", "Run deploy.sh"];

/** A valid workflow doc as the procedural LLM would return it for DEPLOY_SEQUENCE. */
function deployWorkflowJson(): string {
  return JSON.stringify({
    title: "Deploy Release",
    description: "Test, build, and deploy the application in a repeatable sequence.",
    steps: [
      { title: "Run tests", instructions: "Execute the full test suite and confirm it is green." },
      { title: "Build the bundle", instructions: "Produce the production build artifact." },
      { title: "Run deploy.sh", instructions: "Invoke the deploy script to ship the build." },
    ],
  });
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
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
  engine: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

/** Improve config with procedural enabled (and noisy passes silenced). */
function proceduralEnabledConfig(overrides?: Record<string, unknown>): AkmConfig {
  return {
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            procedural: { enabled: true, minRecurrence: 3, maxProposalsPerRun: 3, ...(overrides ?? {}) },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── Normalization (unit) ────────────────────────────────────────────────────────

describe("procedural — normalizeSequence (unit)", () => {
  test("case / whitespace / trailing-punctuation insensitive", () => {
    const a = normalizeSequence(["Run deploy.sh", "  Build  the   bundle "]);
    const b = normalizeSequence(["run deploy.sh ", "build the bundle"]);
    expect(a).toEqual(b);
  });

  test("grouping is order-sensitive: reordered steps do NOT match", () => {
    const a = normalizeSequence(["Run tests", "Run deploy.sh"]);
    const b = normalizeSequence(["Run deploy.sh", "Run tests"]);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  test("empty steps are dropped", () => {
    const out = normalizeSequence(["Run tests", "   ", "", "Run deploy.sh"]);
    expect(out).toEqual(["run tests", "run deploy.sh"]);
  });
});

// ── AC3: opt-in gating ────────────────────────────────────────────────────────

describe("procedural — opt-in default (AC3)", () => {
  test("resolveProcessEnabled('procedural', defaultProfile) === false", () => {
    const profile = resolveImproveStrategy("default", { semanticSearchMode: "off" } as AkmConfig).config;
    expect(resolveProcessEnabled("procedural", profile)).toBe(false);
  });

  test(
    "default profile with no procedural config does NOT run the pass (AC3a)",
    async () => {
      const stash = isolatedStash();
      for (const n of ["d1", "d2", "d3"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "deploy succeeded" });
      }
      await buildIndex(stash);

      let proceduralInvoked = false;
      const res = await akmImprove({
        scope: "memory",
        stashDir: stash,
        ...noopIndexFns,
        reflectFn: async ({ ref }) => okReflect(ref ?? ""),
        distillFn: async ({ ref }) => okDistill(ref ?? ""),
        proceduralFn: async () => {
          proceduralInvoked = true;
          return {
            schemaVersion: 1,
            ok: true,
            sequencesScanned: 0,
            clustersFormed: 0,
            proposalsEmitted: 0,
            nullsReturned: 0,
            durationMs: 0,
            warnings: [],
          };
        },
      });

      expect(proceduralInvoked).toBe(false);
      expect(res.proceduralCompilation).toBeUndefined();
      const { events } = readEvents({ type: "procedural_compiled" });
      expect(events.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "enabling processes.procedural.enabled runs the pass and attaches the result (AC3b)",
    async () => {
      const stash = isolatedStash();
      for (const n of ["d1", "d2", "d3"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "deploy succeeded" });
      }
      await buildIndex(stash);

      let proceduralInvoked = false;
      const res = await akmImprove({
        scope: "memory",
        stashDir: stash,
        config: proceduralEnabledConfig(),
        ...noopIndexFns,
        reflectFn: async ({ ref }) => okReflect(ref ?? ""),
        distillFn: async ({ ref }) => okDistill(ref ?? ""),
        proceduralFn: async () => {
          proceduralInvoked = true;
          return {
            schemaVersion: 1,
            ok: true,
            sequencesScanned: 3,
            clustersFormed: 1,
            proposalsEmitted: 1,
            nullsReturned: 0,
            durationMs: 1,
            warnings: [],
          };
        },
      });

      expect(proceduralInvoked).toBe(true);
      expect(res.proceduralCompilation).toBeDefined();
      expect(res.proceduralCompilation?.proposalsEmitted).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "skipped for ref-scope and dry-run even when enabled (AC3b)",
    async () => {
      const stash = isolatedStash();
      writeOrderedActionsAsset(stash, { name: "d1", orderedActions: DEPLOY_SEQUENCE, outcomeData: "ok" });
      await buildIndex(stash);

      // dry-run
      let dryInvoked = false;
      const dry = await akmImprove({
        scope: "memory",
        stashDir: stash,
        config: proceduralEnabledConfig(),
        dryRun: true,
        ...noopIndexFns,
        reflectFn: async ({ ref }) => okReflect(ref ?? ""),
        distillFn: async ({ ref }) => okDistill(ref ?? ""),
        proceduralFn: async () => {
          dryInvoked = true;
          return {
            schemaVersion: 1,
            ok: true,
            sequencesScanned: 0,
            clustersFormed: 0,
            proposalsEmitted: 0,
            nullsReturned: 0,
            durationMs: 0,
            warnings: [],
          };
        },
      });
      expect(dryInvoked).toBe(false);
      expect(dry.proceduralCompilation).toBeUndefined();

      // ref-scope
      let refInvoked = false;
      const refRes = await akmImprove({
        scope: "memory:d1",
        stashDir: stash,
        config: proceduralEnabledConfig(),
        ...noopIndexFns,
        reflectFn: async ({ ref }) => okReflect(ref ?? ""),
        distillFn: async ({ ref }) => okDistill(ref ?? ""),
        proceduralFn: async () => {
          refInvoked = true;
          return {
            schemaVersion: 1,
            ok: true,
            sequencesScanned: 0,
            clustersFormed: 0,
            proposalsEmitted: 0,
            nullsReturned: 0,
            durationMs: 0,
            warnings: [],
          };
        },
      });
      expect(refInvoked).toBe(false);
      expect(refRes.proceduralCompilation).toBeUndefined();
    },
    TIMEOUT_MS,
  );
});

// ── AC1: recurring success → ONE workflow proposal ──────────────────────────────

describe("procedural — single workflow-proposal emission (AC1)", () => {
  test(
    "N>=minRecurrence successful assets sharing a sequence produce exactly ONE workflow proposal",
    async () => {
      const stash = isolatedStash();
      for (const n of ["s1", "s2", "s3"]) {
        writeOrderedActionsAsset(stash, {
          name: n,
          orderedActions: DEPLOY_SEQUENCE,
          outcomeData: "deploy succeeded cleanly",
        });
      }
      await buildIndex(stash);

      let calls = 0;
      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-ac1",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        proceduralLlmFn: async () => {
          calls += 1;
          return deployWorkflowJson();
        },
      });

      expect(calls).toBe(1);
      expect(res.proposalsEmitted).toBe(1);

      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(1);

      const proposal = pending[0];
      expect(proposal.ref.startsWith("workflow:")).toBe(true);

      // The emitted body must be a VALID workflow asset with one step per action.
      const body = proposal.payload.content ?? "";
      const parsed = parseWorkflow(body, { path: proposal.ref });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.document.steps.length).toBe(DEPLOY_SEQUENCE.length);
        for (const step of parsed.document.steps) {
          expect(step.title.length).toBeGreaterThan(0);
          expect(step.instructions?.text.length ?? 0).toBeGreaterThan(0);
        }
        // AC1 "ordered steps": the emitted step titles must appear in the SAME
        // order as the source action sequence — not merely the right count. A
        // regression that scrambled step order while preserving count/shape
        // would otherwise pass green.
        expect(parsed.document.steps.map((step) => step.title)).toEqual(DEPLOY_SEQUENCE);
      }

      // One queued event.
      const { events } = readEvents({ type: "procedural_compiled" });
      expect(events.some((e) => (e.metadata as { outcome?: string }).outcome === "queued")).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "idempotent re-run emits 0 new proposals + a skipped event (AC1b)",
    async () => {
      const stash = isolatedStash();
      for (const n of ["s1", "s2", "s3"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "succeeded" });
      }
      await buildIndex(stash);

      const run = () =>
        akmProcedural({
          stashDir: stash,
          config: proceduralEnabledConfig(),
          sourceRun: "run-idem",
          minRecurrence: 3,
          maxProposalsPerRun: 3,
          proceduralLlmFn: async () => deployWorkflowJson(),
        });

      const first = await run();
      expect(first.proposalsEmitted).toBe(1);

      const second = await run();
      expect(second.proposalsEmitted).toBe(0);

      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(1);

      const { events } = readEvents({ type: "procedural_compiled" });
      expect(events.some((e) => (e.metadata as { outcome?: string }).outcome === "skipped")).toBe(true);
      expect(events.some((e) => (e.metadata as { skipReason?: string }).skipReason !== undefined)).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// ── AC2: thresholds / success filtering / one-off rejection ─────────────────────

describe("procedural — recurrence + success gating (AC2)", () => {
  test(
    "below threshold → nothing, and ZERO LLM calls (AC2a)",
    async () => {
      const stash = isolatedStash();
      // minRecurrence-1 = 2 assets only.
      for (const n of ["s1", "s2"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "succeeded" });
      }
      await buildIndex(stash);

      let calls = 0;
      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-below",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        proceduralLlmFn: async () => {
          calls += 1;
          return deployWorkflowJson();
        },
      });

      expect(calls).toBe(0);
      expect(res.proposalsEmitted).toBe(0);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "failed/absent outcomeData does NOT count toward recurrence (AC2b)",
    async () => {
      const stash = isolatedStash();
      // 3 assets share the sequence but each carries a failure / empty outcome.
      writeOrderedActionsAsset(stash, { name: "f1", orderedActions: DEPLOY_SEQUENCE, outcomeData: "deploy failed" });
      writeOrderedActionsAsset(stash, { name: "f2", orderedActions: DEPLOY_SEQUENCE, outcomeData: "error: rollback" });
      writeOrderedActionsAsset(stash, { name: "f3", orderedActions: DEPLOY_SEQUENCE }); // no outcomeData
      await buildIndex(stash);

      let calls = 0;
      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-fail",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        proceduralLlmFn: async () => {
          calls += 1;
          return deployWorkflowJson();
        },
      });

      expect(calls).toBe(0);
      expect(res.proposalsEmitted).toBe(0);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "one-off distinct sequences never reach threshold (AC2c)",
    async () => {
      const stash = isolatedStash();
      writeOrderedActionsAsset(stash, {
        name: "u1",
        orderedActions: ["Run tests", "Build the bundle", "Run deploy.sh"],
        outcomeData: "ok",
      });
      writeOrderedActionsAsset(stash, {
        name: "u2",
        orderedActions: ["Lint code", "Open a PR", "Request review"],
        outcomeData: "ok",
      });
      writeOrderedActionsAsset(stash, {
        name: "u3",
        orderedActions: ["Write migration", "Apply migration", "Verify schema"],
        outcomeData: "ok",
      });
      await buildIndex(stash);

      let calls = 0;
      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-oneoff",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        proceduralLlmFn: async () => {
          calls += 1;
          return deployWorkflowJson();
        },
      });

      expect(calls).toBe(0);
      expect(res.clustersFormed).toBe(0);
      expect(res.proposalsEmitted).toBe(0);
    },
    TIMEOUT_MS,
  );
});

// ── Quality gate (never bypassed) ───────────────────────────────────────────────

describe("procedural — quality gate + null path", () => {
  test(
    "a workflow whose description fails the quality gate is NOT queued (quality_rejected)",
    async () => {
      const stash = isolatedStash();
      for (const n of ["s1", "s2", "s3"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "succeeded" });
      }
      await buildIndex(stash);

      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-badgate",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        // Empty description fails validateProposalFrontmatter.
        proceduralLlmFn: async () =>
          JSON.stringify({
            title: "Deploy Release",
            description: "",
            steps: [
              { title: "Run tests", instructions: "Run the tests." },
              { title: "Build the bundle", instructions: "Build it." },
              { title: "Run deploy.sh", instructions: "Deploy it." },
            ],
          }),
      });

      expect(res.proposalsEmitted).toBe(0);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(0);

      const { events } = readEvents({ type: "procedural_compiled" });
      expect(events.some((e) => (e.metadata as { outcome?: string }).outcome === "quality_rejected")).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "explicit null from the LLM yields 0 proposals + null_returned event",
    async () => {
      const stash = isolatedStash();
      for (const n of ["s1", "s2", "s3"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "succeeded" });
      }
      await buildIndex(stash);

      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-null",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        proceduralLlmFn: async () => "null",
      });

      expect(res.proposalsEmitted).toBe(0);
      expect(res.nullsReturned).toBeGreaterThanOrEqual(1);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(0);

      const { events } = readEvents({ type: "procedural_compiled" });
      expect(events.some((e) => (e.metadata as { outcome?: string }).outcome === "null_returned")).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// ── Budget / abort handling ─────────────────────────────────────────────────────

describe("procedural — budget/abort", () => {
  test(
    "an already-aborted AbortSignal short-circuits: no LLM calls, ok:false",
    async () => {
      const stash = isolatedStash();
      for (const n of ["s1", "s2", "s3"]) {
        writeOrderedActionsAsset(stash, { name: n, orderedActions: DEPLOY_SEQUENCE, outcomeData: "succeeded" });
      }
      await buildIndex(stash);

      const controller = new AbortController();
      controller.abort();

      let calls = 0;
      const res = await akmProcedural({
        stashDir: stash,
        config: proceduralEnabledConfig(),
        sourceRun: "run-abort",
        minRecurrence: 3,
        maxProposalsPerRun: 3,
        signal: controller.signal,
        proceduralLlmFn: async () => {
          calls += 1;
          return deployWorkflowJson();
        },
      });

      expect(calls).toBe(0);
      expect(res.ok).toBe(false);
      expect(res.proposalsEmitted).toBe(0);
      expect(res.schemaVersion).toBe(1);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "procedural");
      expect(pending.length).toBe(0);
    },
    TIMEOUT_MS,
  );
});
