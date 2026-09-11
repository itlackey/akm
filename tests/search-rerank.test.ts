// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The cross-encoder rerank pass (#951), moved from `akm curate` to `akm
 * search` per the owner's direction (rerank was meant for search, not
 * curate).
 *
 * Locks:
 *   - `akmSearch` with `source: "local"`, rerank enabled, and a working
 *     endpoint: hits come back in the endpoint's relevance order.
 *   - `akmSearch` with a failing/misconfigured endpoint: the endpoint IS
 *     attempted (proving the gate is wired, not merely absent), but any
 *     failure falls back to the unreranked ranking, never throwing.
 *   - `akmSearch` with `source: "registry"`: the rerank endpoint is never
 *     called (registry results stay separate — locked contract, AGENTS.md —
 *     and a registry-only search must not pay for a wasted HTTP request).
 *   - `curateSearchResults` no longer calls the reranker at all, even under
 *     the OLD `search.curateRerank` key #951 originally shipped under in
 *     0.9.15 — curate's rerank wiring is gone, not merely renamed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { curateSearchResults } from "../src/commands/read/curate";
import { akmSearch } from "../src/commands/read/search";
import { akmIndex } from "../src/indexer/indexer";
import type { SearchResponse, SourceSearchHit } from "../src/sources/types";
import { withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const TIMEOUT_MS = 20_000;
const TOKEN = "rerankmoveprobe";

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

/** Write a skill asset whose name/description match TOKEN, distinguishable by suffix. */
function writeSkill(stashDir: string, suffix: string): string {
  const name = `${TOKEN}-${suffix}`;
  const filePath = path.join(stashDir, "skills", name, "SKILL.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: A ${TOKEN} skill variant ${suffix}.\n---\n\n# ${name}\n\nHandles ${TOKEN} tasks (${suffix}).\n`,
    "utf8",
  );
  return `skills/${name}`;
}

async function buildIndexedStash(): Promise<string> {
  const stash = isolatedStash();
  writeSkill(stash, "alpha");
  writeSkill(stash, "beta");
  writeSkill(stash, "gamma");
  writeSandboxConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir: stash, full: true });
  return stash;
}

/** Mock fetch that counts calls and lets the test supply the response/behavior. */
function installMockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): { calls: () => number } {
  let count = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    count++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return { calls: () => count };
}

describe("akmSearch — rerank pass moved from curate (#951)", () => {
  test(
    "source: local, rerank enabled + working endpoint: hits come back in the endpoint's order",
    async () => {
      await buildIndexedStash();

      // Baseline: rerank not configured at all.
      const baseline = await akmSearch({ query: TOKEN, source: "local", skipLogging: true });
      const baselineRefs = baseline.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.ref);
      expect(baselineRefs.length).toBe(3);

      writeSandboxConfig({
        search: { rerank: { enabled: true, endpoint: "http://localhost:9/rerank", model: "reranker-1" } },
      });
      const mock = installMockFetch(async () => {
        // Reverse whatever order search handed the reranker: document i gets
        // relevance i, so the highest index (search's weakest hit) wins.
        return new Response(
          JSON.stringify({
            results: [0, 1, 2].map((i) => ({ index: i, relevance_score: i })),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      });

      const reranked = await akmSearch({ query: TOKEN, source: "local", skipLogging: true });
      const rerankedRefs = reranked.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.ref);

      expect(mock.calls()).toBe(1);
      expect(rerankedRefs).toEqual([...baselineRefs].reverse());
      expect(rerankedRefs).not.toEqual(baselineRefs);
    },
    TIMEOUT_MS,
  );

  test(
    "source: local, rerank enabled + failing endpoint: the endpoint is attempted but a failure falls back to the unreranked ranking without throwing",
    async () => {
      await buildIndexedStash();

      const baseline = await akmSearch({ query: TOKEN, source: "local", skipLogging: true });
      const baselineRefs = baseline.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.ref);
      expect(baselineRefs.length).toBe(3);

      writeSandboxConfig({
        search: { rerank: { enabled: true, endpoint: "http://localhost:9/rerank" } },
      });
      const mock = installMockFetch(async () => {
        throw new Error("connection refused");
      });

      const result = await akmSearch({ query: TOKEN, source: "local", skipLogging: true });
      const refs = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry").map((h) => h.ref);

      // The endpoint really was attempted (this is a fallback, not an absence).
      expect(mock.calls()).toBeGreaterThan(0);
      expect(refs).toEqual(baselineRefs);
    },
    TIMEOUT_MS,
  );

  test(
    "source: registry never calls the rerank endpoint",
    async () => {
      await buildIndexedStash();
      writeSandboxConfig({
        // No registries configured — isolates this from the default
        // `akm-registry` provider (a real network fetch of its own) so any
        // call the mock observes can only be the rerank endpoint.
        registries: [],
        search: { rerank: { enabled: true, endpoint: "http://localhost:9/rerank" } },
      });
      const mock = installMockFetch(async () => new Response(JSON.stringify({ results: [] })));

      const result = await akmSearch({ query: TOKEN, source: "registry", skipLogging: true });

      expect(result.hits.length).toBe(0);
      expect(mock.calls()).toBe(0);
    },
    TIMEOUT_MS,
  );
});

describe("curateSearchResults — no longer reranks (#951 moved to search)", () => {
  function stashHit(
    overrides: Partial<SourceSearchHit> & Pick<SourceSearchHit, "type" | "name" | "ref" | "path">,
  ): SourceSearchHit {
    return { origin: null, ...overrides };
  }

  function searchResponse(hits: SourceSearchHit[]): SearchResponse {
    return { schemaVersion: 1, bundleDir: "/tmp/stash", source: "local", hits };
  }

  const HITS: SourceSearchHit[] = [
    stashHit({ type: "skill", name: "alpha", ref: "skill/alpha", path: "skill/alpha.md", description: "first" }),
    stashHit({ type: "skill", name: "beta", ref: "skill/beta", path: "skill/beta.md", description: "second" }),
    stashHit({ type: "skill", name: "gamma", ref: "skill/gamma", path: "skill/gamma.md", description: "third" }),
  ];

  test("even under the OLD search.curateRerank key, curate never calls the endpoint", async () => {
    const iso = withIsolatedAkmStorage();
    cleanups.push(iso.cleanup);
    // The exact key `akm curate`'s rerank pass historically read
    // (`search.curateRerank`, 0.9.15/#951) — proves curate has no rerank
    // wiring left at all, not merely that it stopped recognizing a renamed key.
    writeSandboxConfig({
      search: { curateRerank: { enabled: true, endpoint: "http://localhost:9/rerank" } },
    });
    const mock = installMockFetch(
      async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }] })),
    );

    const result = await curateSearchResults("query", searchResponse(HITS), 3);

    expect(mock.calls()).toBe(0);
    expect(result.items.map((item) => ("ref" in item ? item.ref : undefined))).toEqual([
      "skill/alpha",
      "skill/beta",
      "skill/gamma",
    ]);
  });
});
