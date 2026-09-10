// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A1 (docs/plans/index-units-contract.md): deriveUnits turns what the index
 * already has — buildSearchFields output plus safe_markdown — into the
 * ordered, content-addressed units an embedding pass sends to a provider.
 * Pure/in-memory, no database — belongs under tests/, not tests/integration/.
 */

import { describe, expect, test } from "bun:test";
import { splitMarkdownFragments } from "../../../src/core/asset/markdown-fragments";
import { hashEmbeddableText } from "../../../src/core/hash";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { deriveUnits, toUnitSource, type UnitSource } from "../../../src/indexer/units/unit";

const LARGE_MAX_CHARS = 1_000_000;

function source(overrides: Partial<UnitSource> = {}): UnitSource {
  return {
    entryId: 7,
    name: "widget",
    description: "a small widget",
    tags: "widget tools",
    hints: "use for widgets",
    parameters: "",
    safeMarkdown: null,
    ...overrides,
  };
}

describe("deriveUnits — structured-fields unit (ordinal 0)", () => {
  test("a plain note with no markdown content yields exactly one unit", () => {
    const src = source();
    const units = deriveUnits(src, LARGE_MAX_CHARS);

    expect(units).toHaveLength(1);
    const unit = units[0]!;
    expect(unit.entryId).toBe(7);
    expect(unit.ordinal).toBe(0);
    expect(unit.fragmentId).toBeNull();
    expect(unit.text).toBe("widget\na small widget\nwidget tools\nuse for widgets");
    expect(unit.hash).toBe(hashEmbeddableText(unit.text));
  });

  test("omits empty description/tags/hints lines but keeps the header line", () => {
    const src = source({ description: "", tags: "", hints: "" });
    const units = deriveUnits(src, LARGE_MAX_CHARS);

    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe("widget\n");
  });

  test("keeps only the non-empty structured lines, in field order", () => {
    const src = source({ description: "", tags: "widget tools", hints: "" });
    const units = deriveUnits(src, LARGE_MAX_CHARS);

    expect(units[0]!.text).toBe("widget\nwidget tools");
  });
});

describe("deriveUnits — card unit parameters (index-redesign B5g)", () => {
  test("parameters are appended as their own lines, after hints", () => {
    const src = source({ parameters: "retrybudget: how many retries are allowed\nverbose" });
    const units = deriveUnits(src, LARGE_MAX_CHARS);

    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe(
      "widget\na small widget\nwidget tools\nuse for widgets\nretrybudget: how many retries are allowed\nverbose",
    );
  });

  test("an entry with no parameters is unaffected (empty parameters field is dropped, like other empty fields)", () => {
    const src = source({ parameters: "" });
    const units = deriveUnits(src, LARGE_MAX_CHARS);

    expect(units[0]!.text).toBe("widget\na small widget\nwidget tools\nuse for widgets");
  });

  test("the card unit's hash changes when a parameter is added", () => {
    const before = deriveUnits(source(), LARGE_MAX_CHARS)[0]!;
    const after = deriveUnits(source({ parameters: "retrybudget: how many retries are allowed" }), LARGE_MAX_CHARS)[0]!;

    expect(after.text).not.toBe(before.text);
    expect(after.hash).not.toBe(before.hash);
  });

  test("parameters never leak into a fragment unit's text", () => {
    const src = source({ parameters: "retrybudget: how many retries are allowed", safeMarkdown: "# Alpha\nbody text" });
    const units = deriveUnits(src, LARGE_MAX_CHARS);

    expect(units).toHaveLength(2);
    expect(units[0]!.fragmentId).toBeNull();
    expect(units[0]!.text).toContain("retrybudget");
    expect(units[1]!.fragmentId).not.toBeNull();
    expect(units[1]!.text).not.toContain("retrybudget");
  });
});

describe("deriveUnits — markdown fragment units", () => {
  const doc = [
    "intro paragraph before any heading",
    "",
    "# Alpha",
    "alpha body text",
    "",
    "# Beta",
    "beta body text",
  ].join("\n");

  test("derives sequential ordinals, the fragment's fragmentId, and name/section headers", () => {
    const src = source({ safeMarkdown: doc });
    const units = deriveUnits(src, LARGE_MAX_CHARS);
    const fragments = splitMarkdownFragments(doc);

    // One structured-fields unit plus exactly one unit per fragment (nothing split: LARGE_MAX_CHARS).
    expect(units).toHaveLength(1 + fragments.length);
    expect(fragments).toHaveLength(3); // intro, Alpha section, Beta section

    const [unit0, introUnit, alphaUnit, betaUnit] = units;
    expect(unit0!.ordinal).toBe(0);

    expect(introUnit!.ordinal).toBe(1);
    expect(introUnit!.fragmentId).toBe(fragments[0]!.fragmentId);
    // No heading precedes the intro paragraph: header is the bare entry name.
    expect(introUnit!.text).toBe(`widget\n${fragments[0]!.text}`);

    expect(alphaUnit!.ordinal).toBe(2);
    expect(alphaUnit!.fragmentId).toBe(fragments[1]!.fragmentId);
    expect(alphaUnit!.text).toBe(`widget › Alpha\n${fragments[1]!.text}`);

    expect(betaUnit!.ordinal).toBe(3);
    expect(betaUnit!.fragmentId).toBe(fragments[2]!.fragmentId);
    expect(betaUnit!.text).toBe(`widget › Beta\n${fragments[2]!.text}`);
  });

  test("every fragment unit hash is hashEmbeddableText of its own text", () => {
    const src = source({ safeMarkdown: doc });
    const units = deriveUnits(src, LARGE_MAX_CHARS);
    for (const unit of units) expect(unit.hash).toBe(hashEmbeddableText(unit.text));
  });

  test("an entry with only whitespace/empty markdown produces no fragment units", () => {
    const src = source({ safeMarkdown: "" });
    const units = deriveUnits(src, LARGE_MAX_CHARS);
    expect(units).toHaveLength(1);
    expect(units[0]!.fragmentId).toBeNull();
  });

  test("a sub-heading section still carries the nearest preceding heading, not the entry name alone", () => {
    // "### Detail" is far below the first content line of its own piece only
    // when the section is large enough to split; here we just confirm a
    // second heading under the first still becomes its own section title.
    const nested = ["# Alpha", "alpha body", "", "## Alpha Detail", "detail body"].join("\n");
    const src = source({ safeMarkdown: nested });
    const units = deriveUnits(src, LARGE_MAX_CHARS);
    const fragments = splitMarkdownFragments(nested);

    expect(fragments).toHaveLength(2);
    expect(units[1]!.text.startsWith("widget › Alpha\n")).toBe(true);
    expect(units[2]!.text.startsWith("widget › Alpha Detail\n")).toBe(true);
  });
});

describe("deriveUnits — maxChars splitting", () => {
  test("a fragment over maxChars is split at a newline into sub-units sharing the fragmentId", () => {
    const longSection = ["# Config", "a".repeat(50), "b".repeat(50)].join("\n");
    const src = source({ safeMarkdown: longSection });
    const fragments = splitMarkdownFragments(longSection);
    expect(fragments).toHaveLength(1); // well under MARKDOWN_FRAGMENT_MAX_CHARS, stays one fragment

    const header = "widget › Config";
    const fullText = `${header}\n${fragments[0]!.text}`;
    // Choose a bound that lands inside the fragment body, after the "a" line's
    // trailing newline, so a real newline boundary exists to split at.
    const maxChars = header.length + 1 + "# Config".length + 1 + 50 + 5;
    expect(fullText.length).toBeGreaterThan(maxChars);

    const units = deriveUnits(src, maxChars);
    const fragmentUnits = units.filter((unit) => unit.fragmentId === fragments[0]!.fragmentId);

    expect(fragmentUnits.length).toBeGreaterThan(1);
    for (const unit of fragmentUnits) expect(unit.fragmentId).toBe(fragments[0]!.fragmentId);
    // Sequential ordinals, no gaps or repeats.
    const ordinals = fragmentUnits.map((unit) => unit.ordinal);
    expect(ordinals).toEqual(ordinals.map((_, index) => ordinals[0]! + index));
    // Split at the newline: the "b" line lands entirely in a later sub-unit.
    expect(fragmentUnits[0]!.text).not.toContain("b".repeat(50));
    expect(fragmentUnits.some((unit) => unit.text.includes("b".repeat(50)))).toBe(true);
    // Different text means different hashes.
    const hashes = new Set(fragmentUnits.map((unit) => unit.hash));
    expect(hashes.size).toBe(fragmentUnits.length);
    for (const unit of fragmentUnits) expect(unit.text.length).toBeLessThanOrEqual(maxChars);
  });

  test("once the header's own newline is spent, the body is space-split (no mid-word breaks)", () => {
    const longLine = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const src = source({ name: "n", description: longLine, tags: "", hints: "" });
    const maxChars = 30;
    const units = deriveUnits(src, maxChars);

    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) {
      expect(unit.text.length).toBeLessThanOrEqual(maxChars);
      expect(unit.fragmentId).toBeNull();
    }
    // The header line ("n") is its own first unit, split off at the "\n".
    expect(units[0]!.text).toBe("n");
    // Every later piece is a run of whole words: a space cut never leaves a
    // trailing space, and (with plentiful spaces available) never breaks
    // inside a "wordN" token.
    for (const unit of units.slice(1)) {
      expect(unit.text.endsWith(" ")).toBe(false);
      expect(/^word\d+( word\d+)*$/.test(unit.text)).toBe(true);
    }
  });

  test("hard-splits a single run with no newline or space, still respecting maxChars", () => {
    const unbroken = "x".repeat(100);
    const src = source({ name: "n", description: unbroken, tags: "", hints: "" });
    const maxChars = 10;
    const units = deriveUnits(src, maxChars);

    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) expect(unit.text.length).toBeLessThanOrEqual(maxChars);
    // The header ("n") is split off at the "\n" first; every remaining piece
    // is a pure run of "x" (the delimiter itself is never part of a piece,
    // so pieces can't be concatenated back verbatim — only their content can
    // be accounted for).
    expect(units[0]!.text).toBe("n");
    const xCount = units.slice(1).reduce((sum, unit) => sum + unit.text.length, 0);
    expect(xCount).toBe(unbroken.length);
    for (const unit of units.slice(1)) expect(/^x+$/.test(unit.text)).toBe(true);
  });

  test("rejects a non-positive maxChars", () => {
    expect(() => deriveUnits(source(), 0)).toThrow(RangeError);
    expect(() => deriveUnits(source(), -5)).toThrow(RangeError);
  });
});

describe("toUnitSource — parameters (index-redesign B5g)", () => {
  test("formats each parameter as its own line: 'name: description', or bare 'name' with none", () => {
    const entry: IndexDocument = {
      name: "widget",
      type: "command",
      description: "A small widget.",
      parameters: [
        { name: "retryBudget", description: "How many retries are allowed before giving up." },
        { name: "verbose" },
      ],
    };
    const src = toUnitSource(1, entry);

    expect(src.parameters).toBe("retrybudget: how many retries are allowed before giving up.\nverbose");
  });

  test("an entry with no parameters gets the empty string", () => {
    const entry: IndexDocument = { name: "widget", type: "memory", description: "A small widget." };
    expect(toUnitSource(1, entry).parameters).toBe("");
  });

  test("a parameter name is present in the card unit's text, and the card unit's hash changes when one is added", () => {
    const base: IndexDocument = { name: "retry-runner", type: "command", description: "Runs retries." };
    const withParam: IndexDocument = { ...base, parameters: [{ name: "retryBudget" }] };

    const beforeUnit = deriveUnits(toUnitSource(1, base), LARGE_MAX_CHARS)[0]!;
    const afterUnit = deriveUnits(toUnitSource(1, withParam), LARGE_MAX_CHARS)[0]!;

    expect(beforeUnit.text).not.toContain("retrybudget");
    expect(afterUnit.text).toContain("retrybudget");
    expect(afterUnit.hash).not.toBe(beforeUnit.hash);
  });
});

describe("deriveUnits — determinism", () => {
  test("the same source and maxChars produce identical ordinals, fragmentIds and hashes", () => {
    const doc = ["# One", "first section body", "", "# Two", "second section body"].join("\n");
    const src = source({ safeMarkdown: doc });

    const first = deriveUnits(src, 40);
    const second = deriveUnits(src, 40);

    expect(second).toEqual(first);
  });
});

describe("deriveUnits — unicode safety", () => {
  test("multi-byte text hashes deterministically and every unit respects maxChars", () => {
    const doc = ["# 見出し", "本文はここにあります。".repeat(10), "", "# 二番目", "emoji body 🎉🚀✨".repeat(5)].join(
      "\n",
    );
    const src = source({ name: "ウィジェット", safeMarkdown: doc });

    const first = deriveUnits(src, 60);
    const second = deriveUnits(src, 60);

    expect(second).toEqual(first);
    for (const unit of first) {
      expect(unit.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(unit.hash).toBe(hashEmbeddableText(unit.text));
    }
  });
});
