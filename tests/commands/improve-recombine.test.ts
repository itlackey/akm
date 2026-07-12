// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #609 — recombine / synthesize pass (src/commands/improve/recombine.ts).
 *
 * The recombine pass is a whole-corpus synthesis stage that runs AFTER
 * consolidation and is OPT-IN (disabled by the built-in default strategy).
 * It clusters memories by RELATEDNESS (shared tags / graph entities — NOT
 * embedding similarity), issues ONE bounded LLM call per cluster to induce a
 * single cross-episodic generalization, and emits the result as a NORMAL
 * pending proposal with frontmatter `type: hypothesis` through the existing
 * proposal queue + quality gate. A justified null (no defensible
 * generalization) is an acceptable outcome and produces no proposal.
 *
 * Contract under test (the recombine API surface):
 *   - `akmRecombine(opts)` from `src/commands/improve/recombine.ts` returns a
 *     `RecombineResult` and accepts an injected `recombineLlmFn` seam.
 *   - `resolveProcessEnabled("recombine", profile)` is `false` by default.
 *   - `akmImprove({ recombineFn, ... })` wires the pass in only when enabled and
 *     attaches `RecombineResult` to `result.recombination`.
 *
 * All tests use sandbox helpers, inject the LLM seam (no real network), and
 * never touch real host state — mirroring tests/commands/improve/* patterns.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../src/commands/improve/distill";
import { akmImprove } from "../../src/commands/improve/improve";
import { resolveImproveStrategy, resolveProcessEnabled } from "../../src/commands/improve/improve-strategies";
// Imported from the module under test (now shipped).
import { akmRecombine } from "../../src/commands/improve/recombine";
import type { AkmReflectResult } from "../../src/commands/improve/reflect";
import { listProposals } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { saveConfig } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../../src/indexer/db/db";
import { akmIndex } from "../../src/indexer/indexer";
import { insertGraphEntities } from "../_helpers/graph-store";
import { withTestImproveLlm } from "../_helpers/improve-config";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const TIMEOUT_MS = 20_000;
const cleanups: Array<() => void> = [];

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

/** Write a memory file with explicit frontmatter tags + a body. */
function writeMemory(stashDir: string, name: string, tags: string[], body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tagsYaml = tags.length ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n` : "";
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n${tagsYaml}---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

/** A generalization payload as the recombine LLM would return it. */
function generalization(description: string, body: string): string {
  return JSON.stringify({ description, when_to_use: "when working on this topic", body });
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

/** Improve config with recombine enabled (and noisy passes silenced). */
function recombineEnabledConfig(overrides?: Record<string, unknown>): AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            recombine: { enabled: true, relatednessSource: "tags", minClusterSize: 3, ...(overrides ?? {}) },
          },
        },
      },
    },
  } as unknown as AkmConfig);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── AC3: opt-in gating ────────────────────────────────────────────────────────

describe("recombine — opt-in default (AC3)", () => {
  test("resolveProcessEnabled('recombine', defaultProfile) === false", () => {
    const profile = resolveImproveStrategy("default", { semanticSearchMode: "off" } as AkmConfig).config;
    expect(resolveProcessEnabled("recombine", profile)).toBe(false);
  });

  test(
    "default profile with no recombine config does NOT run the pass",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login.");
      writeMemory(stash, "auth-b", ["auth"], "Sessions expire after thirty minutes idle.");
      writeMemory(stash, "auth-c", ["auth"], "MFA is required for admin role escalation.");
      await buildIndex(stash);

      let recombineInvoked = false;
      const res = await akmImprove({
        scope: "memory",
        stashDir: stash,
        ...noopIndexFns,
        reflectFn: async ({ ref }) => okReflect(ref ?? ""),
        distillFn: async ({ ref }) => okDistill(ref ?? ""),
        recombineFn: async () => {
          recombineInvoked = true;
          return {
            schemaVersion: 1,
            ok: true,
            clustersFormed: 0,
            proposalsEmitted: 0,
            lessonsPromoted: 0,
            nullsReturned: 0,
            durationMs: 0,
            warnings: [],
          };
        },
      });

      expect(recombineInvoked).toBe(false);
      expect(res.recombination).toBeUndefined();
      const { events } = readEvents({ type: "recombine_invoked" });
      expect(events.length).toBe(0);
      const proposals = listProposals(stash, { status: "pending" });
      expect(proposals.filter((p) => p.source === "recombine").length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "enabling processes.recombine.enabled runs the pass and attaches RecombineResult",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login.");
      writeMemory(stash, "auth-b", ["auth"], "Sessions expire after thirty minutes idle.");
      writeMemory(stash, "auth-c", ["auth"], "MFA is required for admin role escalation.");
      await buildIndex(stash);

      let recombineInvoked = false;
      const res = await akmImprove({
        scope: "memory",
        stashDir: stash,
        config: recombineEnabledConfig(),
        ...noopIndexFns,
        reflectFn: async ({ ref }) => okReflect(ref ?? ""),
        distillFn: async ({ ref }) => okDistill(ref ?? ""),
        recombineFn: async () => {
          recombineInvoked = true;
          return {
            schemaVersion: 1,
            ok: true,
            clustersFormed: 1,
            proposalsEmitted: 1,
            lessonsPromoted: 0,
            nullsReturned: 0,
            durationMs: 1,
            warnings: [],
          };
        },
      });

      expect(recombineInvoked).toBe(true);
      expect(res.recombination).toBeDefined();
      expect(res.recombination?.clustersFormed).toBe(1);
    },
    TIMEOUT_MS,
  );
});

// ── AC1: one proposal from 3+ dissimilar memories sharing a tag ─────────────────

describe("recombine — single-proposal emission (AC1)", () => {
  test(
    "3 dissimilar memories sharing tag `auth` produce exactly ONE type:hypothesis proposal",
    async () => {
      const stash = isolatedStash();
      // Textually dissimilar bodies, but all share the `auth` tag.
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      let calls = 0;
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-ac1",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async () => {
          calls += 1;
          return generalization(
            "Authentication state is short-lived and continuously re-verified.",
            "Across login, session, and escalation flows, auth artifacts are intentionally ephemeral.",
          );
        },
      });

      expect(calls).toBe(1);
      expect(res.proposalsEmitted).toBe(1);

      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(1);

      // The emitted proposal must carry frontmatter type: hypothesis and target a lesson ref.
      const proposal = pending[0];
      expect(proposal.ref.startsWith("lesson:")).toBe(true);
      const content = proposal.payload.content ?? "";
      expect(content).toContain("type: hypothesis");
    },
    TIMEOUT_MS,
  );

  test(
    "justified null: LLM returns explicit null → ZERO proposals + null_returned event",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-null",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async () => "null",
      });

      expect(res.proposalsEmitted).toBe(0);
      expect(res.nullsReturned).toBeGreaterThanOrEqual(1);

      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(0);

      const { events } = readEvents({ type: "recombine_invoked" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => (e.metadata as { outcome?: string }).outcome === "null_returned")).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// ── Clustering by relatedness, NOT similarity ───────────────────────────────────

describe("recombine — clusters by relatedness not similarity", () => {
  test(
    "the tag-sharing trio clusters, the textually-similar untagged pair does NOT",
    async () => {
      const stash = isolatedStash();
      // Two near-identical bodies, but NO shared tag — must NOT cluster.
      writeMemory(stash, "dup-a", [], "The deploy script restarts the API service after copying the build.");
      writeMemory(stash, "dup-b", [], "The deploy script restarts the API service after copying the build artifact.");
      // Three dissimilar bodies sharing tag `auth` — must cluster.
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      const seenMemberRefs: string[][] = [];
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-relatedness",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async (prompt) => {
          // Capture which refs the cluster prompt mentions so we can assert the
          // cluster membership is the tag trio, not the similar pair.
          const refs = ["auth-a", "auth-b", "auth-c", "dup-a", "dup-b"].filter((n) => prompt.includes(n));
          seenMemberRefs.push(refs);
          return generalization("Auth artifacts are ephemeral.", "Generalization body.");
        },
      });

      // Exactly one cluster (the auth trio); the similar pair never reaches the LLM.
      expect(res.clustersFormed).toBe(1);
      expect(seenMemberRefs.length).toBe(1);
      const members = seenMemberRefs[0];
      expect(members).toContain("auth-a");
      expect(members).toContain("auth-b");
      expect(members).toContain("auth-c");
      expect(members).not.toContain("dup-a");
      expect(members).not.toContain("dup-b");
    },
    TIMEOUT_MS,
  );

  test(
    "min cluster size gate: a tag shared by only 2 memories produces NO cluster and NO LLM call",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "pair-a", ["billing"], "Invoices are generated on the first of the month.");
      writeMemory(stash, "pair-b", ["billing"], "Refunds post within five business days.");
      await buildIndex(stash);

      let calls = 0;
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-mincluster",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async () => {
          calls += 1;
          return generalization("x", "y");
        },
      });

      expect(calls).toBe(0);
      expect(res.clustersFormed).toBe(0);
      expect(res.proposalsEmitted).toBe(0);

      const { events } = readEvents({ type: "recombine_invoked" });
      expect(events.length).toBe(0);
    },
    TIMEOUT_MS,
  );
});

// ── AC2: flows through the proposal queue + quality gate ────────────────────────

describe("recombine — proposal queue + quality gate (AC2)", () => {
  test(
    "the emitted proposal is a normal pending proposal with source 'recombine' and a sourceRun token",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-queue-token",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async () => generalization("Auth is ephemeral.", "Body of the generalization."),
      });

      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(1);
      expect(pending[0].source).toBe("recombine");
      expect(pending[0].sourceRun).toBe("run-queue-token");
      expect(pending[0].status).toBe("pending");

      // Two-pass guard: no lesson file should have been written directly to the stash.
      const lessonsDir = path.join(stash, "lessons");
      const writtenLessons = fs.existsSync(lessonsDir) ? fs.readdirSync(lessonsDir) : [];
      expect(writtenLessons.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "quality gate not bypassed: a generalization with an empty description is REJECTED (no pending proposal)",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-badgate",
        relatednessSource: "tags",
        minClusterSize: 3,
        // Empty description fails validateProposalFrontmatter.
        recombineLlmFn: async () => generalization("", "Body without a description."),
      });

      expect(res.proposalsEmitted).toBe(0);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a well-formed generalization passes the gate and lands pending",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-goodgate",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async () =>
          generalization(
            "Authentication state is short-lived and continuously re-verified across flows.",
            "A well-formed generalization body that says something none of the inputs states alone.",
          ),
      });

      expect(res.proposalsEmitted).toBe(1);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(1);
    },
    TIMEOUT_MS,
  );
});

// ── Two-pass guard: never inject a lesson directly ──────────────────────────────

describe("recombine — two-pass guard", () => {
  test(
    "first pass emits frontmatter type:hypothesis (never type:lesson) targeting a lesson ref",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-twopass",
        relatednessSource: "tags",
        minClusterSize: 3,
        recombineLlmFn: async () => generalization("Auth is ephemeral.", "Generalization body."),
      });

      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(1);
      const content = pending[0].payload.content ?? "";
      expect(content).toContain("type: hypothesis");
      expect(content).not.toContain("type: lesson");
      expect(pending[0].ref.startsWith("lesson:")).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// ── maxClustersPerRun cap ───────────────────────────────────────────────────────

describe("recombine — maxClustersPerRun cap", () => {
  test(
    "with N > cap distinct shared-tag clusters, at most `maxClustersPerRun` LLM calls fire",
    async () => {
      const stash = isolatedStash();
      // Build 4 distinct shared-tag trios; cap to 2.
      const topics = ["alpha", "beta", "gamma", "delta"];
      for (const topic of topics) {
        writeMemory(stash, `${topic}-1`, [topic], `${topic} first distinct fact about the world.`);
        writeMemory(stash, `${topic}-2`, [topic], `${topic} entirely unrelated second observation here.`);
        writeMemory(stash, `${topic}-3`, [topic], `${topic} a third dissimilar note on the subject.`);
      }
      await buildIndex(stash);

      let calls = 0;
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig({ maxClustersPerRun: 2 }),
        sourceRun: "run-cap",
        relatednessSource: "tags",
        minClusterSize: 3,
        maxClustersPerRun: 2,
        recombineLlmFn: async () => {
          calls += 1;
          return generalization("Some generalization here.", "Body.");
        },
      });

      expect(calls).toBeLessThanOrEqual(2);
      expect(res.clustersFormed).toBeLessThanOrEqual(2);
      expect(res.proposalsEmitted).toBeLessThanOrEqual(2);
    },
    TIMEOUT_MS,
  );
});

// ── Budget / abort handling ─────────────────────────────────────────────────────

describe("recombine — budget/abort", () => {
  test(
    "an already-aborted AbortSignal short-circuits: no LLM calls, partial result returned",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      const controller = new AbortController();
      controller.abort();

      let calls = 0;
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-abort",
        relatednessSource: "tags",
        minClusterSize: 3,
        signal: controller.signal,
        recombineLlmFn: async () => {
          calls += 1;
          return generalization("Should never be called.", "Body.");
        },
      });

      expect(calls).toBe(0);
      expect(res.proposalsEmitted).toBe(0);
      // Partial result is still returned (ok may be false to flag the abort).
      expect(res.schemaVersion).toBe(1);
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(0);
    },
    TIMEOUT_MS,
  );
});

// ── #632 — graph-entity clustering end-to-end ─────────────────────────────────
//
// Proves the full `akmRecombine` path (real `getEntitiesByEntryIds` join →
// `buildRelatednessClusters`) forms `entity:<norm>` clusters from a SHARED graph
// entity, and that the new default (`relatednessSource` = "both") enables it
// without an explicit source. Entities are injected post-index via the shared
// `insertGraphEntities` seam (mirrors real `graph_file_entities` rows).

describe("recombine #632 — entity clustering end-to-end", () => {
  test(
    "clusters memories sharing a graph entity (no shared tag) into an entity-derived lesson ref",
    async () => {
      const stash = isolatedStash();
      // Three memories: NO shared tag, dissimilar bodies — related ONLY by a graph entity.
      writeMemory(stash, "ent-a", [], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "ent-b", [], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "ent-c", [], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      // Attach a shared entity to all three indexed memories.
      const db = openExistingDatabase();
      try {
        for (const m of getAllEntries(db, "memory")) {
          insertGraphEntities(db, m.id, m.stashDir, m.filePath, ["OAuth"]);
        }
      } finally {
        closeDatabase(db);
      }

      let seenSignal = "";
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-entity",
        relatednessSource: "graph",
        minClusterSize: 3,
        recombineLlmFn: async (prompt) => {
          seenSignal = /Shared signal: (\S+)/.exec(prompt)?.[1] ?? "";
          return generalization("OAuth artifacts are ephemeral.", "Generalization body.");
        },
      });

      expect(res.clustersFormed).toBe(1);
      expect(seenSignal).toBe("entity:oauth"); // entity_norm is lowercased
      const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "recombine");
      expect(pending.length).toBe(1);
      expect(pending[0].ref.startsWith("lesson:recombined/oauth-")).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "the 'both' blend processes an entity-led mix through akmRecombine (entities lead, 1 tag reserved)",
    async () => {
      const stash = isolatedStash();
      // THREE entity clusters (members share an entity, no shared tag) + ONE tag
      // cluster. With cap 3 and pure entity-preference all 3 slots would be
      // entities, starving the tag; the reserve must hand one slot to tag:topic.
      for (const p of ["x", "y", "z"]) {
        writeMemory(stash, `${p}-1`, [], `${p} alpha detail.`);
        writeMemory(stash, `${p}-2`, [], `${p} beta detail.`);
        writeMemory(stash, `${p}-3`, [], `${p} gamma detail.`);
      }
      writeMemory(stash, "t-1", ["topic"], "Topic one.");
      writeMemory(stash, "t-2", ["topic"], "Topic two.");
      writeMemory(stash, "t-3", ["topic"], "Topic three.");
      await buildIndex(stash);

      const db = openExistingDatabase();
      try {
        for (const m of getAllEntries(db, "memory")) {
          const name = (m.entry as { name: string }).name;
          if (name.startsWith("x-")) insertGraphEntities(db, m.id, m.stashDir, m.filePath, ["Toolx"]);
          else if (name.startsWith("y-")) insertGraphEntities(db, m.id, m.stashDir, m.filePath, ["Tooly"]);
          else if (name.startsWith("z-")) insertGraphEntities(db, m.id, m.stashDir, m.filePath, ["Toolz"]);
        }
      } finally {
        closeDatabase(db);
      }

      const seenSignals: string[] = [];
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-blend",
        relatednessSource: "both",
        minClusterSize: 3,
        maxClustersPerRun: 3,
        recombineLlmFn: async (prompt) => {
          seenSignals.push(/Shared signal: (\S+)/.exec(prompt)?.[1] ?? "");
          return generalization("Blended generalization.", "Generalization body.");
        },
      });

      expect(res.clustersFormed).toBe(3);
      // Two entity clusters lead (alphabetical tiebreak: toolx, tooly), and one
      // slot is RESERVED for the tag — the third entity (toolz) is left out.
      expect(seenSignals.filter((s) => s.startsWith("entity:")).sort()).toEqual(["entity:toolx", "entity:tooly"]);
      expect(seenSignals).toContain("tag:topic");
      expect(seenSignals).not.toContain("entity:toolz");
    },
    TIMEOUT_MS,
  );

  test(
    "the default relatednessSource ('both', #632) clusters by entity with NO explicit source",
    async () => {
      const stash = isolatedStash();
      writeMemory(stash, "d-a", [], "Token refresh logic lives in the gateway.");
      writeMemory(stash, "d-b", [], "Nightly jobs vacuum the analytics tables.");
      writeMemory(stash, "d-c", [], "The footer link color is teal.");
      await buildIndex(stash);

      const db = openExistingDatabase();
      try {
        for (const m of getAllEntries(db, "memory")) {
          insertGraphEntities(db, m.id, m.stashDir, m.filePath, ["PrintMd"]);
        }
      } finally {
        closeDatabase(db);
      }

      let seenSignal = "";
      const res = await akmRecombine({
        stashDir: stash,
        config: recombineEnabledConfig(),
        sourceRun: "run-default",
        // relatednessSource intentionally OMITTED → exercises DEFAULT_RELATEDNESS_SOURCE ("both").
        // (akmRecombine reads opts.relatednessSource, not config, so the default applies.)
        minClusterSize: 3,
        recombineLlmFn: async (prompt) => {
          seenSignal = /Shared signal: (\S+)/.exec(prompt)?.[1] ?? "";
          return generalization("Print-md provider artifacts.", "Generalization body.");
        },
      });

      expect(res.clustersFormed).toBe(1);
      expect(seenSignal).toBe("entity:printmd");
    },
    TIMEOUT_MS,
  );
});
