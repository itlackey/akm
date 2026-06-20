// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the pinned-fact context assembly (fact asset type, phase 2):
 *   - parsePinnedFact: only `pinned: true`, non-stale facts pass; category +
 *     description are surfaced;
 *   - buildPinnedFactsBlock: deterministic, category-grouped markdown; empty
 *     input → empty string;
 *   - collectPinnedFacts: reads pinned fact files from an injected index,
 *     honoring the `pinned` search-hint pre-filter and the status exclusion.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPinnedFactsBlock, collectPinnedFacts, parsePinnedFact } from "../src/commands/fact/fact-context";
import type { Database } from "../src/storage/database";

const tempDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-factctx-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsePinnedFact", () => {
  test("returns a fact for a pinned entry with category + description", () => {
    const raw = "---\ndescription: our stack\ncategory: team\npinned: true\n---\n\nWe use Bun.\n";
    const fact = parsePinnedFact("team/tool-stack", raw);
    expect(fact).not.toBeNull();
    expect(fact?.ref).toBe("fact:team/tool-stack");
    expect(fact?.category).toBe("team");
    expect(fact?.description).toBe("our stack");
    expect(fact?.body).toBe("We use Bun.");
  });

  test("returns null when not pinned", () => {
    expect(parsePinnedFact("team/x", "---\ncategory: team\n---\n\nbody\n")).toBeNull();
    expect(parsePinnedFact("team/x", "---\ncategory: team\npinned: false\n---\n\nbody\n")).toBeNull();
  });

  test("returns null for excluded statuses (stale/superseded/archived)", () => {
    for (const status of ["stale", "superseded", "archived"]) {
      const raw = `---\ncategory: team\npinned: true\nstatus: ${status}\n---\n\nbody\n`;
      expect(parsePinnedFact("team/x", raw)).toBeNull();
    }
  });

  test("keeps a pinned fact with status active", () => {
    const raw = "---\ncategory: team\npinned: true\nstatus: active\n---\n\nbody\n";
    expect(parsePinnedFact("team/x", raw)).not.toBeNull();
  });
});

describe("buildPinnedFactsBlock", () => {
  test("empty input yields empty string", () => {
    expect(buildPinnedFactsBlock([])).toBe("");
  });

  test("groups by category, sorts deterministically, includes bodies", () => {
    const block = buildPinnedFactsBlock([
      {
        ref: "fact:team/tool-stack",
        name: "team/tool-stack",
        category: "team",
        description: "stack",
        body: "We use Bun.",
      },
      { ref: "fact:personal/identity", name: "personal/identity", category: "personal", body: "Name: Ada" },
    ]);
    expect(block).toContain("## Stash facts");
    expect(block).toContain("### personal");
    expect(block).toContain("### team");
    // personal sorts before team
    expect(block.indexOf("### personal")).toBeLessThan(block.indexOf("### team"));
    expect(block).toContain("- **team/tool-stack — stack**");
    expect(block).toContain("We use Bun.");
    expect(block).toContain("Name: Ada");
  });

  test("facts without a category fall under 'general'", () => {
    const block = buildPinnedFactsBlock([{ ref: "fact:x", name: "x", body: "b" }]);
    expect(block).toContain("### general");
  });
});

describe("collectPinnedFacts (injected index)", () => {
  // Minimal Database stub: getAllEntries(db, "fact") calls db.prepare(sql).all(...),
  // which we make return our crafted rows regardless of SQL.
  function fakeDb(rows: Array<Record<string, unknown>>): Database {
    return { prepare: () => ({ all: () => rows }) } as unknown as Database;
  }
  function row(id: number, name: string, filePath: string, hints: string[]) {
    return {
      id,
      entry_key: name,
      dir_path: path.dirname(filePath),
      file_path: filePath,
      stash_dir: "/stash",
      entry_json: JSON.stringify({ name, type: "fact", searchHints: hints }),
      search_text: "",
    };
  }

  test("reads pinned, non-stale facts and skips the rest", () => {
    const dir = tmp();
    const pinnedPath = path.join(dir, "tool-stack.md");
    const stalePath = path.join(dir, "old.md");
    const plainPath = path.join(dir, "scratch.md");
    fs.writeFileSync(pinnedPath, "---\ncategory: team\npinned: true\n---\n\nWe use Bun.\n");
    fs.writeFileSync(stalePath, "---\ncategory: team\npinned: true\nstatus: stale\n---\n\nold\n");
    fs.writeFileSync(plainPath, "---\ncategory: team\n---\n\nnot pinned\n");

    const db = fakeDb([
      row(1, "team/tool-stack", pinnedPath, ["pinned", "category:team"]),
      row(2, "team/old", stalePath, ["pinned", "category:team"]), // pinned hint but status stale
      row(3, "team/scratch", plainPath, ["category:team"]), // no pinned hint → pre-filtered
    ]);

    const facts = collectPinnedFacts(db);
    expect(facts.map((f) => f.name)).toEqual(["team/tool-stack"]);
    expect(facts[0].body).toBe("We use Bun.");
  });

  test("returns [] when nothing is pinned", () => {
    const db = fakeDb([row(1, "team/x", path.join(tmp(), "x.md"), ["category:team"])]);
    expect(collectPinnedFacts(db)).toEqual([]);
  });
});
