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

describe("mergeStashHits — fair score merge", () => {
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

  test("provider hits keep original scores and sort alongside local hits", () => {
    const local = [makeStashHit("local-1", 0.85), makeStashHit("local-2", 0.65), makeStashHit("local-3", 0.4)];
    const additional = [makeStashHit("remote-1", 0.9), makeStashHit("remote-2", 0.5)];

    const result = mergeStashHits(local, additional, 6);

    expect(result).toHaveLength(5);
    // Sorted by score descending — remote-1 (0.9) ranks above local-1 (0.85)
    expect(result[0].name).toBe("remote-1");
    expect(result[0].score).toBe(0.9);
    expect(result[1].name).toBe("local-1");
    expect(result[1].score).toBe(0.85);
    expect(result[2].name).toBe("local-2");
    expect(result[2].score).toBe(0.65);
    expect(result[3].name).toBe("remote-2");
    expect(result[3].score).toBe(0.5);
    expect(result[4].name).toBe("local-3");
    expect(result[4].score).toBe(0.4);
  });

  test("duplicate items: local version wins, provider copy dropped", () => {
    const local = [makeStashHit("shared-item", 0.85), makeStashHit("local-only", 0.6)];
    const additional = [makeStashHit("shared-item", 0.95), makeStashHit("remote-only", 0.7)];

    const result = mergeStashHits(local, additional, 10);

    // shared-item appears once with local score, not duplicated
    expect(result.filter((h) => h.name === "shared-item")).toHaveLength(1);
    expect(result.find((h) => h.name === "shared-item")?.score).toBe(0.85);
    // remote-only keeps its original score and sorts by score
    const remoteOnly = result.find((h) => h.name === "remote-only");
    expect(remoteOnly).toBeDefined();
    expect(remoteOnly?.score).toBe(0.7);
  });

  test("respects limit parameter", () => {
    const local = [makeStashHit("a", 0.03), makeStashHit("b", 0.02)];
    const additional = [makeStashHit("c", 0.5), makeStashHit("d", 0.4)];
    const result = mergeStashHits(local, additional, 2);
    expect(result).toHaveLength(2);
  });

  test("provider hits retain their scores unmodified", () => {
    const local = [makeStashHit("local-1", 0.85)];
    const additional = [makeStashHit("remote-1", 0.7), makeStashHit("remote-2", 0.3)];

    const result = mergeStashHits(local, additional, 10);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("local-1");
    expect(result[0].score).toBe(0.85);
    // Provider scores are preserved exactly
    expect(result[1].name).toBe("remote-1");
    expect(result[1].score).toBe(0.7);
    expect(result[2].name).toBe("remote-2");
    expect(result[2].score).toBe(0.3);
  });

  test("empty localHits: provider hits keep their scores", () => {
    const additional = [makeStashHit("remote-1", 0.8), makeStashHit("remote-2", 0.5)];
    const result = mergeStashHits([], additional, 10);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("remote-1");
    expect(result[0].score).toBe(0.8);
    expect(result[1].name).toBe("remote-2");
    expect(result[1].score).toBe(0.5);
  });
});

// ── mergeSearchHits ─────────────────────────────────────────────────────────

describe("mergeSearchHits — simple concatenation", () => {
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

  test("concatenates local and registry hits", () => {
    const local = [makeStashHit("local-1", 0.85), makeStashHit("local-2", 0.65)];
    const registry = [makeRegistryHit("pkg-1", 0.95), makeRegistryHit("pkg-2", 0.8)];

    const result = mergeSearchHits(local, registry, 10);

    expect(result).toHaveLength(4);
    expect(result[0].name).toBe("local-1");
    expect(result[1].name).toBe("local-2");
    expect(result[2].name).toBe("pkg-1");
    expect(result[3].name).toBe("pkg-2");
  });

  test("respects limit parameter", () => {
    const local = [makeStashHit("a", 0.85), makeStashHit("b", 0.65)];
    const registry = [makeRegistryHit("c", 0.9), makeRegistryHit("d", 0.8)];
    const result = mergeSearchHits(local, registry, 2);
    expect(result).toHaveLength(2);
  });
});
