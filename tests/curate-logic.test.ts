import { describe, expect, test } from "bun:test";
import { akmCurate, curateSearchResults } from "../src/commands/read/curate";
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
    bundleDir: "/tmp/stash",
    source: "local",
    hits: [],
    ...overrides,
  };
}

describe("curateSearchResults", () => {
  test("keeps the search order and takes the top `limit` hits", async () => {
    const result = await curateSearchResults(
      "release review",
      searchResponse({
        hits: [
          stashHit({ type: "knowledge", name: "release-guide", ref: "knowledge/release-guide", path: "/tmp/2" }),
          stashHit({ type: "skill", name: "release-playbook", ref: "skills/release-playbook", path: "/tmp/1" }),
          stashHit({ type: "agent", name: "release-reviewer", ref: "agents/release-reviewer", path: "/tmp/4" }),
          stashHit({ type: "command", name: "release-manager", ref: "commands/release-manager", path: "/tmp/3" }),
        ],
      }),
      3,
    );

    expect(result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`))).toEqual([
      "knowledge/release-guide",
      "skills/release-playbook",
      "agents/release-reviewer",
    ]);
  });

  // F3/R-018: `--type` narrows the pool of a search response that was never
  // type-filtered (tests, `searchResponse` fixtures) without reordering it.
  test("--type narrows the candidate pool and keeps the search order", async () => {
    const result = await curateSearchResults(
      "release",
      searchResponse({
        hits: [
          stashHit({ type: "skill", name: "release-review", ref: "skills/release-review", path: "/tmp/1" }),
          stashHit({ type: "command", name: "release-notes", ref: "commands/release-notes", path: "/tmp/2" }),
          stashHit({ type: "command", name: "release-manager", ref: "commands/release-manager", path: "/tmp/3" }),
        ],
      }),
      2,
      "command",
    );

    expect(result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`))).toEqual([
      "commands/release-notes",
      "commands/release-manager",
    ]);
  });

  // F4/R-019 (was "uses registry hits only to fill remaining slots and caps
  // them at two"): the OLD behavior pinned here was the BUG — registry fill
  // was hard-capped at a bare literal `Math.min(2, remaining)` regardless of
  // `--limit`, so a caller asking for `--limit 4` with 1 stash hit and 3
  // registry hits got only 2 registry hits back, silently dropping the
  // third free slot. The fix respects `--limit`: the remaining slots after
  // stash hits ARE the cap, with no separate registry-specific ceiling.
  test("uses registry hits to fill ALL remaining slots up to --limit", async () => {
    const result = await curateSearchResults(
      "deploy",
      searchResponse({
        hits: [
          stashHit({ type: "script", name: "deploy-check", ref: "scripts/deploy-check", path: "/tmp/1", score: 0.8 }),
        ],
        registryHits: [
          registryHit({ name: "deploy-kit-a", id: "reg-a", score: 0.95 }),
          registryHit({ name: "deploy-kit-b", id: "reg-b", score: 0.85 }),
          registryHit({ name: "deploy-kit-c", id: "reg-c", score: 0.75 }),
        ],
      }),
      4,
    );

    expect(result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`))).toEqual([
      "scripts/deploy-check",
      "registry:reg-a",
      "registry:reg-b",
      "registry:reg-c",
    ]);
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
          stashHit({ type: "script", name: "deploy-check", ref: "scripts/deploy-check", path: "/tmp/1", score: 0.9 }),
          stashHit({
            type: "command",
            name: "deploy-release",
            ref: "commands/deploy-release",
            path: "/tmp/2",
            score: 0.8,
          }),
          stashHit({
            type: "knowledge",
            name: "deploy-guide",
            ref: "knowledge/deploy-guide",
            path: "/tmp/3",
            score: 0.7,
          }),
          stashHit({ type: "skill", name: "deploy-skill", ref: "skills/deploy-skill", path: "/tmp/4", score: 0.6 }),
          stashHit({
            type: "agent",
            name: "deploy-reviewer",
            ref: "agents/deploy-reviewer",
            path: "/tmp/5",
            score: 0.5,
          }),
        ],
      }),
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(4);
  });
});
