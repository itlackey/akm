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
 *       and the `generateMetadataFlat` gate (metadata.ts:1423 in the
 *       pre-chunk anchors — the plan-unmentioned second gate);
 *   (b) `KNOWN_TYPES` exhaustiveness — `TYPE_BOOST` and `TYPE_PRESENTATION`
 *       compile-cover all 14 known types;
 *   (c) `presentationFor` returns the generic fallback for an unknown type;
 *   (d) the `DEPRECATED_REJECTED_TYPES` deny-list still rejects `tool`/
 *       `vault` with their original messages, across all three gates
 *       (`parseAssetRef`, `validateStashEntry`, `generateMetadataFlat`).
 *
 * Replaces (not just deletes) the taxonomy-pin tests identified in
 * `docs/design/execution/chunk-1.5/anchors.md` §D.1.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssetRef } from "../../src/core/asset/asset-ref";
import { DEPRECATED_REJECTED_TYPES, isKnownType, KNOWN_TYPES, type KnownType } from "../../src/core/recognition-util";
import { presentationFor, TYPE_PRESENTATION } from "../../src/core/type-presentation";
import { generateMetadataFlat, validateStashEntry } from "../../src/indexer/passes/metadata";
import { TYPE_BOOST, typeBoostFor } from "../../src/indexer/search/ranking-contributors";
import { registerMatcher } from "../../src/indexer/walk/file-context";

// Distinctive marker extension for a throwaway test-only matcher registered
// below. `registerMatcher` is a process-lifetime singleton (no unregister
// API), so this uses an extension no other file/test in the suite will ever
// produce — registering it is a permanent, but inert, no-op for every other
// test's fixtures.
const CONTRACT_MARKER_EXT = ".akm-type-token-contract-marker";
const CONTRACT_FOREIGN_TYPE = "contract-test-foreign-type";

registerMatcher((ctx) => {
  if (!ctx.absPath.endsWith(CONTRACT_MARKER_EXT)) return null;
  // The matched "type" is itself test-controlled: the filename's basename
  // (minus the marker extension) becomes the matched type, so one matcher
  // can exercise both the open-token accept path and the deny-list reject
  // path by varying the fixture filename.
  const matchedType = path.basename(ctx.absPath, CONTRACT_MARKER_EXT);
  return { type: matchedType, specificity: 1000, renderer: "knowledge" };
});

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

  test("generateMetadataFlat indexes a matcher-returned foreign type instead of silently skipping it", async () => {
    // Direct successor to §B's pre-chunk gap: metadata.ts's flat-walk
    // `isAssetType` check silently dropped any matcher-returned type outside
    // the closed 14 — untested pre-chunk (chunk-1.5 anchors §A.5/§B). This
    // exercises the real `generateMetadataFlat` pipeline end to end via the
    // test-only matcher registered above.
    const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-type-token-contract-"));
    try {
      const filePath = path.join(stashRoot, `${CONTRACT_FOREIGN_TYPE}${CONTRACT_MARKER_EXT}`);
      fs.writeFileSync(filePath, "contract test fixture\n", "utf8");

      const result = await generateMetadataFlat(stashRoot, [filePath]);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].type).toBe(CONTRACT_FOREIGN_TYPE);
    } finally {
      fs.rmSync(stashRoot, { recursive: true, force: true });
    }
  });

  test("generateMetadataFlat still short-circuits the deny-listed tool/vault types (D1.5-6)", async () => {
    const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-type-token-contract-"));
    try {
      const toolPath = path.join(stashRoot, `tool${CONTRACT_MARKER_EXT}`);
      const vaultPath = path.join(stashRoot, `vault${CONTRACT_MARKER_EXT}`);
      fs.writeFileSync(toolPath, "contract test fixture\n", "utf8");
      fs.writeFileSync(vaultPath, "contract test fixture\n", "utf8");

      const result = await generateMetadataFlat(stashRoot, [toolPath, vaultPath]);

      expect(result.entries).toEqual([]);
    } finally {
      fs.rmSync(stashRoot, { recursive: true, force: true });
    }
  });
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

  test("TYPE_BOOST's 6 previously-absent types are explicit 0 entries (behavior-preserving, D1.5-5)", () => {
    for (const type of ["env", "secret", "wiki", "lesson", "task", "session"] as const) {
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

  test("validateStashEntry rejects tool/vault even though they are otherwise well-formed entries", () => {
    expect(validateStashEntry({ name: "x", type: "tool" })).toBeNull();
    expect(validateStashEntry({ name: "x", type: "vault" })).toBeNull();
  });

  test("a non-deny-listed foreign type is NOT rejected by the same check", () => {
    expect(validateStashEntry({ name: "x", type: "tool-belt" })).not.toBeNull();
  });
});
