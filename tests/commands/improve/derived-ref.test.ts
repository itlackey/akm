// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.4 — the single keyed-on-ref derived-memory helpers (R12).
 *
 * Every reader resolves a derived memory's parent through this one impl
 * (plan §6): `derivedFrom`-keyed families and bundle-qualified `source:`
 * values resolve consistently.
 */

import { describe, expect, test } from "bun:test";
import {
  isDerivedMemory,
  parseMemoryName,
  parseMemoryRef,
  resolveParentRef,
} from "../../../src/commands/improve/memory/derived-ref";
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
  test("(i) source: parses current refs and returns the conceptId", () => {
    expect(resolveParentRef("child.derived", { source: "memories/parent" })).toBe("memories/parent");
    expect(resolveParentRef("child.derived", { source: "  team//memories/parent  " })).toBe("memories/parent");
    // Retired and non-memory refs are ignored, falling through to the suffix.
    expect(resolveParentRef("child.derived", { source: "memory:parent" })).toBe("memories/child");
    // Non-memory source is ignored, falling through to the next rule.
    expect(resolveParentRef("child.derived", { source: "knowledge/doc.md" })).toBe("memories/child");
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
  test("accepts current memory refs and rejects retired, non-memory, or empty values", () => {
    expect(parseMemoryRef("memories/x")).toBe("memories/x");
    expect(parseMemoryRef(" team//memories/x ")).toBe("memories/x");
    expect(parseMemoryRef("memory:x")).toBeUndefined();
    expect(parseMemoryRef("team//memory:x")).toBeUndefined();
    expect(parseMemoryRef("knowledge/x")).toBeUndefined();
    expect(parseMemoryRef(undefined)).toBeUndefined();
    expect(parseMemoryRef("")).toBeUndefined();
  });
});

describe("parseMemoryName", () => {
  test("accepts the conceptId spelling the current writers actually persist", () => {
    // `akm remember --supersedes` / `akm import --supersedes` call
    // writeSupersededEdge with the write result's `ref`, which is a
    // fully-qualified conceptId. Accepting only `memory:<name>` silently
    // reduced every such edge to nothing, so a superseded memory read back as
    // active during belief analysis.
    expect(parseMemoryName("stash//memories/corrected-note")).toBe("corrected-note");
    expect(parseMemoryName("memories/corrected-note")).toBe("corrected-note");
    expect(parseMemoryName("memories/sub/dir-note")).toBe("sub/dir-note");
  });

  test("still accepts the internal identity spelling written before 0.9.0", () => {
    expect(parseMemoryName("memory:corrected-note")).toBe("corrected-note");
    expect(parseMemoryName("  memory:spaced  ")).toBe("spaced");
  });

  test("rejects non-memory, empty, and unparseable values", () => {
    expect(parseMemoryName("knowledge/x")).toBeUndefined();
    expect(parseMemoryName("memory:")).toBeUndefined();
    expect(parseMemoryName("not a ref at all!!")).toBeUndefined();
    expect(parseMemoryName(undefined)).toBeUndefined();
    expect(parseMemoryName("")).toBeUndefined();
  });
});

describe("DERIVED_SUFFIX", () => {
  test("is the structural .derived marker", () => {
    expect(DERIVED_SUFFIX).toBe(".derived");
  });
});
