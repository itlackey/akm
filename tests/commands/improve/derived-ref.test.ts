// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.4 — the single keyed-on-ref derived-memory helpers (R12).
 *
 * Pins producer/consumer agreement: both `memory-improve.ts` (consumer) and
 * `memory-contradiction-detect.ts` (producer) now resolve a derived memory's
 * parent through this one impl, so they cannot disagree (plan §6). The suite
 * also pins the INTENDED producer-side widening — `derivedFrom`-keyed families
 * and normalised (whitespace/origin) `source:` values now resolve a parent that
 * the old producer copy silently dropped.
 */

import { describe, expect, test } from "bun:test";
import { isDerivedMemory, parseMemoryRef, resolveParentRef } from "../../../src/commands/improve/memory/derived-ref";
import { DERIVED_SUFFIX } from "../../../src/core/recognition-util";

describe("isDerivedMemory", () => {
  test("true for the .derived name suffix", () => {
    expect(isDerivedMemory("auth-tips.derived", {})).toBe(true);
  });
  test("true for inferred: true regardless of name", () => {
    expect(isDerivedMemory("auth-tips.derived2", { inferred: true })).toBe(true);
    expect(isDerivedMemory("plain", { inferred: true })).toBe(true);
  });
  test("false for a plain, non-inferred memory", () => {
    expect(isDerivedMemory("plain", {})).toBe(false);
    expect(isDerivedMemory("plain", { inferred: false })).toBe(false);
  });
});

describe("resolveParentRef — precedence source → derivedFrom → suffix", () => {
  // Group-C item 2: the NORMALISED output is the 0.9.0 `memories/<name>`
  // conceptId, while READ tolerance stays dual-grammar — a legacy
  // `source: memory:<name>` on un-migrated disk still resolves.
  test("(i) source: normalises whitespace and origin, output is the conceptId", () => {
    // Legacy `memory:<name>` input → flipped `memories/<name>` output.
    expect(resolveParentRef("child.derived", { source: "memory:parent" })).toBe("memories/parent");
    // Leading/trailing whitespace — the old producer's raw startsWith() dropped this.
    expect(resolveParentRef("child.derived", { source: "  memory:parent  " })).toBe("memories/parent");
    // Origin prefix — normalised away to the canonical conceptId.
    expect(resolveParentRef("child.derived", { source: "team//memory:parent" })).toBe("memories/parent");
    // New-grammar `memories/<name>` input is tolerated too (post-migration disk).
    expect(resolveParentRef("child.derived", { source: "memories/parent" })).toBe("memories/parent");
    // Non-memory source is ignored, falling through to the next rule.
    expect(resolveParentRef("child.derived", { source: "knowledge:doc.md" })).toBe("memories/child");
  });

  test("(ii) derivedFrom: resolves the parent even without a suffix (producer widening)", () => {
    // No .derived suffix, no source — the old producer copy returned undefined
    // here and the family never reached contradiction detection.
    expect(resolveParentRef("child", { derivedFrom: "parent" })).toBe("memories/parent");
  });

  test("(iii) .derived suffix strip, including nested names", () => {
    expect(resolveParentRef("auth-tips.derived", {})).toBe("memories/auth-tips");
    expect(resolveParentRef("nested/foo.derived", {})).toBe("memories/nested/foo");
  });

  test("returns undefined when nothing resolves a parent", () => {
    expect(resolveParentRef("plain", {})).toBeUndefined();
    expect(resolveParentRef("plain", { source: "  " })).toBeUndefined();
  });

  test("derivedFrom wins over the suffix — the alignment that fixes producer/consumer disagreement", () => {
    // The consumer already prioritised derivedFrom over the suffix; the old
    // producer copy (suffix-only) would have resolved the `foo` parent here.
    // Sharing one impl makes both resolve `memories/bar`.
    expect(resolveParentRef("foo.derived", { derivedFrom: "bar" })).toBe("memories/bar");
  });
});

describe("parseMemoryRef", () => {
  test("normalises to the memories/ conceptId, tolerant of both grammars, rejects non-memory/empty", () => {
    // Legacy input → flipped conceptId output (Group-C item 2).
    expect(parseMemoryRef("memory:x")).toBe("memories/x");
    expect(parseMemoryRef("  team//memory:x ")).toBe("memories/x");
    // New-grammar input is accepted and returned canonicalised.
    expect(parseMemoryRef("memories/x")).toBe("memories/x");
    expect(parseMemoryRef("knowledge:x")).toBeUndefined();
    expect(parseMemoryRef(undefined)).toBeUndefined();
    expect(parseMemoryRef("")).toBeUndefined();
  });
});

describe("DERIVED_SUFFIX", () => {
  test("is the structural .derived marker", () => {
    expect(DERIVED_SUFFIX).toBe(".derived");
  });
});
