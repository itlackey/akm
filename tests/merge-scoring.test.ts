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

  test("local hits preserve scores; provider-only hits rank below", () => {
    const local = [makeStashHit("local-1", 0.85), makeStashHit("local-2", 0.65), makeStashHit("local-3", 0.4)];
    const additional = [makeStashHit("remote-1", 95), makeStashHit("remote-2", 80)];

    const result = mergeStashHits(local, additional, 6);

    expect(result).toHaveLength(5);
    // Local hits retain their original scores and rank first
    expect(result[0].name).toBe("local-1");
    expect(result[0].score).toBe(0.85);
    expect(result[1].name).toBe("local-2");
    expect(result[1].score).toBe(0.65);
    expect(result[2].name).toBe("local-3");
    expect(result[2].score).toBe(0.4);
    // Provider-only hits are placed below with reduced scores
    expect(result[3].score!).toBeLessThan(0.4);
    expect(result[4].score!).toBeLessThan(result[3].score!);
  });

  test("duplicate items: local version wins, provider copy dropped", () => {
    const local = [makeStashHit("shared-item", 0.85), makeStashHit("local-only", 0.6)];
    const additional = [makeStashHit("shared-item", 50), makeStashHit("remote-only", 40)];

    const result = mergeStashHits(local, additional, 10);

    // shared-item appears once with local score, not duplicated
    expect(result.filter((h) => h.name === "shared-item")).toHaveLength(1);
    expect(result[0].name).toBe("shared-item");
    expect(result[0].score).toBe(0.85);
    // remote-only ranks below local hits
    expect(result.find((h) => h.name === "remote-only")).toBeDefined();
  });

  test("respects limit parameter", () => {
    const local = [makeStashHit("a", 0.03), makeStashHit("b", 0.02)];
    const additional = [makeStashHit("c", 50), makeStashHit("d", 40)];
    const result = mergeStashHits(local, additional, 2);
    expect(result).toHaveLength(2);
  });

  test("local scores preserved; provider raw scores do not leak through", () => {
    const local = [makeStashHit("local-1", 0.85)];
    const additional = [makeStashHit("remote-1", 4.0), makeStashHit("remote-2", 3.5)];

    const result = mergeStashHits(local, additional, 10);

    // Local hit retains its score
    expect(result[0].name).toBe("local-1");
    expect(result[0].score).toBe(0.85);
    // Provider raw scores (4.0, 3.5) must NOT leak through — they should
    // be reduced to below the local minimum
    for (const hit of result) {
      if (hit.name !== "local-1") {
        expect(hit.score!).toBeLessThan(0.85);
        expect(hit.score).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ── mergeSearchHits ─────────────────────────────────────────────────────────

describe("mergeSearchHits — score-preserving merge", () => {
  test("returns local hits when registryHits is empty", () => {
    const local = [makeStashHit("a", 0.85)];
    const result = mergeSearchHits(local, [], 10);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("a");
    expect(result[0].score).toBe(0.85);
  });

  test("returns registry hits when localHits is empty", () => {
    const registry = [makeRegistryHit("pkg-a", 0.9)];
    const result = mergeSearchHits([], registry, 10);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pkg-a");
  });

  test("local hits preserve scores; registry hits placed below", () => {
    const local = [makeStashHit("local-1", 0.85), makeStashHit("local-2", 0.65)];
    const registry = [makeRegistryHit("pkg-1", 0.95), makeRegistryHit("pkg-2", 0.8)];

    const result = mergeSearchHits(local, registry, 4);

    expect(result).toHaveLength(4);
    // Local hits retain scores and rank first
    expect(result[0].name).toBe("local-1");
    expect(result[0].score).toBe(0.85);
    expect(result[1].name).toBe("local-2");
    expect(result[1].score).toBe(0.65);
    // Registry hits placed below
    expect(result[2].score!).toBeLessThan(0.65);
  });

  test("respects limit parameter", () => {
    const local = [makeStashHit("a", 0.85), makeStashHit("b", 0.65)];
    const registry = [makeRegistryHit("c", 0.9), makeRegistryHit("d", 0.8)];
    const result = mergeSearchHits(local, registry, 2);
    expect(result).toHaveLength(2);
  });

  test("high-score registry hits do not displace local stash hits", () => {
    const local = [makeStashHit("best-local", 0.85), makeStashHit("ok-local", 0.6)];
    const registry = [makeRegistryHit("best-pkg", 100), makeRegistryHit("ok-pkg", 80)];

    const result = mergeSearchHits(local, registry, 4);

    // Local hits should always be in top 2 regardless of registry scores
    expect(result[0].name).toBe("best-local");
    expect(result[1].name).toBe("ok-local");
    // Registry raw scores (100, 80) must not leak through
    for (const hit of result.slice(2)) {
      expect(hit.score!).toBeLessThan(0.6);
    }
  });
});
