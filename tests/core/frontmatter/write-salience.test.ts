// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for writeSalienceToFrontmatter (issue #608).
 *
 * All tests are pure-function — no I/O.
 */

import { describe, expect, test } from "bun:test";
import { parseFrontmatter, writeSalienceToFrontmatter } from "../../../src/core/asset/frontmatter";

const SAMPLE_INPUTS = {
  novelty: 0.85,
  magnitude: 0.75,
  predictionError: 1.0,
};

// ── idempotent write ─────────────────────────────────────────────────────────

describe("writeSalienceToFrontmatter", () => {
  test("writes salience field when none exists", () => {
    const raw = "---\ntype: lesson\nname: test\n---\nBody content here.";
    const result = writeSalienceToFrontmatter(raw, 0.82, SAMPLE_INPUTS);
    const { data } = parseFrontmatter(result);
    expect(data.salience).toBeCloseTo(0.82, 2);
  });

  test("writes salienceInputs sub-fields for auditability", () => {
    const raw = "---\ntype: lesson\nname: test\n---\nBody content here.";
    const result = writeSalienceToFrontmatter(raw, 0.82, SAMPLE_INPUTS);
    const { data } = parseFrontmatter(result);
    expect(typeof data.salienceInputs).toBe("object");
    const inputs = data.salienceInputs as Record<string, number>;
    expect(inputs.novelty).toBeCloseTo(0.85, 2);
    expect(inputs.magnitude).toBeCloseTo(0.75, 2);
    expect(inputs.predictionError).toBeCloseTo(1.0, 2);
  });

  test("idempotent write: calling twice with same score produces no change on second call", () => {
    const raw = "---\ntype: lesson\nname: test\n---\nBody content here.";
    const first = writeSalienceToFrontmatter(raw, 0.82, SAMPLE_INPUTS);
    const second = writeSalienceToFrontmatter(first, 0.82, SAMPLE_INPUTS);
    expect(first).toBe(second);
  });

  test("skip-if-delta-small: existing salience=0.80, new score=0.83 → no write (delta=0.03 < 0.05)", () => {
    const raw = "---\ntype: lesson\nname: test\nsalience: 0.80\n---\nBody content here.";
    const result = writeSalienceToFrontmatter(raw, 0.83, SAMPLE_INPUTS);
    // Should be unchanged since delta = 0.03 < 0.05
    expect(result).toBe(raw);
  });

  test("write-if-delta-large: existing salience=0.80, new score=0.90 → writes updated field", () => {
    const raw = "---\ntype: lesson\nname: test\nsalience: 0.80\n---\nBody content here.";
    const result = writeSalienceToFrontmatter(raw, 0.9, SAMPLE_INPUTS);
    const { data } = parseFrontmatter(result);
    expect(data.salience).toBeCloseTo(0.9, 2);
  });

  test("updates existing salience field in-place (not appended)", () => {
    const raw = "---\ntype: lesson\nname: test\nsalience: 0.50\n---\nBody content here.";
    const result = writeSalienceToFrontmatter(raw, 0.9, SAMPLE_INPUTS);
    // Should not appear twice
    const matches = result.match(/salience:/g);
    // salience: appears once, salienceInputs: appears once — total 2 matches
    expect(matches?.length).toBeLessThanOrEqual(2);
    const { data } = parseFrontmatter(result);
    expect(data.salience).toBeCloseTo(0.9, 2);
  });

  test("preserves existing frontmatter fields when writing salience", () => {
    const raw = "---\ntype: lesson\nname: my-test\nref: lesson:my-test\n---\nBody content here.";
    const result = writeSalienceToFrontmatter(raw, 0.82, SAMPLE_INPUTS);
    const { data } = parseFrontmatter(result);
    expect(data.type).toBe("lesson");
    expect(data.name).toBe("my-test");
    expect(data.ref).toBe("lesson:my-test");
  });

  test("preserves body content after frontmatter", () => {
    const raw = "---\ntype: lesson\nname: test\n---\nThis is the body content.";
    const result = writeSalienceToFrontmatter(raw, 0.82, SAMPLE_INPUTS);
    expect(result).toContain("This is the body content.");
  });

  test("handles raw string with no frontmatter block (returns unchanged)", () => {
    const raw = "No frontmatter here, just body content.";
    const result = writeSalienceToFrontmatter(raw, 0.82, SAMPLE_INPUTS);
    // Without frontmatter, cannot write salience fields — return unchanged
    expect(result).toBe(raw);
  });
});
