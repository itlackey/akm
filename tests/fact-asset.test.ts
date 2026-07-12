// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit + integration tests for the `fact` asset type — durable stash-level
 * semantic knowledge (see docs/design/fact-asset-type.md):
 *   - registered through the single-source-of-truth registry, so it appears in
 *     the asset-type union and the renderer/action maps;
 *   - files under facts/ classify + resolve as `fact` (incl. nested category dirs);
 *   - `pinned: true` facts get an additive ranking boost over ordinary facts;
 *   - the fact linter flags a missing/unknown `category`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../src/commands/lint/index";
import { ACTION_BUILDERS, TYPE_TO_RENDERER } from "../src/core/asset/asset-registry";
import {
  deriveCanonicalAssetNameFromStashRoot,
  getAssetTypes,
  isRelevantAssetFile,
  resolveAssetPathFromName,
  TYPE_DIRS,
} from "../src/core/asset/asset-spec";
import { ASSET_TYPE_SET, ASSET_TYPES, isAssetType } from "../src/core/common";
import { generateMetadata, type StashEntry } from "../src/indexer/passes/metadata";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import { applyScoreContributors, type RankingContext } from "../src/indexer/search/ranking-contributors";

const tempDirs: string[] = [];
function makeTempStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fact-"));
  tempDirs.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

describe("fact asset type is registered via the single source of truth", () => {
  test("fact appears in the registry key set and the derived union", () => {
    expect(getAssetTypes()).toContain("fact");
    expect(ASSET_TYPES).toContain("fact");
    expect(ASSET_TYPE_SET.has("fact" as (typeof ASSET_TYPES)[number])).toBe(true);
    expect(isAssetType("fact")).toBe(true);
  });

  test("fact has a stash dir, renderer, and action builder", () => {
    expect(TYPE_DIRS.fact).toBe("facts");
    expect(TYPE_TO_RENDERER.fact).toBe("fact-md");
    expect(typeof ACTION_BUILDERS.fact).toBe("function");
    expect(ACTION_BUILDERS.fact?.("fact:team/tool-stack")).toMatch(/akm show fact:team\/tool-stack/);
  });
});

describe("fact file layout", () => {
  test("markdown files under facts/ are relevant; nested category dirs resolve", () => {
    expect(isRelevantAssetFile("fact", "tool-stack.md")).toBe(true);
    expect(isRelevantAssetFile("fact", "notes.txt")).toBe(false);

    const stashRoot = "/stash";
    const filePath = path.join(stashRoot, "facts", "team", "tool-stack.md");
    const name = deriveCanonicalAssetNameFromStashRoot("fact", stashRoot, filePath);
    expect(name).toBe("team/tool-stack");
  });

  test("resolveAssetPathFromName maps a name back under facts/", () => {
    const p = resolveAssetPathFromName("fact", "/stash/facts", "team/tool-stack");
    expect(p.replace(/\\/g, "/")).toBe("/stash/facts/team/tool-stack.md");
  });
});

describe("pinned facts rank above ordinary facts", () => {
  function factEntry(name: string, pinned: boolean): RankedEntryInput {
    const entry: StashEntry = {
      name,
      type: "fact",
      searchHints: pinned ? ["pinned", "category:team"] : ["category:team"],
    };
    return { id: 1, entry, filePath: `/s/facts/${name}.md`, score: 1, rankingMode: "fts" };
  }
  // A query that matches neither fact name, so only type + pinned boosts differ.
  const ctx = {
    query: "deployment targets",
    queryLower: "deployment targets",
    queryTokens: ["deployment", "targets"],
    graphContext: null,
  } as unknown as RankingContext;

  test("pinned fact ends with a strictly higher score", () => {
    const pinned = factEntry("alpha", true);
    const plain = factEntry("beta", false);
    applyScoreContributors(pinned, ctx);
    applyScoreContributors(plain, ctx);
    expect(pinned.score).toBeGreaterThan(plain.score);
  });
});

describe("fact category is captured into the index entry (SPEC-6)", () => {
  // SPEC-6 (docs/design/stash-conventions-code-spec.md): the `category:`
  // frontmatter key — which already drives resolveStashStandards' prompt
  // injection and the fact linter — must also land on the indexed StashEntry
  // so category-keyed policies (e.g. rank-time handling of convention facts)
  // are implementable at all. Read through a typed accessor so this file
  // compiles before the `category?: string` field lands on StashEntry.
  function entryCategory(entry: StashEntry | undefined): string | undefined {
    return (entry as (StashEntry & { category?: string }) | undefined)?.category;
  }

  test("convention and meta categories land on entry.category; a fact without one stays undefined", async () => {
    const stashRoot = makeTempStash();
    const factsRoot = path.join(stashRoot, "facts");
    const files: Record<string, string> = {
      "conventions/organization.md":
        "---\ncategory: convention\ndescription: house placement rules\n---\n\n# Org\n\nBody.\n",
      "active-projects.md":
        "---\ncategory: meta\ndescription: canonical project slugs\n---\n\n# Projects\n\n- projectA\n",
      "team/tool-stack.md": "---\ndescription: team stack\n---\n\nWe use Bun.\n",
    };
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(factsRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, "utf8");
    }

    const stash = await generateMetadata(
      factsRoot,
      "fact",
      Object.keys(files).map((rel) => path.join(factsRoot, rel)),
    );
    const byName = new Map(stash.entries.map((e) => [e.name, e]));
    expect(byName.size).toBe(3);
    expect(entryCategory(byName.get("conventions/organization"))).toBe("convention");
    expect(entryCategory(byName.get("active-projects"))).toBe("meta");
    // No default is invented — a category-less fact carries no category.
    expect(entryCategory(byName.get("team/tool-stack"))).toBeUndefined();
    cleanup();
  });
});

describe("fact linter flags category problems", () => {
  function writeFact(stashRoot: string, rel: string, body: string): void {
    const full = path.join(stashRoot, "facts", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }

  test("missing category is flagged; valid category is clean", () => {
    const stashRoot = makeTempStash();
    writeFact(stashRoot, "team/no-category.md", "---\ndescription: team stack\n---\n\nWe use Bun.\n");
    writeFact(stashRoot, "team/tool-stack.md", "---\ndescription: team stack\ncategory: team\n---\n\nWe use Bun.\n");

    const result = akmLint({ dir: stashRoot });
    const missing = result.flagged.filter((i) => i.issue === "missing-category");
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toContain("no-category.md");
    cleanup();
  });

  test("unrecognized category is flagged", () => {
    const stashRoot = makeTempStash();
    writeFact(stashRoot, "weird.md", "---\ndescription: x\ncategory: banana\n---\n\nbody\n");
    const result = akmLint({ dir: stashRoot });
    const missing = result.flagged.filter((i) => i.issue === "missing-category");
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("banana");
    cleanup();
  });
});
