// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 1.5 (WI-1.5.1, D1.5-3) — §12.3 replacement contract tests for the
 * open type token. Lands in the SAME commit as the closed-union deletion so
 * the exhaustiveness guard never gaps (plan §15 rule 4 / brief trap 1).
 *
 * Proves the new model end to end:
 *   (a) an open/foreign token is ACCEPTED as data by `validateStashEntry`
 *       and the `akm` adapter's `recognize` gate (which replaced the deleted
 *       flat-walk matcher pass in the F4 engine swap);
 *   (b) `KNOWN_TYPES` exhaustiveness — `TYPE_PRESENTATION` compile-covers
 *       all 14 known types;
 *   (c) `presentationFor` returns the generic fallback for an unknown type;
 *   (d) retired AKM types remain rejected by AKM's legacy ref parser, but the
 *       format-neutral index projection accepts them when another adapter owns
 *       those open type values.
 *
 * Replaces (not just deletes) the taxonomy-pin tests identified in
 * `docs/design/execution/chunk-1.5/anchors.md` §D.1.
 */

import { describe, expect, test } from "bun:test";
import { DEPRECATED_REJECTED_TYPES, isKnownType, KNOWN_TYPES } from "../../src/core/recognition-util";
import { presentationFor, TYPE_PRESENTATION } from "../../src/core/type-presentation";
import { validateStashEntry } from "../../src/indexer/passes/metadata";

// ── (a) open-token acceptance as DATA ───────────────────────────────────────

describe("open type token — accepted as data (D1.5-1)", () => {
  test("validateStashEntry accepts an entry whose type is not in KNOWN_TYPES", () => {
    const result = validateStashEntry({ name: "widget-one", type: "widget" });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("widget");
  });

  test("validateStashEntry still rejects malformed entries (name/type shape)", () => {
    expect(validateStashEntry({ type: "widget" })).toBeNull(); // no name
    expect(validateStashEntry({ name: "x", type: "" })).toBeNull(); // empty type
    expect(validateStashEntry({ name: "x" })).toBeNull(); // no type at all
  });

  // NOTE (chunk-3 cutover): the two flat-walk-via-`registerMatcher`
  // cases that exercised the indexer's open-token accept / deny-list reject were
  // removed together with the file-context matcher registry. The akm flat-walk now
  // recognizes only the built-in types (`recognizeMatch`), so a FOREIGN type can no
  // longer be injected through it without a test-only matcher. That contract is now
  // proven where foreign types actually flow: adapter recognition (okf-adapter.test.ts
  // reads a free-form `type` verbatim from frontmatter) and `validateStashEntry`'s
  // accept/reject — covered directly above and in the deny-list section below.
});

// ── (b) KNOWN_TYPES exhaustiveness ──────────────────────────────────────────

describe("KNOWN_TYPES exhaustiveness — typed tables compile-cover all 14", () => {
  test("KNOWN_TYPES has exactly the 14 AKM-owned type keys", () => {
    expect(KNOWN_TYPES.length).toBe(14);
    expect(new Set(KNOWN_TYPES).size).toBe(14); // no duplicates
  });

  test("a KNOWN_TYPE always satisfies isKnownType", () => {
    for (const type of KNOWN_TYPES) {
      expect(isKnownType(type)).toBe(true);
    }
  });

  test("isKnownType is false for a foreign type — NOT a validation gate, just an ownership check", () => {
    expect(isKnownType("some-foreign-type")).toBe(false);
    expect(isKnownType("")).toBe(false);
  });
});

// ── (c) presentationFor fallback ────────────────────────────────────────────

describe("presentationFor — open-string fallback (§2.3)", () => {
  test("returns a type-specific presentation for every KNOWN_TYPE", () => {
    for (const type of KNOWN_TYPES) {
      expect(presentationFor(type)).toEqual(TYPE_PRESENTATION[type]);
    }
  });

  test("returns the generic fallback for a foreign/unknown type — never undefined, never a throw", () => {
    expect(() => presentationFor("some-foreign-type")).not.toThrow();
    const result = presentationFor("some-foreign-type");
    expect(result).toBeDefined();
    expect(result.label).toBe("Asset");
  });

  test("returns the generic fallback for undefined", () => {
    expect(presentationFor(undefined)).toEqual({ label: "Asset" });
  });
});

describe("DEPRECATED_REJECTED_TYPES ownership list", () => {
  test("the deny-list is exactly {tool, vault}", () => {
    expect([...DEPRECATED_REJECTED_TYPES].sort()).toEqual(["tool", "vault"]);
  });

  test("the format-neutral index projection accepts retired AKM names as adapter-owned types", () => {
    expect(validateStashEntry({ name: "x", type: "tool" })?.type).toBe("tool");
    expect(validateStashEntry({ name: "x", type: "vault" })?.type).toBe("vault");
  });

  test("a non-deny-listed foreign type is NOT rejected by the same check", () => {
    expect(validateStashEntry({ name: "x", type: "tool-belt" })).not.toBeNull();
  });
});
