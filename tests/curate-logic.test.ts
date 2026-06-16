import { describe, expect, test } from "bun:test";
import { akmCurate, curateSearchResults, deriveCurateFallbackQueries, mergeCurateSearchResponses } from "../src/commands/read/curate";
import { UsageError } from "../src/core/errors";
import type { RegistrySearchResultHit, SearchResponse, SourceSearchHit } from "../src/sources/types";

function stashHit(
  overrides: Partial<SourceSearchHit> & Pick<SourceSearchHit, "type" | "name" | "ref" | "path">,
): SourceSearchHit {
  return {
    origin: null,
    ...overrides,
  };
}

function registryHit(
  overrides: Partial<RegistrySearchResultHit> & Pick<RegistrySearchResultHit, "name" | "id">,
): RegistrySearchResultHit {
  return {
    type: "registry",
    ...overrides,
  };
}

function searchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    schemaVersion: 1,
    stashDir: "/tmp/stash",
    source: "stash",
    hits: [],
    ...overrides,
  };
}

describe("deriveCurateFallbackQueries", () => {
  test("drops filler words, dedupes tokens, preserves meaningful short tokens, and caps fallback keywords", () => {
    expect(
      deriveCurateFallbackQueries("How do I deploy to CI/CD with Docker docker release rollback staging prod now"),
    ).toEqual(["deploy", "ci", "cd", "docker", "release", "rollback"]);
  });

  test("allows one-token prompt residue fallback", () => {
    expect(deriveCurateFallbackQueries("the docker")).toEqual(["docker"]);
  });

  test("returns an empty list when the normalized query is already a single usable token", () => {
    expect(deriveCurateFallbackQueries("docker")).toEqual([]);
  });
});

describe("mergeCurateSearchResponses", () => {
  test("keeps the highest-scoring duplicate stash and registry hits and merges warnings", () => {
    const base = searchResponse({
      hits: [stashHit({ type: "skill", name: "docker-homelab", ref: "skill:docker-homelab", path: "/tmp/a", score: 0.3 })],
      registryHits: [registryHit({ name: "docker-kit", id: "reg-1", score: 0.2 })],
      tip: "No phrase results.",
      warnings: ["base warning"],
    });
    const merged = mergeCurateSearchResponses(base, [
      searchResponse({
        hits: [
          stashHit({ type: "skill", name: "docker-homelab", ref: "skill:docker-homelab", path: "/tmp/a", score: 0.9 }),
          stashHit({ type: "script", name: "docker-clean", ref: "script:docker-clean", path: "/tmp/b", score: 0.5 }),
        ],
        registryHits: [registryHit({ name: "docker-kit", id: "reg-1", score: 0.8 })],
        warnings: ["fallback warning"],
      }),
    ]);

    expect(merged.hits.map((hit) => ("ref" in hit ? hit.ref : `registry:${hit.id}`))).toEqual([
      "skill:docker-homelab",
      "script:docker-clean",
    ]);
    expect(merged.registryHits?.map((hit) => [hit.id, hit.score])).toEqual([["reg-1", 0.8]]);
    expect(merged.warnings).toEqual(["base warning", "fallback warning"]);
    expect(merged.tip).toBeUndefined();
  });
});

describe("curateSearchResults", () => {
  test("keeps stronger same-type hits ahead of weak different-type filler", async () => {
    const result = await curateSearchResults(
      "release review",
      searchResponse({
        hits: [
          stashHit({ type: "skill", name: "release-playbook", ref: "skill:release-playbook", path: "/tmp/1", score: 0.99 }),
          stashHit({ type: "knowledge", name: "release-guide", ref: "knowledge:release-guide", path: "/tmp/2", score: 0.8 }),
          stashHit({ type: "command", name: "release-manager", ref: "command:release-manager", path: "/tmp/3", score: 0.15 }),
          stashHit({ type: "agent", name: "release-reviewer", ref: "agent:release-reviewer", path: "/tmp/4", score: 0.05 }),
        ],
      }),
      4,
    );

    expect(result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`))).toEqual([
      "skill:release-playbook",
      "knowledge:release-guide",
    ]);
  });

  test("selectedType bypasses diversification and keeps top hits of that type", async () => {
    const result = await curateSearchResults(
      "release",
      searchResponse({
        hits: [
          stashHit({ type: "command", name: "release-manager", ref: "command:release-manager", path: "/tmp/1", score: 0.9 }),
          stashHit({ type: "command", name: "release-notes", ref: "command:release-notes", path: "/tmp/2", score: 0.7 }),
          stashHit({ type: "skill", name: "release-review", ref: "skill:release-review", path: "/tmp/3", score: 1 }),
        ],
      }),
      2,
      "command",
    );

    expect(result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`))).toEqual([
      "command:release-manager",
      "command:release-notes",
    ]);
  });

  test("uses registry hits only to fill remaining slots and caps them at two", async () => {
    const result = await curateSearchResults(
      "deploy",
      searchResponse({
        hits: [stashHit({ type: "script", name: "deploy-check", ref: "script:deploy-check", path: "/tmp/1", score: 0.8 })],
        registryHits: [
          registryHit({ name: "deploy-kit-a", id: "reg-a", score: 0.95 }),
          registryHit({ name: "deploy-kit-b", id: "reg-b", score: 0.85 }),
          registryHit({ name: "deploy-kit-c", id: "reg-c", score: 0.75 }),
        ],
      }),
      4,
    );

    expect(result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`))).toEqual([
      "script:deploy-check",
      "registry:reg-a",
      "registry:reg-b",
    ]);
  });

  test("collapses broad root/reference families into one top-level result with support refs", async () => {
    const result = await curateSearchResults(
      "docker homelab",
      searchResponse({
        hits: [
          stashHit({ type: "skill", name: "docker-homelab", ref: "skill:docker-homelab", path: "/tmp/1", score: 1 }),
          stashHit({ type: "knowledge", name: "skills/docker-homelab/references/compose", ref: "knowledge:skills/docker-homelab/references/compose", path: "/tmp/2", score: 1 }),
          stashHit({ type: "knowledge", name: "skills/docker-homelab/references/networking", ref: "knowledge:skills/docker-homelab/references/networking", path: "/tmp/3", score: 0.9 }),
        ],
      }),
      4,
    );

    expect(result.items).toHaveLength(1);
    const first = result.items[0] as Record<string, unknown>;
    expect(first.ref).toBe("skill:docker-homelab");
    expect(first.supportRefs).toEqual([
      {
        ref: "knowledge:skills/docker-homelab/references/compose",
        type: "knowledge",
        reason: "Related family asset to inspect next.",
      },
      {
        ref: "knowledge:skills/docker-homelab/references/networking",
        type: "knowledge",
        reason: "Related family asset to inspect next.",
      },
    ]);
  });

  test("keeps the narrow child reference as the top-level family representative", async () => {
    const result = await curateSearchResults(
      "docker compose reference",
      searchResponse({
        hits: [
          stashHit({ type: "skill", name: "docker-homelab", ref: "skill:docker-homelab", path: "/tmp/1", score: 1 }),
          stashHit({ type: "knowledge", name: "skills/docker-homelab/references/compose", ref: "knowledge:skills/docker-homelab/references/compose", path: "/tmp/2", score: 1 }),
        ],
      }),
      4,
    );

    expect(result.items).toHaveLength(1);
    expect((result.items[0] as Record<string, unknown>).ref).toBe("knowledge:skills/docker-homelab/references/compose");
  });
});

describe("akmCurate", () => {
  test("rejects a blank curation query", async () => {
    await expect(akmCurate({ query: "   " })).rejects.toBeInstanceOf(UsageError);
  });

  test("defaults to four curated items when limit is omitted", async () => {
    const result = await akmCurate({
      query: "deploy",
      searchResponse: searchResponse({
        hits: [
          stashHit({ type: "script", name: "deploy-check", ref: "script:deploy-check", path: "/tmp/1", score: 0.9 }),
          stashHit({ type: "command", name: "deploy-release", ref: "command:deploy-release", path: "/tmp/2", score: 0.8 }),
          stashHit({ type: "knowledge", name: "deploy-guide", ref: "knowledge:deploy-guide", path: "/tmp/3", score: 0.7 }),
          stashHit({ type: "skill", name: "deploy-skill", ref: "skill:deploy-skill", path: "/tmp/4", score: 0.6 }),
          stashHit({ type: "agent", name: "deploy-reviewer", ref: "agent:deploy-reviewer", path: "/tmp/5", score: 0.5 }),
        ],
      }),
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(4);
  });
});
