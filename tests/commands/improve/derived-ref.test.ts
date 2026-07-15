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
import {
  DERIVED_SUFFIX,
  isDerivedMemory,
  parseMemoryRef,
  resolveParentRef,
} from "../../../src/commands/improve/memory/derived-ref";

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
  test("(i) source: normalises whitespace and origin (producer widening)", () => {
    // Plain memory source.
    expect(resolveParentRef("child.derived", { source: "memory:parent" })).toBe("memory:parent");
    // Leading/trailing whitespace — the old producer's raw startsWith() dropped this.
    expect(resolveParentRef("child.derived", { source: "  memory:parent  " })).toBe("memory:parent");
    // Origin prefix — normalised away to the canonical memory ref.
    expect(resolveParentRef("child.derived", { source: "team//memory:parent" })).toBe("memory:parent");
    // Non-memory source is ignored, falling through to the next rule.
    expect(resolveParentRef("child.derived", { source: "knowledge:doc.md" })).toBe("memory:child");
  });

  test("(ii) derivedFrom: resolves the parent even without a suffix (producer widening)", () => {
    // No .derived suffix, no source — the old producer copy returned undefined
    // here and the family never reached contradiction detection.
    expect(resolveParentRef("child", { derivedFrom: "parent" })).toBe("memory:parent");
  });

  test("(iii) .derived suffix strip, including nested names", () => {
    expect(resolveParentRef("auth-tips.derived", {})).toBe("memory:auth-tips");
    expect(resolveParentRef("nested/foo.derived", {})).toBe("memory:nested/foo");
  });

  test("returns undefined when nothing resolves a parent", () => {
    expect(resolveParentRef("plain", {})).toBeUndefined();
    expect(resolveParentRef("plain", { source: "  " })).toBeUndefined();
  });

  test("derivedFrom wins over the suffix — the alignment that fixes producer/consumer disagreement", () => {
    // The consumer already prioritised derivedFrom over the suffix; the old
    // producer copy (suffix-only) would have resolved memory:foo here. Sharing
    // one impl makes both resolve memory:bar.
    expect(resolveParentRef("foo.derived", { derivedFrom: "bar" })).toBe("memory:bar");
  });
});

describe("parseMemoryRef", () => {
  test("normalises a memory ref and rejects non-memory / empty inputs", () => {
    expect(parseMemoryRef("memory:x")).toBe("memory:x");
    expect(parseMemoryRef("  team//memory:x ")).toBe("memory:x");
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
