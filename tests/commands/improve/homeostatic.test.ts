// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b homeostatic tier — unit tests.
 *
 * Covers:
 *   - isSchemaConsistent: cosine-similarity gate with epsilon threshold.
 *   - readAssetGeneration / computeMergedGeneration: frontmatter read + math.
 *   - checkGenerationGuard: refuses merge when ≥2 participants above maxGeneration.
 *   - computeBigramDiversity: n-gram diversity metric.
 *   - checkLexicalDiversity: low-diversity cluster detection.
 *   - buildClsContext: CLS adjacent-lesson context block construction.
 *   - checkDistillFidelity: heuristic negation-pattern contradiction detection.
 *   - isHotProbation / shouldSkipHotProbationInLlm / buildHotProbationFrontmatter:
 *     captureMode: hot-probation helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClsContext,
  buildHotProbationFrontmatter,
  CAPTURE_MODE_HOT_PROBATION,
  checkDistillFidelity,
  checkGenerationGuard,
  checkLexicalDiversity,
  computeBigramDiversity,
  computeMergedGeneration,
  DEFAULT_MAX_GENERATION,
  isHotProbation,
  isSchemaConsistent,
  readAssetGeneration,
  shouldSkipHotProbationInLlm,
} from "../../../src/commands/improve/homeostatic";

// (The runHomeostaticDemotion suite was removed with the pass itself — R4.
// Continuous decay is covered by the recency-floor tests in salience.test.ts.)

// ── isSchemaConsistent ────────────────────────────────────────────────────────

describe("isSchemaConsistent", () => {
  // Unit-vector embeddings for predictable cosine similarity
  const vecA = [1, 0, 0];
  const vecB = [0, 1, 0];
  const vecSimilar = [0.9, 0.1, 0]; // sim to vecA ≈ 0.994

  test("returns false when disabled", () => {
    const result = isSchemaConsistent(vecA, [{ ref: "knowledge:x", embedding: vecA }], { enabled: false });
    expect(result.consistent).toBe(false);
  });

  test("returns false when no existing derived embeddings", () => {
    const result = isSchemaConsistent(vecA, [], { enabled: true });
    expect(result.consistent).toBe(false);
  });

  test("returns true when candidate embedding is within epsilon of existing", () => {
    const result = isSchemaConsistent(vecSimilar, [{ ref: "knowledge:x", embedding: vecA }], {
      enabled: true,
      epsilon: 0.85,
    });
    expect(result.consistent).toBe(true);
    expect(result.matchedRef).toBe("knowledge:x");
    expect(result.similarity).toBeGreaterThan(0.85);
  });

  test("returns false when candidate is dissimilar (orthogonal vectors)", () => {
    const result = isSchemaConsistent(vecB, [{ ref: "knowledge:x", embedding: vecA }], {
      enabled: true,
      epsilon: 0.85,
    });
    expect(result.consistent).toBe(false);
  });

  test("uses default epsilon (0.85) when not specified", () => {
    // vecA · vecA = 1.0 (identical), should be above any reasonable epsilon
    const result = isSchemaConsistent(vecA, [{ ref: "knowledge:x", embedding: vecA }], { enabled: true });
    expect(result.consistent).toBe(true);
    expect(result.similarity).toBeCloseTo(1.0);
  });

  test("picks the highest-similarity match among multiple existing embeddings", () => {
    const embeddings = [
      { ref: "knowledge:a", embedding: vecB }, // sim to vecSimilar ≈ 0.1
      { ref: "knowledge:b", embedding: vecA }, // sim to vecSimilar ≈ 0.994
    ];
    const result = isSchemaConsistent(vecSimilar, embeddings, { enabled: true, epsilon: 0.85 });
    expect(result.consistent).toBe(true);
    expect(result.matchedRef).toBe("knowledge:b");
  });
});

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

// ── buildClsContext ───────────────────────────────────────────────────────────

describe("buildClsContext", () => {
  test("returns empty string when disabled", () => {
    const ctx = buildClsContext([{ ref: "lesson:x", content: "foo" }], { enabled: false });
    expect(ctx).toBe("");
  });

  test("returns empty string when adjacentItems is empty", () => {
    const ctx = buildClsContext([], { enabled: true });
    expect(ctx).toBe("");
  });

  test("returns formatted context block when enabled and items present", () => {
    const ctx = buildClsContext(
      [
        { ref: "lesson:alpha", content: "Learn from past mistakes." },
        { ref: "knowledge:beta", content: "The sky is blue." },
      ],
      { enabled: true },
    );
    expect(ctx).toContain("## Existing adjacent lessons / knowledge (CLS context)");
    expect(ctx).toContain("lesson:alpha");
    expect(ctx).toContain("Learn from past mistakes.");
    expect(ctx).toContain("knowledge:beta");
    expect(ctx).toContain("The sky is blue.");
  });

  test("truncates long content to 400 chars", () => {
    const longContent = "x".repeat(1000);
    const ctx = buildClsContext([{ ref: "lesson:long", content: longContent }], { enabled: true });
    // Only first 400 chars should appear
    expect(ctx).toContain("x".repeat(400));
    expect(ctx).not.toContain("x".repeat(401));
  });
});

// ── checkDistillFidelity ──────────────────────────────────────────────────────

describe("checkDistillFidelity", () => {
  test("returns no contradiction when disabled", () => {
    const result = checkDistillFidelity("you must never deploy on Friday", ["always deploy on Friday"], {
      enabled: false,
    });
    expect(result.contradictionDetected).toBe(false);
  });

  test("returns no contradiction when sourceBodies is empty", () => {
    const result = checkDistillFidelity("you must never fail", [], { enabled: true });
    expect(result.contradictionDetected).toBe(false);
  });

  test("returns no contradiction when proposal has no strong claims", () => {
    const result = checkDistillFidelity("this is a mild suggestion", ["this is a mild suggestion"], { enabled: true });
    expect(result.contradictionDetected).toBe(false);
  });

  test("detects contradiction: proposal 'always X' vs source 'never X'", () => {
    // Proposal: "always deploy" creates positive claim { polarity: positive, term: "deploy" }
    // Source: "never deploy" creates negative claim for "deploy" → contradiction
    const result = checkDistillFidelity(
      "always deploy the latest build immediately",
      ["never deploy directly without review"],
      { enabled: true },
    );
    expect(result.contradictionDetected).toBe(true);
    expect(result.reason).toContain("deploy");
  });

  test("detects contradiction: proposal 'never X' vs source 'always X'", () => {
    // Proposal: "never push" (negative), source: "always push" (positive) → contradiction
    const result = checkDistillFidelity("never push to main without CI", ["always push to main when tests pass"], {
      enabled: true,
    });
    expect(result.contradictionDetected).toBe(true);
  });

  test("no false positive when proposal and source agree", () => {
    const result = checkDistillFidelity("always test before merging", ["always test before merging your changes"], {
      enabled: true,
    });
    // Both say "always test" — not a contradiction
    expect(result.contradictionDetected).toBe(false);
  });
});

// ── hot-probation helpers ─────────────────────────────────────────────────────

describe("CAPTURE_MODE_HOT_PROBATION constant", () => {
  test("has the expected value", () => {
    expect(CAPTURE_MODE_HOT_PROBATION).toBe("hot-probation");
  });
});

describe("isHotProbation", () => {
  test("returns true for hot-probation captureMode", () => {
    expect(isHotProbation("hot-probation")).toBe(true);
  });

  test("returns false for other captureModes", () => {
    expect(isHotProbation("hot")).toBe(false);
    expect(isHotProbation("normal")).toBe(false);
    expect(isHotProbation(undefined)).toBe(false);
    expect(isHotProbation(null)).toBe(false);
    expect(isHotProbation("")).toBe(false);
  });
});

describe("shouldSkipHotProbationInLlm", () => {
  test("returns true when frontmatter has captureMode: hot-probation", () => {
    expect(shouldSkipHotProbationInLlm({ captureMode: "hot-probation" })).toBe(true);
  });

  test("returns false for other values", () => {
    expect(shouldSkipHotProbationInLlm({ captureMode: "hot" })).toBe(false);
    expect(shouldSkipHotProbationInLlm({})).toBe(false);
    expect(shouldSkipHotProbationInLlm({ captureMode: undefined })).toBe(false);
  });
});

describe("buildHotProbationFrontmatter", () => {
  test("returns captureMode: hot-probation object", () => {
    const fm = buildHotProbationFrontmatter();
    expect(fm).toEqual({ captureMode: "hot-probation" });
    expect(fm.captureMode).toBe(CAPTURE_MODE_HOT_PROBATION);
  });
});
