// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure string-assertion tests for the #952 reflect prompt changes:
 *
 *   1. Feedback lines are preceded by a caveat framing them as unverified
 *      signals, not facts to insert (buildReflectPrompt change A) — present
 *      iff `feedback` is non-empty.
 *   2. The truncation marker only appears in the rendered prompt when the
 *      asset content exceeds the active content budget (change B/C).
 *   3. A larger `contentBudgetChars` sends more of the asset content before
 *      truncating (change C).
 *
 * No spawn/serve/disk required — mirrors the style of
 * tests/authoring-rules-injection.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { buildReflectPrompt, REFLECT_CONTENT_CAP, REFLECT_TRUNCATION_MARKER } from "../src/integrations/agent/prompts";

const FEEDBACK_CAVEAT_SNIPPET = "It is a signal to investigate, not a fact to insert.";

describe("buildReflectPrompt — feedback framing (#952)", () => {
  test("caveat is present when feedback is non-empty", () => {
    const rendered = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: "Existing body.",
      feedback: ["the storage section does not say which disk backs /data"],
    }).prompt;
    expect(rendered).toContain(FEEDBACK_CAVEAT_SNIPPET);
  });

  test("caveat is absent when feedback is empty and a ref is set (schema-only branch)", () => {
    const rendered = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: "Existing body.",
      feedback: [],
    }).prompt;
    expect(rendered).not.toContain(FEEDBACK_CAVEAT_SNIPPET);
  });

  test("caveat is absent when no feedback and no ref (the '(no feedback events recorded)' branch)", () => {
    const rendered = buildReflectPrompt({
      assetContent: "Existing body.",
    }).prompt;
    expect(rendered).not.toContain(FEEDBACK_CAVEAT_SNIPPET);
    expect(rendered).toContain("(no feedback events recorded)");
  });

  test("caveat is absent on the skill related-lessons-only branch", () => {
    const rendered = buildReflectPrompt({
      ref: "skills/foo",
      type: "skill",
      name: "foo",
      assetContent: "Existing skill body.",
      relatedLessons: [{ ref: "lessons/foo-lesson", content: "Some distilled lesson." }],
    }).prompt;
    expect(rendered).not.toContain(FEEDBACK_CAVEAT_SNIPPET);
  });
});

describe("buildReflectPrompt — content budget / truncation marker (#952)", () => {
  test("marker is absent when content is within the default cap", () => {
    const body = "x".repeat(REFLECT_CONTENT_CAP - 1);
    const rendered = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: body,
    }).prompt;
    expect(rendered).not.toContain(REFLECT_TRUNCATION_MARKER);
    expect(rendered).toContain("Current asset content (verbatim):");
  });

  test("marker is present when content exceeds the default cap", () => {
    const body = "x".repeat(REFLECT_CONTENT_CAP + 500);
    const rendered = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: body,
    }).prompt;
    expect(rendered).toContain(REFLECT_TRUNCATION_MARKER);
  });

  test("a caller-supplied contentBudgetChars raises the cap: no truncation for content the default cap would have truncated", () => {
    const body = "x".repeat(REFLECT_CONTENT_CAP + 500);
    const rendered = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: body,
      contentBudgetChars: REFLECT_CONTENT_CAP + 1000,
    }).prompt;
    expect(rendered).not.toContain(REFLECT_TRUNCATION_MARKER);
    expect(rendered).toContain(body);
  });

  test("a larger contentBudgetChars sends strictly more asset content than a smaller one", () => {
    const body = "y".repeat(REFLECT_CONTENT_CAP * 3);
    const small = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: body,
      contentBudgetChars: REFLECT_CONTENT_CAP,
    }).prompt;
    const large = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: body,
      contentBudgetChars: REFLECT_CONTENT_CAP * 2,
    }).prompt;
    expect(large.length).toBeGreaterThan(small.length);
    expect(small).toContain(REFLECT_TRUNCATION_MARKER);
    expect(large).toContain(REFLECT_TRUNCATION_MARKER);
  });
});
