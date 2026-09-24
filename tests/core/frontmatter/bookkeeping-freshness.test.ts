// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the bookkeeping-insensitive freshness helpers (STALE, R20).
 *
 * All tests are pure-function — no I/O.
 */

import { describe, expect, test } from "bun:test";
import { carryForwardBookkeepingFrontmatter, computeNormalizedContentHash } from "../../../src/core/asset/frontmatter";

describe("computeNormalizedContentHash", () => {
  test("is insensitive to a salience bookkeeping rewrite", () => {
    const before = "---\ntype: memory\nname: test\n---\nBody content here.\n";
    const after =
      "---\ntype: memory\nname: test\nsalience: 0.82\nsalienceInputs:\n  novelty: 0.85\n  magnitude: 0.75\n  predictionError: 1\n---\nBody content here.\n";
    expect(computeNormalizedContentHash(before)).toBe(computeNormalizedContentHash(after));
  });

  test("is insensitive to an inferenceProcessed bookkeeping rewrite", () => {
    const before = "---\ntype: memory\nname: test\n---\nBody content here.\n";
    const after = "---\ntype: memory\nname: test\ninferenceProcessed: true\n---\nBody content here.\n";
    expect(computeNormalizedContentHash(before)).toBe(computeNormalizedContentHash(after));
  });

  test("is insensitive to incidental frontmatter key-order churn", () => {
    const a = "---\ntype: memory\nname: test\n---\nBody content here.\n";
    const b = "---\nname: test\ntype: memory\n---\nBody content here.\n";
    expect(computeNormalizedContentHash(a)).toBe(computeNormalizedContentHash(b));
  });

  test("still changes when a real (non-bookkeeping) frontmatter field changes", () => {
    const a = "---\ntype: memory\nname: test\n---\nBody content here.\n";
    const b = "---\ntype: memory\nname: renamed\n---\nBody content here.\n";
    expect(computeNormalizedContentHash(a)).not.toBe(computeNormalizedContentHash(b));
  });

  test("still changes when the body changes", () => {
    const a = "---\ntype: memory\nname: test\n---\nBody content here.\n";
    const b = "---\ntype: memory\nname: test\n---\nDifferent body content.\n";
    expect(computeNormalizedContentHash(a)).not.toBe(computeNormalizedContentHash(b));
  });

  test("still changes when an editorial belief-state field changes", () => {
    // beliefState/contradictedBy/supersededBy are deliberately NOT
    // bookkeeping — they are editorial demotions, not derived audit metadata.
    const a = "---\ntype: memory\nname: test\n---\nBody content here.\n";
    const b = "---\ntype: memory\nname: test\nbeliefState: contradicted\n---\nBody content here.\n";
    expect(computeNormalizedContentHash(a)).not.toBe(computeNormalizedContentHash(b));
  });

  test("falls back to hashing verbatim when there is no frontmatter block", () => {
    const raw = "Just a body, no frontmatter.";
    expect(computeNormalizedContentHash(raw)).toBe(computeNormalizedContentHash(raw));
    expect(computeNormalizedContentHash(raw)).not.toBe(computeNormalizedContentHash("Different body."));
  });

  test("falls back to hashing verbatim when frontmatter fails to parse", () => {
    const raw = "---\n[unterminated: [flow\n---\nBody.\n";
    // Should not throw, and should be stable across repeated calls.
    expect(computeNormalizedContentHash(raw)).toBe(computeNormalizedContentHash(raw));
  });
});

describe("carryForwardBookkeepingFrontmatter", () => {
  test("folds a live inferenceProcessed marker into content that lacks it", () => {
    const proposed = "---\ntype: memory\nname: test\n---\nNew body.\n";
    const live = "---\ntype: memory\nname: test\ninferenceProcessed: true\n---\nOld body.\n";
    const result = carryForwardBookkeepingFrontmatter(proposed, live);
    expect(result).toContain("inferenceProcessed: true");
    expect(result).toContain("New body.");
    expect(result).not.toContain("Old body.");
  });

  test("folds live salience/salienceInputs into content that lacks them", () => {
    const proposed = "---\ntype: memory\nname: test\n---\nNew body.\n";
    const live = "---\ntype: memory\nname: test\nsalience: 0.82\nsalienceInputs:\n  novelty: 0.85\n---\nOld body.\n";
    const result = carryForwardBookkeepingFrontmatter(proposed, live);
    expect(result).toContain("salience: 0.82");
    expect(result).toContain("novelty: 0.85");
  });

  test("does not overwrite a bookkeeping key the proposal's own frontmatter already sets", () => {
    const proposed = "---\ntype: memory\nname: test\ninferenceProcessed: false\n---\nNew body.\n";
    const live = "---\ntype: memory\nname: test\ninferenceProcessed: true\n---\nOld body.\n";
    const result = carryForwardBookkeepingFrontmatter(proposed, live);
    expect(result).toContain("inferenceProcessed: false");
  });

  test("returns the proposed content unchanged when the live target has no bookkeeping keys", () => {
    const proposed = "---\ntype: memory\nname: test\n---\nNew body.\n";
    const live = "---\ntype: memory\nname: test\n---\nOld body.\n";
    expect(carryForwardBookkeepingFrontmatter(proposed, live)).toBe(proposed);
  });

  test("returns the proposed content unchanged when it has no frontmatter block", () => {
    const proposed = "No frontmatter here.";
    const live = "---\ntype: memory\nname: test\ninferenceProcessed: true\n---\nOld body.\n";
    expect(carryForwardBookkeepingFrontmatter(proposed, live)).toBe(proposed);
  });
});
