// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #632 + #633 — recombine clustering tuning + confirmation-loop fix (RED).
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
 * These tests assert the NEW behaviour; until the feature lands they are
 * expected to FAIL (the #632 ones reference an unimplemented knob; the #633 one
 * watches the streak reset to 1 each run instead of accumulating).
 *
 * #632 cases drive the PURE `buildRelatednessClusters` function with synthetic
 * entries (no index / DB / LLM). #633 drives the full `akmRecombine` pass with
 * an injected LLM seam and the sandbox-pinned state.db. UNIT-tier: no Bun.spawn
 * / Bun.serve / 60s timeout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmRecombine, buildRelatednessClusters } from "../src/commands/improve/recombine";
import { listProposals } from "../src/commands/proposal/validators/proposals";
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
      maxClustersPerRun: 5,
      relatednessSource: "tags",
      // NEW knob — does not exist yet; intentional RED.
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

    const clusters = buildRelatednessClusters(entries, {
      minClusterSize: 3,
      maxClustersPerRun: 1,
      relatednessSource: "tags",
      maxClusterSize: 4,
    } as Parameters<typeof buildRelatednessClusters>[1]);

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
      maxClustersPerRun: 5,
      relatednessSource: "tags",
      // NEW knob — does not exist yet; intentional RED.
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
      maxClustersPerRun: 2,
      relatednessSource: "tags" as const,
    };

    // The pre-#632 behaviour: largest-first, then slice(0, maxClustersPerRun).
    // alpha(4) wins; beta vs gamma tie at 3 → broken by signature ascending →
    // "tag:beta" before "tag:gamma". So the top-2 are alpha + beta.
    const result = buildRelatednessClusters(entries, opts);
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
