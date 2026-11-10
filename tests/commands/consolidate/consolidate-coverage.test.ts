// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it, test } from "bun:test";
import { isConsolidationEligibleMemoryName } from "../../../src/commands/improve/consolidate";
import {
  COVERAGE_MIN_CONTAINMENT,
  COVERAGE_SHINGLE_WORDS,
  shingleContainment,
  wordShingles,
} from "../../../src/commands/improve/consolidate/coverage";
import { shapeSearchHit, shapeShowOutput } from "../../../src/output/shapes/helpers";

/**
 * #998 — the promote pass's coverage rule, as pure text logic: a memory is
 * covered when at least 30% of its distinct 5-word shingles appear in one
 * knowledge doc. No database, model or network (unit target); the neighbour
 * lookup that feeds it is covered by the integration file of the same name.
 */

const words = (n: number, prefix = "w"): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("wordShingles", () => {
  it("windows lower-cased words in fives, ignoring case, punctuation and markdown", () => {
    const shingles = wordShingles("# Use `Bun` — NOT node: run the tests, then commit.");
    expect([...shingles]).toEqual([
      "use bun not node run",
      "bun not node run the",
      "not node run the tests",
      "node run the tests then",
      "run the tests then commit",
    ]);
  });

  it("yields n - 4 shingles for n distinct words, and none below five words", () => {
    expect(wordShingles(words(4)).size).toBe(0);
    expect(wordShingles(words(5)).size).toBe(1);
    expect(wordShingles(words(12)).size).toBe(12 - (COVERAGE_SHINGLE_WORDS - 1));
    expect(wordShingles("").size).toBe(0);
  });

  it("counts a repeated shingle once", () => {
    expect(wordShingles("a b c d e a b c d e a b c d e").size).toBe(5);
  });

  it("reads non-latin words too", () => {
    expect(wordShingles("один два три четыре пять шесть").size).toBe(2);
  });
});

describe("shingleContainment", () => {
  const memory = wordShingles(words(20));

  it("is 1 when the doc holds the whole memory, however much else it holds", () => {
    expect(shingleContainment(memory, `# A long guide\n\n${words(40, "x")} ${words(20)} ${words(40, "y")}`)).toBe(1);
  });

  it("is 0 for an unrelated doc, and for a memory too short to shingle", () => {
    expect(shingleContainment(memory, words(60, "z"))).toBe(0);
    expect(shingleContainment(wordShingles("too short"), "too short")).toBe(0);
  });

  it("measures the memory's share, not the doc's: a small doc quoted inside a larger memory does not cover it", () => {
    const smallDoc = words(8); // its 4 shingles are all inside the 20-word memory
    expect(shingleContainment(memory, smallDoc)).toBeCloseTo(4 / 16);
    expect(shingleContainment(wordShingles(smallDoc), words(20))).toBe(1);
  });

  it("reaches the 0.3 cut when 5 of the memory's 16 shingles are in the doc, and not with 4", () => {
    expect(shingleContainment(memory, words(8))).toBeLessThan(COVERAGE_MIN_CONTAINMENT); // 4 of 16
    expect(shingleContainment(memory, words(9))).toBeGreaterThanOrEqual(COVERAGE_MIN_CONTAINMENT); // 5 of 16
  });

  it("covers a paraphrase that keeps a third of the wording, which the old 0.5 cut let through", () => {
    expect(COVERAGE_MIN_CONTAINMENT).toBe(0.3);
    expect(shingleContainment(memory, `${words(10)} ${words(30, "p")}`)).toBeCloseTo(6 / 16); // 0.375
  });

  it("is not fooled by reordering: shingles keep word order", () => {
    const reversed = words(20).split(" ").reverse().join(" ");
    expect(shingleContainment(memory, reversed)).toBe(0);
  });
});

describe("isConsolidationEligibleMemoryName", () => {
  it("excludes .derived memories", () => {
    expect(isConsolidationEligibleMemoryName("foo.derived")).toBe(false);
  });
  it("includes normal memories", () => {
    expect(isConsolidationEligibleMemoryName("foo")).toBe(true);
  });
});

/**
 * Wave-2 QA fixes tests — Cluster E (output shapes, remember, info, vault, registry brief).
 *
 * #7  — `akm show` JSON shape always includes path + editable.
 * #28 — `registry search --detail brief` projects name + installRef + score.
 * #35 — (deleted) vault listEntries was removed with the env comment-leak fix.
 *
 * #2 (info sourceProviders) and #20 (remember --description frontmatter) were
 * covered here only by unit-shape-smoke tests; Phase 2 triage moved their
 * real coverage elsewhere (see the deletion notes below) so this file no
 * longer imports `assembleInfo` or `buildMemoryFrontmatter`.
 */

// ── #7: show shape includes path + editable ───────────────────────────────────

describe("shapeShowOutput — path + editable always included (#7)", () => {
  const showResult = {
    type: "skill",
    name: "deploy",
    origin: null,
    action: "akm show skills/deploy",
    description: "Deploy script",
    path: "/home/user/stash/skills/deploy/SKILL.md",
    editable: true,
    editHint: "vim /home/user/stash/skills/deploy/SKILL.md",
    content: "# Deploy\nRun deploy.",
  };

  test("default detail includes path and editable", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "normal");
    expect(out).toHaveProperty("path");
    expect(out).toHaveProperty("editable");
    expect(out.path).toBe("/home/user/stash/skills/deploy/SKILL.md");
    expect(out.editable).toBe(true);
  });

  test("brief detail also includes path and editable", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "brief");
    expect(out).toHaveProperty("path");
    expect(out).toHaveProperty("editable");
  });

  test("full detail includes path, editable, and editHint", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "full") as Record<string, unknown>;
    expect(out).toHaveProperty("path");
    expect(out).toHaveProperty("editable");
    expect(out).toHaveProperty("editHint");
  });

  test("normal detail exposes exact local access information", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "normal");
    expect(out.editable).toBe(true);
    expect(out.path).toBe("/home/user/stash/skills/deploy/SKILL.md");
  });
});

// ── #28: registry brief projects name + installRef + score ───────────────────

describe("shapeSearchHit — registry brief projects name + score (#28)", () => {
  // v1 spec §4.2: registry hits no longer carry the legacy `curated` boolean.
  const registryHit = {
    type: "registry",
    title: "deploy-stash",
    name: "deploy-stash",
    installRef: "npm:@myorg/deploy-stash",
    description: "A deployment stash",
    action: "akm add npm:@myorg/deploy-stash -> then search again",
    score: 0.85,
  };

  test("brief includes name, installRef, score", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "brief");
    expect(out.name).toBeTruthy();
    expect(out.score).toBe(0.85);
    // installRef should be present when it exists
    expect(out.installRef).toBe("npm:@myorg/deploy-stash");
  });

  // D6 (Phase 2 triage): "brief does NOT return empty object for registry
  // hits" was DELETED here — it asserted `Object.keys(out).length > 0` on
  // this same `registryHit` fixture, which `:72-78` above already asserts
  // key-by-key (name/score/installRef individually present).

  test("normal mode keeps description, action, installRef, score (curated removed in v1)", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "normal") as Record<string, unknown>;
    expect(out.description).toBeDefined();
    expect(out.installRef).toBeDefined();
    expect(out.score).toBe(0.85);
    expect(out).not.toHaveProperty("curated");
  });
});

// D4 (Phase 2 triage): the "buildMemoryFrontmatter — description field (#20)"
// describe block (5 tests: included/omitted-absent/omitted-empty/
// omitted-whitespace/special-chars-serialised) was DELETED here. It is
// superseded by tests/remember-unit.test.ts:36-97 ("buildMemoryFrontmatter —
// YAML injection guard"), which actually parses the emitted YAML (this file's
// version only did substring `toContain` checks) and pins the same
// included/omitted-absent/omitted-whitespace/special-chars behavior, plus the
// exact `description: ""` case added there alongside this deletion so the
// omitted-when-empty case is not lost.

// #35's listEntries ({key, comment} pairs) was DELETED with the env
// comment-leak fix: comment text can contain commented-out credentials and no
// production code consumed it. Key-name listing is covered by tests/env.test.ts.

// D5 (Phase 2 triage): the "assembleInfo — sourceProviders populated from
// stashDir (#2)" describe block was DELETED here. Its sole test asserted only
// `typeof assembleInfo === "function"` — its own comment called it a
// signature smoke test. Real coverage now lives in
// tests/integration/info-command.test.ts ("returns sourceProviders from
// config" and, strengthened alongside this deletion, "sourceProviders is
// empty with no configured bundle, and reflects a configured bundle").
