import { describe, expect, test } from "bun:test";
import { mergeSearchHits, mergeStashHits } from "../src/stash-search";
import type { RegistrySearchResultHit, StashSearchHit } from "../src/stash-types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStashHit(name: string, score: number): StashSearchHit {
  return {
    type: "script",
    name,
    path: `/stash/scripts/${name}`,
    ref: `script:${name}`,
    score,
  };
}

function makeRegistryHit(name: string, score: number): RegistrySearchResultHit {
  return {
    type: "registry",
    name,
    id: `npm:${name}`,
    description: `${name} package`,
    score,
  };
}

// ── mergeStashHits ──────────────────────────────────────────────────────────

describe("mergeStashHits — RRF merge", () => {
  test("returns local hits when additionalHits is empty", () => {
    const local = [makeStashHit("a", 0.03), makeStashHit("b", 0.02)];
    const result = mergeStashHits(local, [], 10);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
  });

  test("respects limit when additionalHits is empty", () => {
    const local = [makeStashHit("a", 0.03), makeStashHit("b", 0.02), makeStashHit("c", 0.01)];
    const result = mergeStashHits(local, [], 2);
    expect(result).toHaveLength(2);
  });

  test("merges using rank position, not raw scores", () => {
    // Local hits have small RRF-scale scores (0.01-0.03)
    const local = [makeStashHit("local-1", 0.03), makeStashHit("local-2", 0.02), makeStashHit("local-3", 0.01)];
    // Additional hits have large provider-scale scores (0-100)
    const additional = [makeStashHit("remote-1", 95), makeStashHit("remote-2", 80), makeStashHit("remote-3", 50)];

    const result = mergeStashHits(local, additional, 6);

    // With RRF, rank-1 items from both lists should be interleaved fairly.
    // local-1 (rank 0 in local) and remote-1 (rank 0 in additional) both get
    // RRF score of 1/(60+1) = 0.01639... so they should appear near the top.
    // The key property: raw scores should NOT determine order across lists.
    // Without RRF, remote-1 (score 95) would always dominate local-1 (score 0.03).
    expect(result).toHaveLength(6);

    // The top-ranked item from each source should both appear in top 2
    const topNames = result.slice(0, 2).map((h) => h.name);
    expect(topNames).toContain("local-1");
    expect(topNames).toContain("remote-1");
  });

  test("items appearing in both lists get combined RRF score", () => {
    // Same item appears in both lists — should get boosted
    const local = [makeStashHit("shared-item", 0.03), makeStashHit("local-only", 0.02)];
    const additional = [makeStashHit("shared-item", 50), makeStashHit("remote-only", 40)];

    const result = mergeStashHits(local, additional, 10);

    // shared-item should rank first because it appears in both lists (double RRF score)
    expect(result[0].name).toBe("shared-item");
  });

  test("respects limit parameter", () => {
    const local = [makeStashHit("a", 0.03), makeStashHit("b", 0.02)];
    const additional = [makeStashHit("c", 50), makeStashHit("d", 40)];
    const result = mergeStashHits(local, additional, 2);
    expect(result).toHaveLength(2);
  });

  test("merged hits carry RRF scores, not original raw scores", () => {
    // Local hits have tiny RRF-scale scores
    const local = [makeStashHit("local-1", 0.016)];
    // Additional hits have large provider-scale scores (e.g. context-hub scores 4+)
    const additional = [makeStashHit("remote-1", 4.0), makeStashHit("remote-2", 3.5)];

    const result = mergeStashHits(local, additional, 10);

    // All output scores must be RRF-derived (in the range 0-1, typically < 0.05)
    // Raw scores of 4.0 or 3.5 must NOT leak through
    for (const hit of result) {
      expect(hit.score).toBeDefined();
      expect(hit.score).toBeLessThan(1);
      expect(hit.score).toBeGreaterThan(0);
    }
    // Specifically: no hit should have the original raw score
    expect(result.find((h) => h.score === 4.0)).toBeUndefined();
    expect(result.find((h) => h.score === 3.5)).toBeUndefined();
    expect(result.find((h) => h.score === 0.016)).toBeUndefined();
  });
});

// ── mergeSearchHits ─────────────────────────────────────────────────────────

describe("mergeSearchHits — RRF merge", () => {
  test("returns local hits when registryHits is empty", () => {
    const local = [makeStashHit("a", 0.03)];
    const result = mergeSearchHits(local, [], 10);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("a");
  });

  test("returns registry hits when localHits is empty", () => {
    const registry = [makeRegistryHit("pkg-a", 0.9)];
    const result = mergeSearchHits([], registry, 10);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pkg-a");
  });

  test("merges stash and registry hits using rank position", () => {
    const local = [makeStashHit("local-1", 0.03), makeStashHit("local-2", 0.02)];
    const registry = [makeRegistryHit("pkg-1", 0.95), makeRegistryHit("pkg-2", 0.8)];

    const result = mergeSearchHits(local, registry, 4);

    expect(result).toHaveLength(4);
    // Top-ranked from each source should be in top 2
    const topNames = result.slice(0, 2).map((h) => h.name);
    expect(topNames).toContain("local-1");
    expect(topNames).toContain("pkg-1");
  });

  test("respects limit parameter", () => {
    const local = [makeStashHit("a", 0.03), makeStashHit("b", 0.02)];
    const registry = [makeRegistryHit("c", 0.9), makeRegistryHit("d", 0.8)];
    const result = mergeSearchHits(local, registry, 2);
    expect(result).toHaveLength(2);
  });

  test("RRF prevents high-score registry hits from dominating low-score stash hits", () => {
    // Simulate a case where registry scores are on a wildly different scale
    const local = [makeStashHit("best-local", 0.025), makeStashHit("ok-local", 0.015)];
    const registry = [makeRegistryHit("best-pkg", 100), makeRegistryHit("ok-pkg", 80)];

    const result = mergeSearchHits(local, registry, 4);

    // Without RRF, best-pkg (100) and ok-pkg (80) would dominate.
    // With RRF, best-local and best-pkg both have rank-0 RRF scores,
    // so they should both appear in top 2.
    const topNames = result.slice(0, 2).map((h) => h.name);
    expect(topNames).toContain("best-local");
    expect(topNames).toContain("best-pkg");
  });
});
