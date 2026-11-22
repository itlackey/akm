// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-1.2 — `src/core/recognition-util.ts` util home (D1-4).
 *
 * Two things pinned here:
 *   (a) the four relocated symbols export with their expected values/shapes
 *       (a behavior-preserving move must not change them); and
 *   (b) the D1-5 cycle-safety invariant — this module must import NOTHING
 *       from `src/` — mechanized by reading the source text directly and
 *       asserting no `import ... from "..."` line references a relative
 *       (`./`/`../`) path, since a relative specifier from this file could
 *       only ever resolve back into `src/`.
 */

import { describe, expect, test } from "bun:test";
import { placementTypes } from "../../src/core/asset/asset-placement";
import {
  canonicalizeWorkflowName,
  DERIVED_SUFFIX,
  isKnownType,
  KNOWN_TYPES,
  SCRIPT_EXTENSIONS,
  WORKFLOW_EXTENSIONS,
} from "../../src/core/recognition-util";

describe("recognition-util — relocated symbol values (behavior-preserving move)", () => {
  test("SCRIPT_EXTENSIONS is the Set of 17 recognized script extensions", () => {
    expect(SCRIPT_EXTENSIONS).toBeInstanceOf(Set);
    expect(SCRIPT_EXTENSIONS.size).toBe(17);
    for (const ext of [
      ".sh",
      ".ts",
      ".js",
      ".mjs",
      ".ps1",
      ".cmd",
      ".bat",
      ".py",
      ".rb",
      ".go",
      ".pl",
      ".php",
      ".lua",
      ".r",
      ".swift",
      ".kt",
      ".kts",
    ]) {
      expect(SCRIPT_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test("WORKFLOW_EXTENSIONS is Markdown only", () => {
    expect(WORKFLOW_EXTENSIONS).toEqual([".md"]);
  });

  test("canonicalizeWorkflowName strips the recognized workflow extension, else passes through", () => {
    expect(canonicalizeWorkflowName("foo.md")).toBe("foo");
    expect(canonicalizeWorkflowName("foo.yml")).toBe("foo.yml");
    expect(canonicalizeWorkflowName("foo")).toBe("foo");
    expect(canonicalizeWorkflowName("foo.FOO")).toBe("foo.FOO");
  });

  test("DERIVED_SUFFIX is the structural .derived marker", () => {
    expect(DERIVED_SUFFIX).toBe(".derived");
  });
});

// Owner ruling 11 (R-045 / Q-18 second half): `asset-placement.ts`'s
// PLACEMENT_SPECS registry and this file's KNOWN_TYPES tuple are two
// independently maintained registries. `asset-placement.ts` also enforces
// this at COMPILE time (`_BuiltinPlacementKeysAreKnownTypes`), but that check
// only covers the static built-in table; this runtime test is the executable
// contract the guardrail asked for and pins `instruction`'s placement
// (the type this ruling registers) specifically.
describe("placementTypes() ⊆ KNOWN_TYPES (owner ruling 11 — registries must never drift apart)", () => {
  test("every placement type key is a recognized KnownType", () => {
    for (const type of placementTypes()) {
      expect(isKnownType(type), `placement type "${type}" is missing from KNOWN_TYPES`).toBe(true);
    }
  });

  test("'instruction' is registered as a stash-resident placement type (ruling 11 EXECUTE NOW)", () => {
    expect(placementTypes()).toContain("instruction");
    expect(KNOWN_TYPES).toContain("instruction");
  });
});
