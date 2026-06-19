// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #627 — vector-path exclusion (AC1b, semantic-on coverage).
 *
 * REGRESSION GUARD for the round-1 blocker: the default type-exclusion policy
 * was threaded into the FTS path (`searchFts`) and the enumerate path
 * (`getAllEntries`), but NOT into the vector/embedding branch. In
 * `combineSearchScores`, vector-only neighbors (entries that are top-k embedding
 * matches but have NO FTS hit) are re-added straight from `embedScoreMap`,
 * filtered ONLY by `typeFilter` — which is `undefined` on the default ('any')
 * path. With `semanticSearchMode: 'auto'` (the production default) a `session`
 * asset that is a vector neighbor but not an FTS match leaked into default
 * results.
 *
 * The existing search-exclude-sessions.test.ts cases all force
 * `semanticSearchMode: 'off'`, so the semantic-on path was uncovered. This test
 * seeds `embedScoreMap` directly (no embedding provider / network needed) and
 * asserts the vector-only session hit is dropped on the default path but kept
 * when re-included or explicitly typed.
 */

import { describe, expect, test } from "bun:test";
import type { DbSearchResult } from "../../src/indexer/db/db";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { combineSearchScores } from "../../src/indexer/search/ranking";

function entry(name: string, type: string): StashEntry {
  return { name, type, description: `${type} ${name}` };
}

function ftsResult(id: number, name: string, type: string, bm25: number): DbSearchResult {
  return { id, filePath: `/stash/${type}/${name}.md`, entry: entry(name, type), searchText: name, bm25Score: bm25 };
}

describe("#627 combineSearchScores excludes vector-only session neighbors (AC1b semantic path)", () => {
  // Entry registry the vector branch resolves ids against.
  const registry = new Map<number, { entry: StashEntry; filePath: string }>([
    [1, { entry: entry("flux-skill", "skill"), filePath: "/stash/skill/flux-skill.md" }],
    [2, { entry: entry("flux-memory", "memory"), filePath: "/stash/memory/flux-memory.md" }],
    [3, { entry: entry("sess-aaa", "session"), filePath: "/stash/session/sess-aaa.md" }],
  ]);
  const getEntryById = (id: number) => registry.get(id);

  test("session that is a vector-only neighbor (no FTS hit) is dropped when excludeTypes=['session']", () => {
    // FTS matched only the skill — the session and memory are vector-only.
    const ftsScoreMap = new Map([[1, { score: 0.9, result: ftsResult(1, "flux-skill", "skill", -1) }]]);
    // Vector neighbors include the session id (3) with a high cosine score.
    const embedScoreMap = new Map([
      [1, 0.8],
      [2, 0.7],
      [3, 0.95],
    ]);

    const scored = combineSearchScores({
      ftsScoreMap,
      embedScoreMap,
      getEntryById,
      typeFilter: undefined, // default 'any' path
      excludeTypes: ["session"],
    });

    const types = scored.map((s) => s.entry.type);
    expect(types).toContain("skill");
    expect(types).toContain("memory"); // vector-only non-session still kept
    expect(types).not.toContain("session"); // vector-only session LEAK fixed
    expect(scored.some((s) => s.id === 3)).toBe(false);
  });

  test("empty excludeTypes preserves pre-#627 behavior — vector-only session kept", () => {
    const ftsScoreMap = new Map([[1, { score: 0.9, result: ftsResult(1, "flux-skill", "skill", -1) }]]);
    const embedScoreMap = new Map([[3, 0.95]]);

    const scored = combineSearchScores({
      ftsScoreMap,
      embedScoreMap,
      getEntryById,
      typeFilter: undefined,
      excludeTypes: [],
    });

    expect(scored.some((s) => s.id === 3 && s.entry.type === "session")).toBe(true);
  });

  test("excludeTypes is ignored when an FTS hit ALSO matched the session (explicit typeFilter path)", () => {
    // When --type session is supplied, defaultExcludes resolves to [] upstream,
    // so excludeTypes is never set here; the session must survive.
    const ftsScoreMap = new Map([[3, { score: 0.9, result: ftsResult(3, "sess-aaa", "session", -1) }]]);
    const embedScoreMap = new Map([[3, 0.95]]);

    const scored = combineSearchScores({
      ftsScoreMap,
      embedScoreMap,
      getEntryById,
      typeFilter: "session",
      excludeTypes: [],
    });

    expect(scored.some((s) => s.id === 3 && s.entry.type === "session")).toBe(true);
  });

  test("excludeTypes governs multiple types generically (e.g. ['session','wiki'])", () => {
    const reg2 = new Map(registry);
    reg2.set(4, { entry: entry("flux-wiki", "wiki"), filePath: "/stash/wiki/flux-wiki.md" });
    const ftsScoreMap = new Map([[1, { score: 0.9, result: ftsResult(1, "flux-skill", "skill", -1) }]]);
    const embedScoreMap = new Map([
      [3, 0.95],
      [4, 0.9],
    ]);

    const scored = combineSearchScores({
      ftsScoreMap,
      embedScoreMap,
      getEntryById: (id) => reg2.get(id),
      typeFilter: undefined,
      excludeTypes: ["session", "wiki"],
    });

    const types = scored.map((s) => s.entry.type);
    expect(types).not.toContain("session");
    expect(types).not.toContain("wiki");
    expect(types).toContain("skill");
  });
});
