// Characterization + intentional-delta guard for WS7 (#490).
//
// Before WS7, ASSET_TYPES was a hand-maintained literal array in
// src/core/common.ts that had DRIFTED from the ASSET_SPECS registry in
// src/core/asset/asset-spec.ts: the registry carries a `task` spec that the union
// omitted. WS7 derives ASSET_TYPES from the registry to kill that drift —
// which ADDS `task` to the union. That single addition is NOT
// behaviour-preserving, so it is gated here:
//
//   1. PRE_WS7_UNION pins the exact 11-entry list that shipped before WS7.
//   2. The "intentional delta" test asserts the post-derivation union equals
//      PRE_WS7_UNION ∪ {task} — i.e. `task` is the ONLY change and it is a
//      deliberate, separately-reviewed fix of the registry/union drift.
//
// If a future change alters the union by anything other than the reviewed
// `task` addition, the delta test fails and forces a fresh review.

import { describe, expect, test } from "bun:test";
import { getAssetTypes } from "../src/core/asset/asset-spec";
import { ASSET_TYPE_SET, ASSET_TYPES } from "../src/core/common";

/** The exact ASSET_TYPES literal union as it shipped immediately before WS7. */
const PRE_WS7_UNION = [
  "skill",
  "command",
  "agent",
  "knowledge",
  "workflow",
  "script",
  "memory",
  "env",
  "secret",
  "wiki",
  "lesson",
] as const;

/**
 * Intentional additions to the union since the pre-WS7 baseline:
 *   - `task`  — WS7 registry/union drift fix (#490).
 *   - `session` — #561 indexes agent sessions as a first-class asset type.
 * Both are deliberate, separately-reviewed registry additions.
 */
const INTENTIONAL_ADDITIONS = ["session", "task"] as const;

describe("ASSET_TYPES is the single source of truth (derived from ASSET_SPECS)", () => {
  test("ASSET_TYPES equals the registry key set (no drift)", () => {
    const union: string[] = [...ASSET_TYPES].sort();
    const registry: string[] = [...getAssetTypes()].sort();
    expect(union).toEqual(registry);
  });

  test("intentional delta: union = pre-WS7 list + {task}, nothing else", () => {
    const before = new Set<string>(PRE_WS7_UNION);
    const after = new Set<string>(ASSET_TYPES);

    const added = [...after].filter((t) => !before.has(t)).sort();
    const removed = [...before].filter((t) => !after.has(t)).sort();

    // The ONLY reviewed change is the addition of `task`. Nothing was removed.
    expect(added).toEqual([...INTENTIONAL_ADDITIONS].sort());
    expect(removed).toEqual([]);
  });

  test("ASSET_TYPE_SET tracks ASSET_TYPES", () => {
    expect([...ASSET_TYPE_SET].sort()).toEqual([...ASSET_TYPES].sort());
    for (const t of ASSET_TYPES) {
      expect(ASSET_TYPE_SET.has(t)).toBe(true);
    }
  });
});
