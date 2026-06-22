// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests proving that `authoringRulesForType` is injected as its own
 * prompt section into every improve/authoring prompt that creates or edits
 * an asset. Uses a lesson target so the full set of hard rules (frontmatter,
 * description, when_to_use) is exercised.
 *
 * Tests are pure string assertions — no spawn/serve/disk required.
 */

import { describe, expect, test } from "bun:test";
import { buildDistillPrompt } from "../src/commands/improve/distill";
import { buildProposePrompt, buildReflectPrompt, buildSchemaRepairPrompt } from "../src/integrations/agent/prompts";

/**
 * Distinctive substrings from FRONTMATTER_BODY_RULES in authoring-rules.ts.
 * Each one only appears in a prompt if authoringRulesForType was called and
 * its output injected. We pick two from different rule groups:
 *   - from FRONTMATTER_BODY_RULES (applies to ALL types including lesson)
 *   - from WHEN_TO_USE_RULES (applies to lesson only)
 */
const HARD_RULE_FRONTMATTER = "Do NOT restate `description:`";
const HARD_RULE_FENCE = "EXACTLY TWO `---` fence";
const HARD_RULE_WHEN_TO_USE = "when_to_use` is REQUIRED";

describe("authoring-rules injection", () => {
  describe("buildReflectPrompt (lesson type, type provided directly)", () => {
    const rendered = buildReflectPrompt({
      ref: "lesson:foo-lesson",
      type: "lesson",
      name: "foo-lesson",
      assetContent: "Some lesson body content here.",
    }).prompt;

    test("contains FRONTMATTER_BODY_RULES snippet", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("contains fence rule snippet", () => {
      expect(rendered).toContain(HARD_RULE_FENCE);
    });

    test("contains when_to_use REQUIRED rule", () => {
      expect(rendered).toContain(HARD_RULE_WHEN_TO_USE);
    });
  });

  describe("buildReflectPrompt (lesson type, type derived from ref prefix)", () => {
    // input.type is undefined — type must be derived from ref prefix "lesson"
    const rendered = buildReflectPrompt({
      ref: "lesson:foo-lesson",
      // type intentionally omitted
      assetContent: "Some lesson body content here.",
    }).prompt;

    test("contains FRONTMATTER_BODY_RULES snippet even when type is derived from ref", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("contains when_to_use REQUIRED rule even when type is derived from ref", () => {
      expect(rendered).toContain(HARD_RULE_WHEN_TO_USE);
    });
  });

  describe("buildProposePrompt (lesson type)", () => {
    const rendered = buildProposePrompt({
      type: "lesson",
      name: "foo-lesson",
      task: "Document what we learned about foos.",
    });

    test("contains FRONTMATTER_BODY_RULES snippet", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("contains fence rule snippet", () => {
      expect(rendered).toContain(HARD_RULE_FENCE);
    });

    test("contains when_to_use REQUIRED rule", () => {
      expect(rendered).toContain(HARD_RULE_WHEN_TO_USE);
    });
  });

  describe("buildSchemaRepairPrompt (lesson type)", () => {
    const rendered = buildSchemaRepairPrompt({
      ref: "lesson:foo-lesson",
      type: "lesson",
      name: "foo-lesson",
      reason: "missing description",
      assetContent: "---\nwhen_to_use: When foo is used.\n---\n\nBody text.",
    });

    test("contains FRONTMATTER_BODY_RULES snippet", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("contains fence rule snippet", () => {
      expect(rendered).toContain(HARD_RULE_FENCE);
    });

    test("contains when_to_use REQUIRED rule", () => {
      expect(rendered).toContain(HARD_RULE_WHEN_TO_USE);
    });
  });

  describe("buildDistillPrompt (lesson proposalKind, default)", () => {
    const rendered = buildDistillPrompt({
      inputRef: "skill:foo",
      assetContent: "Some skill body content.",
      feedback: [],
      // proposalKind omitted — defaults to "lesson" per the injection logic
    });

    test("contains FRONTMATTER_BODY_RULES snippet", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("contains fence rule snippet", () => {
      expect(rendered).toContain(HARD_RULE_FENCE);
    });

    test("contains when_to_use REQUIRED rule", () => {
      expect(rendered).toContain(HARD_RULE_WHEN_TO_USE);
    });
  });

  describe("buildDistillPrompt (lesson proposalKind, explicit)", () => {
    const rendered = buildDistillPrompt({
      inputRef: "skill:foo",
      assetContent: "Some skill body content.",
      feedback: [],
      proposalKind: "lesson",
    });

    test("contains FRONTMATTER_BODY_RULES snippet", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("contains when_to_use REQUIRED rule", () => {
      expect(rendered).toContain(HARD_RULE_WHEN_TO_USE);
    });
  });

  describe("non-lesson type: buildProposePrompt (knowledge)", () => {
    const rendered = buildProposePrompt({
      type: "knowledge",
      name: "foo-knowledge",
      task: "Document foo reference material.",
    });

    // knowledge has FRONTMATTER_BODY_RULES + DESCRIPTION_RULES but NOT when_to_use
    test("contains FRONTMATTER_BODY_RULES snippet for knowledge type", () => {
      expect(rendered).toContain(HARD_RULE_FRONTMATTER);
    });

    test("does NOT contain when_to_use REQUIRED rule for knowledge type", () => {
      expect(rendered).not.toContain(HARD_RULE_WHEN_TO_USE);
    });
  });
});
