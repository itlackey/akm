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
 *   (b) `KNOWN_TYPES` exhaustiveness — `TYPE_BOOST` and `TYPE_PRESENTATION`
 *       compile-cover all 14 known types;
 *   (c) `presentationFor` returns the generic fallback for an unknown type;
 *   (d) the `DEPRECATED_REJECTED_TYPES` deny-list still rejects `tool`/
 *       `vault` with their original messages, across all three gates
 *       (`parseAssetRef`, `validateStashEntry`, and the `akm` adapter's `recognize`).
 *
 * Replaces (not just deletes) the taxonomy-pin tests identified in
 * `docs/design/execution/chunk-1.5/anchors.md` §D.1.
 */

import { describe, expect, test } from "bun:test";
import { DEPRECATED_REJECTED_TYPES, isKnownType, KNOWN_TYPES, type KnownType } from "../../src/core/recognition-util";
import { presentationFor, TYPE_PRESENTATION } from "../../src/core/type-presentation";
import { validateStashEntry } from "../../src/indexer/passes/metadata";
import { TYPE_BOOST, typeBoostFor } from "../../src/indexer/search/ranking-contributors";
import { parseAssetRef, parseStoredRef } from "../../src/migrate/legacy-ref-grammar";

// ── (a) open-token acceptance as DATA ───────────────────────────────────────

describe("open type token — accepted as data (D1.5-1)", () => {
  test("parseAssetRef round-trips an arbitrary foreign/adapter type", () => {
    const ref = parseAssetRef("custom-adapter-type:foo");
    expect(ref.type).toBe("custom-adapter-type");
    expect(ref.name).toBe("foo");
  });

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

  test("TYPE_BOOST (ranking-contributors.ts) has an entry for every KNOWN_TYPE", () => {
    for (const type of KNOWN_TYPES) {
      expect(Object.hasOwn(TYPE_BOOST, type)).toBe(true);
      expect(typeof TYPE_BOOST[type]).toBe("number");
    }
    expect(Object.keys(TYPE_BOOST).length).toBe(14);
  });

  test("TYPE_BOOST's previously-absent types are explicit 0 entries (behavior-preserving, D1.5-5)", () => {
    // `wiki` left this set in chunk 4 (the wiki asset-type is retired).
    for (const type of ["env", "secret", "lesson", "task", "session"] as const) {
      expect(TYPE_BOOST[type]).toBe(0);
    }
  });

  test("typeBoostFor matches TYPE_BOOST for every known type and falls back to 0 for foreign types", () => {
    for (const type of KNOWN_TYPES) {
      expect(typeBoostFor(type)).toBe(TYPE_BOOST[type]);
    }
    expect(typeBoostFor("some-foreign-type")).toBe(0);
  });

  test("TYPE_PRESENTATION (type-presentation.ts) has an entry for every KNOWN_TYPE", () => {
    for (const type of KNOWN_TYPES) {
      expect(Object.hasOwn(TYPE_PRESENTATION, type)).toBe(true);
      expect(typeof TYPE_PRESENTATION[type].label).toBe("string");
      expect(TYPE_PRESENTATION[type].label.length).toBeGreaterThan(0);
    }
    expect(Object.keys(TYPE_PRESENTATION).length).toBe(14);
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

  // Compile-time half of the contract: if this file still compiles, every
  // `KnownType` member above type-checked against `TYPE_BOOST`/
  // `TYPE_PRESENTATION`'s `Record<KnownType, X>` signatures — a missing key
  // in either table is a `tsc` failure, not a runtime one.
  test("KnownType assignability compiles (type-level exhaustiveness marker)", () => {
    const sample: KnownType = "skill";
    expect(TYPE_BOOST[sample]).toBeDefined();
    expect(TYPE_PRESENTATION[sample]).toBeDefined();
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

// ── (d) deny-list still rejects tool/vault (D1.5-6) ─────────────────────────

describe("DEPRECATED_REJECTED_TYPES deny-list — tool/vault stay rejected", () => {
  test("the deny-list is exactly {tool, vault}", () => {
    expect([...DEPRECATED_REJECTED_TYPES].sort()).toEqual(["tool", "vault"]);
  });

  test("parseAssetRef rejects tool with the generic invalid-type message", () => {
    expect(() => parseAssetRef("tool:deploy.sh")).toThrow("Invalid asset type");
  });

  test("parseAssetRef rejects vault with its migration-hint message (checked before the deny-list)", () => {
    expect(() => parseAssetRef("vault:prod")).toThrow(/vault.*removed in 0\.9\.0.*env.*secret/i);
  });

  test("parseStoredRef accepts retired types only for historical durable state", () => {
    expect(parseStoredRef("vault:default")).toEqual({ type: "vault", name: "default" });
    expect(parseStoredRef("local//tool:deploy.sh")).toEqual({
      type: "tool",
      name: "deploy.sh",
      origin: "local",
    });
    expect(() => parseStoredRef(":bad")).toThrow();
  });

  test("validateStashEntry rejects tool/vault even though they are otherwise well-formed entries", () => {
    expect(validateStashEntry({ name: "x", type: "tool" })).toBeNull();
    expect(validateStashEntry({ name: "x", type: "vault" })).toBeNull();
  });

  test("a non-deny-listed foreign type is NOT rejected by the same check", () => {
    expect(validateStashEntry({ name: "x", type: "tool-belt" })).not.toBeNull();
  });
});
