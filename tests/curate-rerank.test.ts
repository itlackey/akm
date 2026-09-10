// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #951 — the "rerank engine kind" curate wiring: an optional cross-encoder
 * rerank pass over `akm curate`'s already-selected candidates.
 *
 * Locks:
 *   - disabled by default: curate's own ranking order is untouched with no
 *     `search.curateRerank` config at all
 *   - enabled + a working endpoint: candidates come back reordered by the
 *     endpoint's relevance scores
 *   - enabled + a failing endpoint (network error): falls back to curate's
 *     own ranking, never throwing
 */
import { afterEach, describe, expect, test } from "bun:test";
import { curateSearchResults } from "../src/commands/read/curate";
import type { SearchResponse, SourceSearchHit } from "../src/sources/types";
import { sandboxXdgConfigHome, writeSandboxConfig } from "./_helpers/sandbox";

const originalFetch = globalThis.fetch;
let restoreConfigEnv: (() => void) | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreConfigEnv?.();
  restoreConfigEnv = undefined;
});

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

describe("curateSearchResults — rerank wiring (#951)", () => {
  test("disabled by default: original ranking order is unchanged", async () => {
    const sb = sandboxXdgConfigHome();
    restoreConfigEnv = sb.cleanup;

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const result = await curateSearchResults("query", searchResponse(HITS), 3);

    expect(called).toBe(false);
    expect(result.items.map((item) => ("ref" in item ? item.ref : undefined))).toEqual([
      "skill/alpha",
      "skill/beta",
      "skill/gamma",
    ]);
  });

  test("enabled + working endpoint: candidates come back reordered by relevance score", async () => {
    const sb = sandboxXdgConfigHome();
    restoreConfigEnv = sb.cleanup;
    writeSandboxConfig({
      search: { curateRerank: { enabled: true, endpoint: "http://localhost:9/rerank", model: "reranker-1" } },
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.1 },
            { index: 1, relevance_score: 0.9 },
            { index: 2, relevance_score: 0.5 },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await curateSearchResults("query", searchResponse(HITS), 3);

    expect(result.items.map((item) => ("ref" in item ? item.ref : undefined))).toEqual([
      "skill/beta",
      "skill/gamma",
      "skill/alpha",
    ]);
  });

  test("enabled + failing endpoint: falls back to curate's own ranking, never throws", async () => {
    const sb = sandboxXdgConfigHome();
    restoreConfigEnv = sb.cleanup;
    writeSandboxConfig({
      search: { curateRerank: { enabled: true, endpoint: "http://localhost:9/rerank" } },
    });

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await curateSearchResults("query", searchResponse(HITS), 3);

    expect(result.items.map((item) => ("ref" in item ? item.ref : undefined))).toEqual([
      "skill/alpha",
      "skill/beta",
      "skill/gamma",
    ]);
  });
});
