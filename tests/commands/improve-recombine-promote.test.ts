// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #625 — recombine SECOND-PASS promotion (RED — feature not yet implemented).
 *
 * The first pass (#609, tests/commands/improve-recombine.test.ts) only ever
 * emits `type: hypothesis` proposals. This second pass tracks how many
 * CONSECUTIVE runs re-induce the SAME generalization (keyed by the deterministic
 * `deriveRecombineLessonRef` value) in a NEW state.db table
 * (`recombine_hypotheses`, migration 014). Once the confirmation count reaches
 * `processes.recombine.confirmThreshold`, the run promotes the generalization to
 * a `type: lesson` proposal — emitted through the SAME proposal queue + quality
 * gate (createProposal + validateProposalFrontmatter), NEVER a direct stash
 * write. Hypotheses NOT re-induced in a run have their consecutive streak reset
 * (decay-to-zero), so confirmation is per exact member-set and conservative.
 *
 * Contract under test (the planned API surface — these behaviours do NOT exist
 * yet, so every promotion assertion here is expected to FAIL until the feature
 * lands):
 *   - `akmRecombine(opts)` accepts `confirmThreshold?: number` (default 2) and
 *     threads it from `improveProfile.processes.recombine.confirmThreshold`.
 *   - `RecombineResult` gains a `lessonsPromoted: number` counter.
 *   - Per-run it increments a `recombine_hypotheses` row (count) for every
 *     cluster that produced a defensible generalization, decays unseen rows,
 *     and on count>=threshold emits ONE `type: lesson` promotion proposal.
 *
 * All tests use sandbox helpers, inject the LLM seam (no real network), share a
 * single isolated state.db (the sandbox pins XDG_DATA_HOME / XDG_STATE_HOME so
 * getStateDbPath resolves there) across simulated runs, and never touch host
 * state. UNIT-tier: no Bun.spawn / Bun.serve / 60s timeout, so this file stays
 * in tests/ (not tests/integration/).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmRecombine } from "../../src/commands/improve/recombine";
import { listProposals } from "../../src/commands/proposal/validators/proposals";
import type { AkmConfig } from "../../src/core/config/config";
import { saveConfig } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
// NOTE: getRecombineHypothesis does not exist yet — the RED import is intentional.
import { getRecombineHypothesis, openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const TIMEOUT_MS = 20_000;
const cleanups: Array<() => void> = [];

function isolated(): IsolatedAkmStorage {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso;
}

/** Write a memory file with explicit frontmatter tags + a body. */
function writeMemory(stashDir: string, name: string, tags: string[], body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tagsYaml = tags.length ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n` : "";
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n${tagsYaml}---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

/** A generalization payload as the recombine LLM would return it. */
function generalization(description: string, body: string): string {
  return JSON.stringify({ description, when_to_use: "when working on this topic", body });
}

const GOOD_GENERALIZATION = () =>
  generalization(
    "Authentication state is short-lived and continuously re-verified across flows.",
    "A well-formed generalization body that says something none of the inputs states alone.",
  );

/** Improve config with recombine enabled at a chosen confirmThreshold. */
function promoteConfig(confirmThreshold: number, overrides?: Record<string, unknown>): AkmConfig {
  return {
    semanticSearchMode: "off",
    profiles: {
      improve: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            recombine: {
              enabled: true,
              relatednessSource: "tags",
              minClusterSize: 3,
              confirmThreshold,
              ...(overrides ?? {}),
            },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

/** Seed the canonical auth trio that forms exactly one tag:auth cluster. */
function seedAuthTrio(stashDir: string): void {
  writeMemory(stashDir, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
  writeMemory(stashDir, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
  writeMemory(stashDir, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
}

function stateDbPath(iso: IsolatedAkmStorage): string {
  // getStateDbPath() resolves to `<XDG_DATA_HOME>/akm/state.db` (getDataDir
  // appends the `akm/` namespace), which is where akmRecombine — invoked here
  // without a ctx — writes the confirmation ledger.
  return path.join(iso.dataDir, "akm", "state.db");
}

/** All pending recombine proposals carrying frontmatter `type: <type>`. */
function pendingByType(stashDir: string, type: "hypothesis" | "lesson"): ReturnType<typeof listProposals> {
  return listProposals(stashDir, { status: "pending" }).filter(
    (p) => p.source === "recombine" && (p.payload.content ?? "").includes(`type: ${type}`),
  );
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── AC1: promotion at threshold ────────────────────────────────────────────────

describe("recombine promotion — at threshold (AC1)", () => {
  test(
    "confirmThreshold:2 — run1 emits hypothesis (count=1), run2 promotes to a type:lesson proposal",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const config = promoteConfig(2);
      const llmFn = async () => GOOD_GENERALIZATION();

      // RUN 1 — first induction. Count reaches 1 (< 2): hypothesis only.
      const res1 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });

      expect(res1.lessonsPromoted).toBe(0);
      expect(pendingByType(stash, "hypothesis").length).toBe(1);
      expect(pendingByType(stash, "lesson").length).toBe(0);

      // The state.db confirmation row exists with count=1, keyed by the lesson ref.
      const ref = pendingByType(stash, "hypothesis")[0].ref;
      expect(ref.startsWith("lesson:")).toBe(true);
      const db1 = openStateDatabase(stateDbPath(iso));
      const row1 = getRecombineHypothesis(db1, ref);
      db1.close();
      expect(row1?.consecutive_count).toBe(1);
      expect(row1?.promoted_at ?? null).toBeNull();

      // RUN 2 — re-induction. Count reaches 2 (>= 2): promote to a lesson.
      const res2 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-2",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });

      expect(res2.lessonsPromoted).toBe(1);

      // The promotion went THROUGH the queue: exactly one pending type:lesson
      // proposal for this ref, source 'recombine', status 'pending'.
      const lessons = pendingByType(stash, "lesson");
      expect(lessons.length).toBe(1);
      expect(lessons[0].ref).toBe(ref);
      expect(lessons[0].ref.startsWith("lesson:")).toBe(true);
      expect(lessons[0].source).toBe("recombine");
      expect(lessons[0].status).toBe("pending");

      // No lesson file was written directly to the stash (queue, not direct write).
      const lessonsDir = path.join(stash, "lessons");
      const writtenLessons = fs.existsSync(lessonsDir) ? fs.readdirSync(lessonsDir) : [];
      expect(writtenLessons.length).toBe(0);

      // The row is now marked promoted and its count reset.
      const db2 = openStateDatabase(stateDbPath(iso));
      const row2 = getRecombineHypothesis(db2, ref);
      db2.close();
      expect(row2?.promoted_at ?? null).not.toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "post-promotion run3 does NOT re-promote (promoted_at guard against double-promotion)",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const config = promoteConfig(2);
      const llmFn = async () => GOOD_GENERALIZATION();

      await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });
      const res2 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-2",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });
      expect(res2.lessonsPromoted).toBe(1);

      // RUN 3 — already promoted: no new lesson proposal, counter stays 0.
      const res3 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-3",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });
      expect(res3.lessonsPromoted).toBe(0);
      expect(pendingByType(stash, "lesson").length).toBe(1);
    },
    TIMEOUT_MS,
  );
});

// ── AC1b: gate not bypassed on the promotion path ───────────────────────────────

describe("recombine promotion — quality gate on promote (AC1b)", () => {
  test(
    "an empty-description generalization at the promoting run is REJECTED (no lesson, quality_rejected)",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const config = promoteConfig(2);

      // RUN 1 — valid generalization → count=1, hypothesis emitted.
      await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: async () => GOOD_GENERALIZATION(),
      });

      // RUN 2 — would promote, but the generalization now has an EMPTY description.
      // validateProposalFrontmatter must run BEFORE createProposal on the promotion
      // path, so nothing is promoted and no lesson proposal lands.
      const res2 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-2",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: async () => generalization("", "Body without a description."),
      });

      expect(res2.lessonsPromoted).toBe(0);
      expect(pendingByType(stash, "lesson").length).toBe(0);

      const { events } = readEvents({ type: "recombine_invoked" });
      expect(events.some((e) => (e.metadata as { outcome?: string }).outcome === "quality_rejected")).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// ── AC2: below threshold never promotes ─────────────────────────────────────────

describe("recombine promotion — below threshold (AC2)", () => {
  test(
    "confirmThreshold:3 — two runs reach count=2 (< 3): only hypothesis proposals, never a lesson",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const config = promoteConfig(3);
      const llmFn = async () => GOOD_GENERALIZATION();

      const res1 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 3,
        recombineLlmFn: llmFn,
      });
      const res2 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-2",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 3,
        recombineLlmFn: llmFn,
      });

      expect(res1.lessonsPromoted).toBe(0);
      expect(res2.lessonsPromoted).toBe(0);
      expect(pendingByType(stash, "lesson").length).toBe(0);

      // Every emitted recombine proposal is type:hypothesis.
      const all = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all.every((p) => (p.payload.content ?? "").includes("type: hypothesis"))).toBe(true);

      const ref = pendingByType(stash, "hypothesis")[0].ref;
      const db = openStateDatabase(stateDbPath(iso));
      const row = getRecombineHypothesis(db, ref);
      db.close();
      expect(row?.consecutive_count).toBe(2);
      expect(row?.promoted_at ?? null).toBeNull();
    },
    TIMEOUT_MS,
  );
});

// ── AC3: confirmThreshold governs the boundary + first-pass unchanged ────────────

describe("recombine promotion — threshold boundary (AC3)", () => {
  test(
    "confirmThreshold:1 — the single run that records count=1 promotes immediately",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const res = await akmRecombine({
        stashDir: stash,
        config: promoteConfig(1),
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 1,
        recombineLlmFn: async () => GOOD_GENERALIZATION(),
      });

      expect(res.lessonsPromoted).toBe(1);
      expect(pendingByType(stash, "lesson").length).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "confirmThreshold:2 — the single run that records count=1 does NOT promote",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const res = await akmRecombine({
        stashDir: stash,
        config: promoteConfig(2),
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: async () => GOOD_GENERALIZATION(),
      });

      expect(res.lessonsPromoted).toBe(0);
      expect(pendingByType(stash, "lesson").length).toBe(0);
      expect(pendingByType(stash, "hypothesis").length).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "regression: with promotion disabled (threshold:99) the pre-#625 hypothesis-only behavior is byte-identical",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      seedAuthTrio(stash);
      await buildIndex(stash);

      const res = await akmRecombine({
        stashDir: stash,
        config: promoteConfig(99),
        sourceRun: "run-regress",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 99,
        recombineLlmFn: async () =>
          generalization("Auth artifacts are ephemeral.", "Generalization body none of the inputs states alone."),
      });

      // First-pass invariants unchanged: exactly one type:hypothesis proposal,
      // zero lessons, no promotion.
      expect(res.proposalsEmitted).toBe(1);
      expect(res.lessonsPromoted).toBe(0);
      const hyp = pendingByType(stash, "hypothesis");
      expect(hyp.length).toBe(1);
      expect((hyp[0].payload.content ?? "").includes("type: lesson")).toBe(false);
      expect(hyp[0].ref.startsWith("lesson:")).toBe(true);
      expect(pendingByType(stash, "lesson").length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "regression: justified-null + min-cluster gate still hold under the promotion-capable code path",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      // A 2-member tag group (below minClusterSize:3) must NOT cluster.
      writeMemory(stash, "pair-a", ["billing"], "Invoices are generated on the first of the month.");
      writeMemory(stash, "pair-b", ["billing"], "Refunds post within five business days.");
      // The auth trio clusters, but the LLM returns an explicit null.
      seedAuthTrio(stash);
      await buildIndex(stash);

      let calls = 0;
      const res = await akmRecombine({
        stashDir: stash,
        config: promoteConfig(2),
        sourceRun: "run-null",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: async () => {
          calls += 1;
          return "null";
        },
      });

      // Only the auth trio reached the LLM (billing pair gated out).
      expect(calls).toBe(1);
      expect(res.clustersFormed).toBe(1);
      expect(res.proposalsEmitted).toBe(0);
      expect(res.lessonsPromoted).toBe(0);
      expect(res.nullsReturned).toBeGreaterThanOrEqual(1);
      expect(listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine").length).toBe(0);
    },
    TIMEOUT_MS,
  );
});

// ── AC4: decay on absence (consecutive count resets) ────────────────────────────

describe("recombine promotion — decay on absence (AC4)", () => {
  test(
    "a cluster not re-induced this run has its consecutive streak reset; a different cluster's count is untouched",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;
      // Cluster A: tag `alpha` trio (forms on run1).
      writeMemory(stash, "a-1", ["alpha"], "Alpha first distinct fact about the world.");
      writeMemory(stash, "a-2", ["alpha"], "Alpha entirely unrelated second observation here.");
      writeMemory(stash, "a-3", ["alpha"], "Alpha a third dissimilar note on the subject.");
      await buildIndex(stash);

      const config = promoteConfig(2);
      const llmFn = async () => GOOD_GENERALIZATION();

      // RUN 1 — cluster A induced → count=1.
      await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-1",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });
      const refA = pendingByType(stash, "hypothesis")[0].ref;
      const dbA1 = openStateDatabase(stateDbPath(iso));
      expect(getRecombineHypothesis(dbA1, refA)?.consecutive_count).toBe(1);
      dbA1.close();

      // Mutate the corpus so cluster A NO LONGER forms (retag its members so the
      // shared `alpha` tag drops below minClusterSize) but a DIFFERENT cluster B
      // (tag `beta` trio) forms instead.
      writeMemory(stash, "a-1", ["x1"], "Alpha first distinct fact about the world.");
      writeMemory(stash, "a-2", ["x2"], "Alpha entirely unrelated second observation here.");
      writeMemory(stash, "a-3", ["x3"], "Alpha a third dissimilar note on the subject.");
      writeMemory(stash, "b-1", ["beta"], "Beta first distinct fact about the world.");
      writeMemory(stash, "b-2", ["beta"], "Beta entirely unrelated second observation here.");
      writeMemory(stash, "b-3", ["beta"], "Beta a third dissimilar note on the subject.");
      await buildIndex(stash);

      // RUN 2 — only cluster B forms; cluster A is absent and must be decayed.
      await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-2",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });

      const dbR2 = openStateDatabase(stateDbPath(iso));
      // Cluster A: decayed back to 0 (or the row removed).
      const rowA = getRecombineHypothesis(dbR2, refA);
      expect(rowA?.consecutive_count ?? 0).toBe(0);
      // Cluster B: seen this run → count=1, NOT touched by the sweep.
      const refB = pendingByType(stash, "hypothesis").find((p) => p.ref !== refA)?.ref;
      expect(refB).toBeDefined();
      expect(getRecombineHypothesis(dbR2, refB as string)?.consecutive_count).toBe(1);
      dbR2.close();

      // Re-form cluster A on run3: it must start the streak over at count=1 and
      // NOT immediately promote (proves the decay actually reset it). Dissolve
      // cluster B at the same time (retag its members below minClusterSize) so
      // the ONLY generalization eligible to promote this run would be A — B's
      // own legitimate count=1→2 promotion must not mask A's reset under test.
      writeMemory(stash, "a-1", ["alpha"], "Alpha first distinct fact about the world.");
      writeMemory(stash, "a-2", ["alpha"], "Alpha entirely unrelated second observation here.");
      writeMemory(stash, "a-3", ["alpha"], "Alpha a third dissimilar note on the subject.");
      writeMemory(stash, "b-1", ["y1"], "Beta first distinct fact about the world.");
      writeMemory(stash, "b-2", ["y2"], "Beta entirely unrelated second observation here.");
      writeMemory(stash, "b-3", ["y3"], "Beta a third dissimilar note on the subject.");
      await buildIndex(stash);

      const res3 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-3",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });
      expect(res3.lessonsPromoted).toBe(0);

      const dbR3 = openStateDatabase(stateDbPath(iso));
      expect(getRecombineHypothesis(dbR3, refA)?.consecutive_count).toBe(1);
      dbR3.close();
    },
    TIMEOUT_MS,
  );
});
