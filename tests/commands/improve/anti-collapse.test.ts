// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 8 — anti-collapse merge guards — unit tests.
 *
 * Covers:
 *   - readAssetGeneration / computeMergedGeneration: frontmatter read + math.
 *   - checkGenerationGuard: refuses merge when ≥2 participants above maxGeneration.
 *   - computeBigramDiversity: n-gram diversity metric.
 *   - checkLexicalDiversity: low-diversity cluster detection.
 *   - checkMergeInformationFloor: provenance + specificity floor (R5 §4.2).
 *   - anti-collapse guards default ON (R5 §4.1).
 */

import { describe, expect, test } from "bun:test";
import {
  checkGenerationGuard,
  checkLexicalDiversity,
  checkMergeInformationFloor,
  computeBigramDiversity,
  computeMergedGeneration,
  DEFAULT_MAX_GENERATION,
  readAssetGeneration,
} from "../../../src/commands/improve/anti-collapse";

// ── readAssetGeneration / computeMergedGeneration ────────────────────────────

describe("readAssetGeneration", () => {
  test("returns 0 when generation field absent", () => {
    expect(readAssetGeneration({})).toBe(0);
    expect(readAssetGeneration({ description: "x" })).toBe(0);
  });

  test("returns 0 for non-numeric generation values", () => {
    expect(readAssetGeneration({ generation: "two" })).toBe(0);
    expect(readAssetGeneration({ generation: null })).toBe(0);
    expect(readAssetGeneration({ generation: Number.NaN })).toBe(0);
    expect(readAssetGeneration({ generation: -1 })).toBe(0);
  });

  test("returns the integer floor of the generation value", () => {
    expect(readAssetGeneration({ generation: 1 })).toBe(1);
    expect(readAssetGeneration({ generation: 3.7 })).toBe(3);
    expect(readAssetGeneration({ generation: 0 })).toBe(0);
  });
});

describe("computeMergedGeneration", () => {
  test("returns 1 when no source generations (first merge)", () => {
    expect(computeMergedGeneration([])).toBe(1);
  });

  test("returns max + 1", () => {
    expect(computeMergedGeneration([0, 1, 2])).toBe(3);
    expect(computeMergedGeneration([3, 3])).toBe(4);
    expect(computeMergedGeneration([0, 0])).toBe(1);
  });
});

// ── checkGenerationGuard ──────────────────────────────────────────────────────

describe("checkGenerationGuard", () => {
  test("returns refused=false when disabled", () => {
    const result = checkGenerationGuard([5, 5], { enabled: false });
    expect(result.refused).toBe(false);
  });

  test("allows merge when fewer than 2 participants are above maxGeneration", () => {
    // Only one participant above max
    const result = checkGenerationGuard([0, 3], { enabled: true, maxGeneration: 2 });
    expect(result.refused).toBe(false);
  });

  test("refuses merge when ≥2 participants are above maxGeneration", () => {
    const result = checkGenerationGuard([3, 3], { enabled: true, maxGeneration: 2 });
    expect(result.refused).toBe(true);
    expect(result.reason).toContain("generation > 2");
  });

  test("uses default maxGeneration (2) when not specified", () => {
    const result = checkGenerationGuard([3, 3], { enabled: true });
    expect(result.refused).toBe(true);
    expect(result.reason).toContain(`generation > ${DEFAULT_MAX_GENERATION}`);
  });

  test("allows merge of originals (generation 0) even when enabled", () => {
    const result = checkGenerationGuard([0, 0], { enabled: true, maxGeneration: 2 });
    expect(result.refused).toBe(false);
  });
});

// ── computeBigramDiversity ────────────────────────────────────────────────────

describe("computeBigramDiversity", () => {
  test("returns 1 for text that is too short to have bigrams", () => {
    expect(computeBigramDiversity("one")).toBe(1);
    expect(computeBigramDiversity("")).toBe(1);
  });

  test("returns 1 for text with all unique bigrams", () => {
    // "the quick brown fox" → 3 unique bigrams out of 3 = 1.0
    expect(computeBigramDiversity("the quick brown fox")).toBeCloseTo(1.0);
  });

  test("returns low value for highly repetitive text", () => {
    // All bigrams are "the the" → diversity = 1/N
    const result = computeBigramDiversity("the the the the the the the the");
    expect(result).toBeLessThan(0.3);
  });

  test("is case-insensitive", () => {
    const a = computeBigramDiversity("Hello World Foo");
    const b = computeBigramDiversity("hello world foo");
    expect(a).toBeCloseTo(b);
  });
});

// ── checkLexicalDiversity ─────────────────────────────────────────────────────

describe("checkLexicalDiversity", () => {
  test("returns lowDiversity=false when disabled", () => {
    const result = checkLexicalDiversity(["the the the the"], { enabled: false });
    expect(result.lowDiversity).toBe(false);
  });

  test("returns lowDiversity=false when lexicalDiversityCheck=false", () => {
    const result = checkLexicalDiversity(["the the the the"], { enabled: true, lexicalDiversityCheck: false });
    expect(result.lowDiversity).toBe(false);
  });

  test("returns lowDiversity=false for empty bodies list", () => {
    const result = checkLexicalDiversity([], { enabled: true });
    expect(result.lowDiversity).toBe(false);
  });

  test("detects low-diversity cluster (repetitive bodies)", () => {
    const bodies = ["the the the the the the the the the the", "the the the the the the the the the the"];
    const result = checkLexicalDiversity(bodies, { enabled: true });
    expect(result.lowDiversity).toBe(true);
    expect(result.diversity).toBeDefined();
    expect(result.diversity).toBeLessThan(0.3);
  });

  test("returns lowDiversity=false for diverse bodies", () => {
    const bodies = [
      "the quick brown fox jumps over the lazy dog",
      "a completely different sentence about cats and mice",
    ];
    const result = checkLexicalDiversity(bodies, { enabled: true });
    expect(result.lowDiversity).toBe(false);
  });
});

// ── checkMergeInformationFloor (R5 §4.2) ──────────────────────────────────────

describe("checkMergeInformationFloor", () => {
  const participants = [
    { ref: "memories/a", body: "alpha beta gamma delta epsilon zeta", sourceRefs: ["memories/root"] },
    { ref: "memories/b", body: "eta theta iota kappa lambda mu", sourceRefs: [] },
  ];
  const fullProvenance = ["memories/a", "memories/b", "memories/root"];

  test("genuinely-additive merge passes (full provenance, full token retention)", () => {
    const merged = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu synthesis";
    const result = checkMergeInformationFloor(merged, fullProvenance, participants, {});
    expect(result.passed).toBe(true);
    expect(result.specificityRetention).toBe(1);
  });

  test("provenance shrink fails (merged source_refs missing a participant's cited source)", () => {
    const merged = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const result = checkMergeInformationFloor(merged, ["memories/a", "memories/b"], participants, {});
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("provenance shrank");
    expect(result.provenanceBefore).toBe(3);
    expect(result.provenanceAfter).toBe(2);
  });

  test("shortening/genericizing merge fails the 0.6 retention floor", () => {
    // 12 distinct source tokens; merged keeps only 4 (< 0.6 × 12 = 7.2).
    const merged = "alpha beta gamma delta";
    const result = checkMergeInformationFloor(merged, fullProvenance, participants, {});
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("specificity retention");
    expect(result.specificityRetention).toBeCloseTo(4 / 12, 6);
  });

  test("retention boundary: exactly at the configured floor passes", () => {
    // 12 source tokens, keep 6, floor 0.5 → 0.5 >= 0.5 passes.
    const merged = "alpha beta gamma delta epsilon zeta";
    const result = checkMergeInformationFloor(merged, fullProvenance, participants, {
      minSpecificityRetention: 0.5,
    });
    expect(result.passed).toBe(true);
  });

  test("opt-outs: enabled:false or mergeInformationFloor:false pass trivially", () => {
    const merged = "x";
    expect(checkMergeInformationFloor(merged, [], participants, { enabled: false }).passed).toBe(true);
    expect(checkMergeInformationFloor(merged, [], participants, { mergeInformationFloor: false }).passed).toBe(true);
  });
});

// ── R5: anti-collapse guards default ON ───────────────────────────────────────

describe("anti-collapse guards default ON (R5 §4.1)", () => {
  test("checkGenerationGuard is active with an empty config (default on)", () => {
    // Both participants above maxGeneration (default 2) → refused by default.
    expect(checkGenerationGuard([3, 3], {}).refused).toBe(true);
    // Explicit opt-out restores the old inert behavior.
    expect(checkGenerationGuard([3, 3], { enabled: false }).refused).toBe(false);
  });

  test("checkLexicalDiversity is active with an empty config (default on)", () => {
    // Single repeated token → 1 unique bigram / 5 total = 0.2 < the 0.30 floor.
    const repetitive = ["same same same same same same", "same same same same same same"];
    expect(checkLexicalDiversity(repetitive, {}).lowDiversity).toBe(true);
    expect(checkLexicalDiversity(repetitive, { enabled: false }).lowDiversity).toBe(false);
  });
});
