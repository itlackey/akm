// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #632 + #633 — recombine clustering tuning + confirmation-loop Jaccard fix.
 *
 * #632 (clusters too coarse): `buildRelatednessClusters` groups by tag, keeps
 *   groups >= minClusterSize, then sorts LARGEST-first and slices the top
 *   maxClustersPerRun — so the biggest/most-generic tag buckets always win and
 *   smaller, tighter clusters are starved. The fix adds TWO default-preserving
 *   knobs:
 *     - `maxClusterSize?: number` — clusters strictly larger than the cap are
 *       SKIPPED. UNSET = no cap = byte-identical to today.
 *     - `excludeTags?: string[]` — tags in this list never form a tag cluster.
 *       UNSET/[] = byte-identical to today.
 *   When `maxClusterSize` is set the largest-first preference must NOT starve
 *   smaller clusters; with BOTH knobs unset the output is identical to today.
 *
 * #633 (confirmation loop structurally dead): the hypothesis streak is keyed on
 *   a hash of the EXACT member set. In a growing stash, ANY added member changes
 *   the hash → new row → streak resets to 1 → confirmThreshold(2) is never
 *   reached → no lesson ever promotes. The fix matches a newly-induced
 *   hypothesis to an existing pending row by SIGNATURE + membership-overlap
 *   (Jaccard >= threshold) and increments the existing streak instead of
 *   inserting a fresh row, so drifting-but-overlapping membership accumulates.
 *
 * #632 verifies the maxClusterSize / excludeEntities knobs cap over-broad
 * clusters; #633 verifies the Jaccard-overlap streak accumulates across
 * drifting membership instead of resetting each run.
 *
 * #632 cases drive the PURE `buildRelatednessClusters` function with synthetic
 * entries (no index / DB / LLM). #633 drives the full `akmRecombine` pass with
 * an injected LLM seam and the sandbox-pinned state.db. UNIT-tier: no Bun.spawn
 * / Bun.serve / 60s timeout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmRecombine,
  buildRelatednessClusters,
  capClusters,
  isJunkEntity,
  isJunkTag,
  selectClustersForRun,
} from "../src/commands/improve/recombine";
import { listProposals } from "../src/commands/proposal/repository";
import type { AkmConfig } from "../src/core/config/config";
import { saveConfig } from "../src/core/config/config";
import { openStateDatabase } from "../src/core/state-db";
import type { DbIndexedEntry } from "../src/indexer/db/db";
import { akmIndex } from "../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

const TIMEOUT_MS = 20_000;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── #632 helpers: synthetic DbIndexedEntry memories ─────────────────────────────

/** Build a synthetic indexed memory entry carrying the given tags. */
function memoryEntry(id: number, name: string, tags: string[]): DbIndexedEntry {
  return {
    id,
    entryKey: `memory:${name}`,
    dirPath: "/virtual/memories",
    filePath: `/virtual/memories/${name}.md`,
    stashDir: "/virtual",
    searchText: name,
    entry: {
      name,
      type: "memory",
      tags,
    },
  } as unknown as DbIndexedEntry;
}

/** Sorted member entryKeys for an array of clusters, for stable comparison. */
function clusterShape(clusters: { signature: string; members: DbIndexedEntry[] }[]): Array<{
  signature: string;
  members: string[];
}> {
  return clusters
    .map((c) => ({
      signature: c.signature,
      members: c.members
        .map((m) => m.entryKey)
        .slice()
        .sort(),
    }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

// ── #632(a): maxClusterSize excludes oversized clusters ─────────────────────────

describe("#632 — maxClusterSize cap", () => {
  test("a cluster exceeding maxClusterSize is excluded when the knob is set", () => {
    // tag:big has 5 members (> cap 4); tag:small has 3 members (<= cap).
    const entries: DbIndexedEntry[] = [
      memoryEntry(1, "big-1", ["big"]),
      memoryEntry(2, "big-2", ["big"]),
      memoryEntry(3, "big-3", ["big"]),
      memoryEntry(4, "big-4", ["big"]),
      memoryEntry(5, "big-5", ["big"]),
      memoryEntry(6, "small-1", ["small"]),
      memoryEntry(7, "small-2", ["small"]),
      memoryEntry(8, "small-3", ["small"]),
    ];

    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "tags",
      maxClusterSize: 4,
    } as Parameters<typeof buildRelatednessClusters>[1]);

    const signatures = clusters.map((c) => c.signature).sort();
    // The oversized tag:big cluster (5 members > 4) must be SKIPPED.
    expect(signatures).not.toContain("tag:big");
    // The within-cap tag:small cluster survives.
    expect(signatures).toContain("tag:small");
    expect(clusters.length).toBe(1);
  });

  test("with maxClusterSize set, a smaller tight cluster is NOT starved by a larger one", () => {
    // Without the fix, largest-first + slice(0, maxClustersPerRun:1) would keep
    // ONLY tag:big. With maxClusterSize:4 the oversized tag:big is skipped, so
    // the tighter tag:small cluster is the one that survives the per-run cap.
    const entries: DbIndexedEntry[] = [
      memoryEntry(1, "big-1", ["big"]),
      memoryEntry(2, "big-2", ["big"]),
      memoryEntry(3, "big-3", ["big"]),
      memoryEntry(4, "big-4", ["big"]),
      memoryEntry(5, "big-5", ["big"]),
      memoryEntry(6, "small-1", ["small"]),
      memoryEntry(7, "small-2", ["small"]),
      memoryEntry(8, "small-3", ["small"]),
    ];

    const clusters = capClusters(
      buildRelatednessClusters(entries, {
        minClusterSize: 3,
        relatednessSource: "tags",
        maxClusterSize: 4,
      } as Parameters<typeof buildRelatednessClusters>[1]),
      1,
    );

    expect(clusters.length).toBe(1);
    expect(clusters[0].signature).toBe("tag:small");
  });
});

// ── #632(b): excludeTags drops tags from clustering ─────────────────────────────

describe("#632 — excludeTags", () => {
  test("tags in excludeTags are not used to form clusters", () => {
    // tag:generic and tag:specific each have a 3-member group. Excluding
    // "generic" must drop ONLY that cluster.
    const entries: DbIndexedEntry[] = [
      memoryEntry(1, "g-1", ["generic", "specific"]),
      memoryEntry(2, "g-2", ["generic", "specific"]),
      memoryEntry(3, "g-3", ["generic", "specific"]),
      memoryEntry(4, "x-1", ["generic"]),
      memoryEntry(5, "x-2", ["generic"]),
    ];

    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "tags",
      excludeTags: ["generic"],
    } as Parameters<typeof buildRelatednessClusters>[1]);

    const signatures = clusters.map((c) => c.signature).sort();
    // tag:generic must NOT appear (excluded), even though 5 memories carry it.
    expect(signatures).not.toContain("tag:generic");
    // tag:specific (3 members) still forms.
    expect(signatures).toContain("tag:specific");
    expect(clusters.length).toBe(1);
  });
});

// ── #632: structural junk-tag filter ────────────────────────────────────────────

describe("#632 — junk tags (numeric/date/hash/version/stopword) never cluster", () => {
  test("isJunkTag classifies open-ended junk but keeps topical tags", () => {
    for (const junk of [
      "2026",
      "05",
      "23",
      "20260529",
      "0.8.0",
      "v2",
      "v0",
      "002c624c",
      "192d",
      "is",
      "the",
      "for",
      "and",
      "when",
      "a",
    ]) {
      expect(isJunkTag(junk)).toBe(true);
    }
    for (const good of ["auth", "architecture", "patterns", "graph", "svelte", "recombine"]) {
      expect(isJunkTag(good)).toBe(false);
    }
  });

  test("a numeric/date tag does not form a cluster even with enough members", () => {
    const entries: DbIndexedEntry[] = [
      memoryEntry(1, "m-1", ["20260529", "auth"]),
      memoryEntry(2, "m-2", ["20260529", "auth"]),
      memoryEntry(3, "m-3", ["20260529", "auth"]),
    ];
    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "tags",
    });
    const signatures = clusters.map((c) => c.signature);
    expect(signatures).not.toContain("tag:20260529");
    expect(signatures).toContain("tag:auth");
  });
});

// ── #632(c): default-preserving guard ───────────────────────────────────────────

describe("#632 — default-preserving guard (both knobs UNSET)", () => {
  test("with maxClusterSize + excludeTags UNSET, clustering output is identical to current behavior", () => {
    // Multiple clusters of varying size that exercise the largest-first sort +
    // maxClustersPerRun slice. With the new knobs UNSET the result must be
    // byte-identical to the pre-#632 behaviour.
    const entries: DbIndexedEntry[] = [
      // tag:alpha — 4 members (largest)
      memoryEntry(1, "a-1", ["alpha"]),
      memoryEntry(2, "a-2", ["alpha"]),
      memoryEntry(3, "a-3", ["alpha"]),
      memoryEntry(4, "a-4", ["alpha"]),
      // tag:beta — 3 members
      memoryEntry(5, "b-1", ["beta"]),
      memoryEntry(6, "b-2", ["beta"]),
      memoryEntry(7, "b-3", ["beta"]),
      // tag:gamma — 3 members
      memoryEntry(8, "c-1", ["gamma"]),
      memoryEntry(9, "c-2", ["gamma"]),
      memoryEntry(10, "c-3", ["gamma"]),
      // tag:tiny — 2 members (below minClusterSize, never clusters)
      memoryEntry(11, "t-1", ["tiny"]),
      memoryEntry(12, "t-2", ["tiny"]),
    ];

    const opts = {
      minClusterSize: 3,
      relatednessSource: "tags" as const,
    };

    // The pre-#632 behaviour: largest-first, then capClusters(…, maxClustersPerRun).
    // alpha(4) wins; beta vs gamma tie at 3 → broken by signature ascending →
    // "tag:beta" before "tag:gamma". So the top-2 are alpha + beta.
    const result = capClusters(buildRelatednessClusters(entries, opts), 2);
    const shape = clusterShape(result);

    expect(result.length).toBe(2);
    expect(shape).toEqual([
      { signature: "tag:alpha", members: ["memory:a-1", "memory:a-2", "memory:a-3", "memory:a-4"] },
      { signature: "tag:beta", members: ["memory:b-1", "memory:b-2", "memory:b-3"] },
    ]);
  });
});

// ── #633: drifting membership still accumulates the confirmation streak ──────────

function isolated(): IsolatedAkmStorage {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso;
}

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

function generalization(description: string, body: string): string {
  return JSON.stringify({ description, when_to_use: "when working on this topic", body });
}

const GOOD_GENERALIZATION = () =>
  generalization(
    "Authentication state is short-lived and continuously re-verified across flows.",
    "A well-formed generalization body that says something none of the inputs states alone.",
  );

function promoteConfig(confirmThreshold: number): AkmConfig {
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
            recombine: { enabled: true, relatednessSource: "tags", minClusterSize: 3, confirmThreshold },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

function stateDbPath(iso: IsolatedAkmStorage): string {
  return path.join(iso.dataDir, "akm", "state.db");
}

function pendingByType(stashDir: string, type: "hypothesis" | "lesson"): ReturnType<typeof listProposals> {
  return listProposals(stashDir, { status: "pending" }).filter(
    (p) => p.source === "recombine" && (p.payload.content ?? "").includes(`type: ${type}`),
  );
}

describe("#633 — drifting membership accumulates the confirmation streak", () => {
  test(
    "adding one member each run keeps the streak under the same signature and promotes at confirmThreshold:2",
    async () => {
      const iso = isolated();
      const stash = iso.stashDir;

      // RUN 1 — a 3-member tag:auth cluster. Streak should start at 1.
      writeMemory(stash, "auth-a", ["auth"], "Refresh tokens rotate on each login event.");
      writeMemory(stash, "auth-b", ["auth"], "A scheduled cron prunes orphaned database rows nightly.");
      writeMemory(stash, "auth-c", ["auth"], "The marketing site uses a teal accent color in the footer.");
      await buildIndex(stash);

      const config = promoteConfig(2);
      const llmFn = async () => GOOD_GENERALIZATION();

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

      // RUN 2 — the SAME tag:auth cluster gains a 4th member (membership drifts,
      // overlap = 3/4 = 0.75 >= 0.7). Under the OLD exact-member-set hash this
      // creates a new row at count=1 and never promotes. Under #633 the streak
      // continues to count=2 and PROMOTES to a lesson.
      writeMemory(stash, "auth-d", ["auth"], "Password reset links expire after fifteen minutes.");
      await buildIndex(stash);

      const res2 = await akmRecombine({
        stashDir: stash,
        config,
        sourceRun: "run-2",
        relatednessSource: "tags",
        minClusterSize: 3,
        confirmThreshold: 2,
        recombineLlmFn: llmFn,
      });

      // THE BUGFIX ASSERTION: the drifting cluster promoted (streak reached 2),
      // instead of resetting to 1 on every run and never promoting.
      expect(res2.lessonsPromoted).toBe(1);
      expect(pendingByType(stash, "lesson").length).toBe(1);

      // The matched hypothesis row reached the threshold and is now promoted.
      const db = openStateDatabase(stateDbPath(iso));
      const rows = db
        .prepare("SELECT hypothesis_ref, consecutive_count, promoted_at, signature FROM recombine_hypotheses")
        .all() as Array<{
        hypothesis_ref: string;
        consecutive_count: number;
        promoted_at: string | null;
        signature: string;
      }>;
      db.close();

      // Exactly one tag:auth hypothesis row tracked the cluster across both runs
      // (membership-overlap match), rather than a fresh row per run.
      const authRows = rows.filter((r) => r.signature === "tag:auth");
      expect(authRows.length).toBe(1);
      expect(authRows[0].promoted_at).not.toBeNull();
    },
    TIMEOUT_MS,
  );
});

// ── #632 — graph-ENTITY clustering (RED) ───────────────────────────────────────
//
// The dormant entity path (`relatednessSource: "graph"|"both"`) clustered on
// `graph_file_entities.entity_norm`, but (a) had no noise filter — generic
// extraction artefacts (`session_checkpoint`, `session_id`, raw file paths)
// formed the same bland mega-clusters #632 set out to kill, and (b) was never
// the default. These tests assert: `isJunkEntity` drops the noise but keeps
// coherent subsystem names; entity clustering forms `entity:<norm>` clusters
// from a SHARED ENTITY (no shared tag); the `excludeEntities` knob suppresses a
// named entity; and `"both"` unions tag + entity clusters. Tag clustering stays
// byte-identical (additive).

describe("recombine #632 — entity noise filter (isJunkEntity)", () => {
  test("drops generic extraction-artefact entities", () => {
    for (const junk of [
      "session_checkpoint",
      "session_id",
      "session",
      "reason",
      "harness",
      "structured event log",
      "event",
      "/home/founder3/.local/state/akm-opencode",
      "C:\\Users\\x\\notes",
      "2026",
      "20260529",
      "v1.2.3",
      "a1b2", // short hex hash (has a digit)
      "002c624c",
      "a",
    ]) {
      expect(isJunkEntity(junk)).toBe(true);
    }
  });

  test("keeps coherent subsystem / tool names", () => {
    for (const good of ["opencode", "print-md", "akm_curate", "akm_show", "claude-code", "guardian"]) {
      expect(isJunkEntity(good)).toBe(false);
    }
  });
});

describe("recombine #632 — entity-based clustering", () => {
  test("forms an entity:<norm> cluster from a shared graph entity (no shared tag)", () => {
    const entries = [memoryEntry(1, "a", []), memoryEntry(2, "b", []), memoryEntry(3, "c", [])];
    const entityByEntryId = new Map<number, string[]>([
      [1, ["opencode"]],
      [2, ["opencode"]],
      [3, ["opencode"]],
    ]);
    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "graph",
      entityByEntryId,
    });
    expect(clusterShape(clusters)).toEqual([
      { signature: "entity:opencode", members: ["memory:a", "memory:b", "memory:c"] },
    ]);
  });

  test("a junk entity never forms a cluster", () => {
    const entries = [memoryEntry(1, "a", []), memoryEntry(2, "b", []), memoryEntry(3, "c", [])];
    const entityByEntryId = new Map<number, string[]>([
      [1, ["session_checkpoint"]],
      [2, ["session_checkpoint"]],
      [3, ["session_checkpoint"]],
    ]);
    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "graph",
      entityByEntryId,
    });
    expect(clusters).toEqual([]);
  });

  test("excludeEntities suppresses a named entity cluster (case-insensitive vs lowercased entity_norm)", () => {
    const entries = [memoryEntry(1, "a", []), memoryEntry(2, "b", []), memoryEntry(3, "c", [])];
    const entityByEntryId = new Map<number, string[]>([
      [1, ["opencode"]],
      [2, ["opencode"]],
      [3, ["opencode"]],
    ]);
    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "graph",
      entityByEntryId,
      // Mixed-case user input must still match the always-lowercase entity_norm.
      excludeEntities: ["OpenCode"],
    });
    expect(clusters).toEqual([]);
  });

  test('"both" unions tag and entity clusters with distinct member sets', () => {
    const entries = [
      memoryEntry(1, "a", ["auth"]),
      memoryEntry(2, "b", ["auth"]),
      memoryEntry(3, "c", ["auth"]),
      memoryEntry(4, "d", []),
      memoryEntry(5, "e", []),
    ];
    const entityByEntryId = new Map<number, string[]>([
      [3, ["opencode"]],
      [4, ["opencode"]],
      [5, ["opencode"]],
    ]);
    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "both",
      entityByEntryId,
    });
    expect(clusterShape(clusters)).toEqual([
      { signature: "entity:opencode", members: ["memory:c", "memory:d", "memory:e"] },
      { signature: "tag:auth", members: ["memory:a", "memory:b", "memory:c"] },
    ]);
  });

  test("entity clusters rank AHEAD of larger tag clusters for selection (#632)", () => {
    const entries = [
      // tag:big has 4 members — LARGER than the entity cluster.
      memoryEntry(1, "a", ["big"]),
      memoryEntry(2, "b", ["big"]),
      memoryEntry(3, "c", ["big"]),
      memoryEntry(4, "d", ["big"]),
      // entity:printmd has 3 members — smaller, but must rank FIRST (higher-signal).
      memoryEntry(5, "e", []),
      memoryEntry(6, "f", []),
      memoryEntry(7, "g", []),
    ];
    const entityByEntryId = new Map<number, string[]>([
      [5, ["printmd"]],
      [6, ["printmd"]],
      [7, ["printmd"]],
    ]);
    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      relatednessSource: "both",
      entityByEntryId,
    });
    // Result order is the SELECTION order (capClusters slices the head). The
    // smaller entity cluster must come before the larger tag cluster.
    expect(clusters.map((c) => c.signature)).toEqual(["entity:printmd", "tag:big"]);
  });

  test("tag clustering is unchanged when entities are absent (additive default)", () => {
    const entries = [memoryEntry(1, "a", ["auth"]), memoryEntry(2, "b", ["auth"]), memoryEntry(3, "c", ["auth"])];
    // No entityByEntryId → "both" falls through to tag-only, byte-identical to "tags".
    const both = buildRelatednessClusters(entries, { minClusterSize: 3, relatednessSource: "both" });
    const tags = buildRelatednessClusters(entries, { minClusterSize: 3, relatednessSource: "tags" });
    expect(clusterShape(both)).toEqual(clusterShape(tags));
    expect(clusterShape(both)).toEqual([{ signature: "tag:auth", members: ["memory:a", "memory:b", "memory:c"] }]);
  });
});

describe("recombine #632 — selectClustersForRun (entity/tag blend)", () => {
  // Build a cluster of `size` members with the given signature.
  const cl = (signature: string, size: number) => ({
    signature,
    members: Array.from({ length: size }, (_, i) => memoryEntry(i + 1, `${signature.replace(/\W/g, "-")}-${i}`, [])),
  });

  test("tags-only (no entity clusters) → top-N tags, identical to capClusters", () => {
    const ranked = [cl("tag:a", 5), cl("tag:b", 4), cl("tag:c", 3), cl("tag:d", 3)];
    expect(selectClustersForRun(ranked, 3).map((c) => c.signature)).toEqual(["tag:a", "tag:b", "tag:c"]);
    expect(selectClustersForRun(ranked, 3).map((c) => c.signature)).toEqual(
      capClusters(ranked, 3).map((c) => c.signature),
    );
  });

  test("entities + plenty of tags → entities lead, top-3 tags reserved (2 entity + 3 tag at cap 5)", () => {
    // ranked is entity-first (the buildRelatednessClusters sort), largest-first within kind.
    const ranked = [
      cl("entity:x", 10),
      cl("entity:y", 9),
      cl("entity:z", 8),
      cl("tag:a", 7),
      cl("tag:b", 6),
      cl("tag:c", 5),
    ];
    expect(selectClustersForRun(ranked, 5).map((c) => c.signature)).toEqual([
      "entity:x",
      "entity:y",
      "tag:a",
      "tag:b",
      "tag:c",
    ]);
  });

  test("few tags → entities backfill the unused tag reserve", () => {
    const ranked = [cl("entity:x", 10), cl("entity:y", 9), cl("entity:z", 8), cl("entity:w", 7), cl("tag:a", 6)];
    expect(selectClustersForRun(ranked, 5).map((c) => c.signature)).toEqual([
      "entity:x",
      "entity:y",
      "entity:z",
      "entity:w",
      "tag:a",
    ]);
  });

  test("few entities → tags backfill the rest", () => {
    const ranked = [cl("entity:x", 10), cl("tag:a", 9), cl("tag:b", 8), cl("tag:c", 7), cl("tag:d", 6)];
    expect(selectClustersForRun(ranked, 5).map((c) => c.signature)).toEqual([
      "entity:x",
      "tag:a",
      "tag:b",
      "tag:c",
      "tag:d",
    ]);
  });

  test("cap 0 → empty; tiny pools never exceed the budget", () => {
    const ranked = [cl("entity:x", 4), cl("tag:a", 4)];
    expect(selectClustersForRun(ranked, 0)).toEqual([]);
    expect(selectClustersForRun(ranked, 5).map((c) => c.signature)).toEqual(["entity:x", "tag:a"]);
  });

  test("reserved tag slots prefer TIGHTER tags over broad mega-buckets (#632)", () => {
    // tag:broad is the largest (50 > soft cap 20) but the LEAST coherent; the
    // reserve must prefer the tighter tag:tight (12) instead.
    const ranked = [
      cl("entity:x", 8),
      cl("tag:broad", 50), // over the soft cap — demoted in the reserve
      cl("tag:tight", 12), // tight, mid-band — preferred for the reserve
    ];
    // cap 2: 1 entity (never starved) + 1 reserved tag → the tight one, not broad.
    expect(selectClustersForRun(ranked, 2).map((c) => c.signature)).toEqual(["entity:x", "tag:tight"]);
  });

  test("entities are never starved when maxClustersPerRun < RESERVED_TAG_SLOTS", () => {
    const ranked = [cl("entity:x", 9), cl("tag:a", 8), cl("tag:b", 7), cl("tag:c", 6)];
    // cap 1 → the single slot goes to the leading entity.
    expect(selectClustersForRun(ranked, 1).map((c) => c.signature)).toEqual(["entity:x"]);
    // cap 2 → 1 entity + 1 tag (entity not crowded out by the 3-slot reserve).
    expect(selectClustersForRun(ranked, 2).map((c) => c.signature)).toEqual(["entity:x", "tag:a"]);
  });
});
