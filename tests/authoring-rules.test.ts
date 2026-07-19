// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Drift guard for the canonical hard-authoring-rules seam.
 *
 * The whole point of src/core/authoring-rules.ts is that the prompt text and
 * the validators share ONE source for the bounds, so they can't drift (the bug
 * was distill telling the model "80–200 chars" while the gate enforced 20–400).
 * These tests pin that the bounds constants actually drive the validators AND
 * that the agent-facing rule text states the same numbers — if someone changes
 * one without the other, this fails.
 */

import { describe, expect, test } from "bun:test";
import { isValidDescription, isValidWhenToUse } from "../src/commands/proposal/validators/proposal-quality-validators";
import {
  authoringRulesForType,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MIN_CHARS,
  WHEN_TO_USE_MAX_CHARS,
  WHEN_TO_USE_MIN_CHARS,
} from "../src/core/authoring-rules";

const ref = "lessons/example";

describe("authoring-rules bounds drive the validators", () => {
  test("description below DESCRIPTION_MIN_CHARS is rejected; at the bound is accepted", () => {
    const tooShort = "x".repeat(DESCRIPTION_MIN_CHARS - 1);
    const atMin = "a real sentence ".repeat(2).slice(0, DESCRIPTION_MIN_CHARS);
    expect(isValidDescription(tooShort, ref).ok).toBe(false);
    expect(atMin.length).toBe(DESCRIPTION_MIN_CHARS);
    expect(isValidDescription(atMin, ref).ok).toBe(true);
  });

  test("description above DESCRIPTION_MAX_CHARS is rejected", () => {
    const tooLong = `A valid sentence start ${"word ".repeat(DESCRIPTION_MAX_CHARS)}`.slice(
      0,
      DESCRIPTION_MAX_CHARS + 1,
    );
    expect(tooLong.length).toBeGreaterThan(DESCRIPTION_MAX_CHARS);
    expect(isValidDescription(tooLong, ref).ok).toBe(false);
  });

  test("when_to_use below WHEN_TO_USE_MIN_CHARS is rejected; at the bound is accepted", () => {
    const tooShort = "x".repeat(WHEN_TO_USE_MIN_CHARS - 1);
    // No leading/trailing whitespace (the validator trims before measuring).
    const atMin = "reach for it!".padEnd(WHEN_TO_USE_MIN_CHARS, "x");
    expect(isValidWhenToUse(tooShort, ref).ok).toBe(false);
    expect(atMin.length).toBe(WHEN_TO_USE_MIN_CHARS);
    expect(isValidWhenToUse(atMin, ref).ok).toBe(true);
  });
});

describe("authoringRulesForType states the canonical bounds (no prompt/validator drift)", () => {
  test("lesson block names the description AND when_to_use bounds", () => {
    const block = authoringRulesForType("lesson");
    expect(block).toContain(`${DESCRIPTION_MIN_CHARS}–${DESCRIPTION_MAX_CHARS}`);
    expect(block).toContain(`${WHEN_TO_USE_MIN_CHARS}–${WHEN_TO_USE_MAX_CHARS}`);
  });

  test("lesson block covers every hard rule that has a validator", () => {
    const block = authoringRulesForType("lesson").toLowerCase();
    // pseudo-frontmatter + single-fence (detectDoubleFrontmatter)
    expect(block).toContain("exactly two `---` fence");
    expect(block).toContain("do not restate");
    // when_to_use required + circular guard + differ (isValidWhenToUse / lessonContentQualityValidator)
    expect(block).toContain("when working with");
    expect(block).toContain("must be different from each other");
    // description shape (isValidDescription)
    expect(block).toContain("section-heading fragment");
    expect(block).toContain('start with "when"');
  });

  test("knowledge block has the frontmatter/description rules but NOT the when_to_use requirement", () => {
    const block = authoringRulesForType("knowledge").toLowerCase();
    expect(block).toContain("`description`");
    expect(block).toContain("exactly two `---` fence");
    expect(block).not.toContain("`when_to_use` is required");
  });

  test("unknown type still gets the universally-safe frontmatter/body rules, never empty over-claim", () => {
    // A type with no description/when_to_use mapping still must not silently
    // promise nothing; cross-cutting frontmatter rules always apply.
    const block = authoringRulesForType("script").toLowerCase();
    expect(block).toContain("exactly two `---` fence");
  });
});
