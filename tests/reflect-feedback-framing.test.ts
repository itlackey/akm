// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure string-assertion tests for the reflect prompt:
 *
 *   1. Feedback lines are preceded by a caveat framing them as signals, not
 *      facts to insert (#952) — present iff `feedback` is non-empty.
 *   2. The truncation marker only appears in the rendered prompt when the
 *      asset content exceeds the active content budget (change B/C).
 *   3. A larger `contentBudgetChars` sends more of the asset content before
 *      truncating (change C).
 *   4. Reflect checks three fields and may change none: the prompt asks for a
 *      patch of `description`, `when_to_use` and title, and carries none of
 *      the sentences that demanded a change.
 *
 * No spawn/serve/disk required — mirrors the style of
 * tests/authoring-rules-injection.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  buildReflectOutputRepairPrompt,
  buildReflectPrompt,
  REFLECT_CONTENT_CAP,
  REFLECT_TRUNCATION_MARKER,
  reflectResponseContract,
} from "../src/integrations/agent/prompts";

const FEEDBACK_CAVEAT_SNIPPET = "It is a signal, not a fact to insert.";

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

  // #999: the framing used to offer "add a clearly marked `TODO: verify …`
  // placeholder or leave the section unchanged". A model took the first option
  // for a feedback line reporting that `akm show` had failed, and the TODO it
  // wrote became permanent memory content that a later distill pass built a
  // lesson on. "Needs no change" is the only instruction now.
  test("feedback that asks for information the asset lacks is answered with 'needs no change', never a TODO placeholder (#999)", () => {
    const rendered = buildReflectPrompt({
      ref: "memories/foo",
      type: "memory",
      name: "foo",
      assetContent: "Existing body.",
      feedback: ["Ambiguous ref has multiple physical owners and cannot be shown reliably"],
    }).prompt;
    // The framing paragraph: from its first sentence up to the feedback list.
    const framing = rendered.slice(
      rendered.indexOf("Feedback describes"),
      rendered.indexOf("Recent feedback / signals:"),
    );
    expect(framing).toContain(FEEDBACK_CAVEAT_SNIPPET);
    expect(framing).toContain("asking for information the asset lacks, needs no change");
    expect(framing).not.toMatch(/TODO|placeholder/i);
  });
});

describe("buildReflectPrompt — content budget / truncation marker (#952)", () => {
  // The cap notice closes the shown asset content.
  const capNotice = `\n${REFLECT_TRUNCATION_MARKER}\n\n\`\`\``;

  test("marker is absent when content is within the default cap", () => {
    const body = "x".repeat(REFLECT_CONTENT_CAP - 1);
    const rendered = buildReflectPrompt({
      ref: "knowledge/foo",
      type: "knowledge",
      name: "foo",
      assetContent: body,
    }).prompt;
    expect(rendered).not.toContain(capNotice);
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
    expect(rendered).toContain(capNotice);
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
    expect(rendered).not.toContain(capNotice);
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
    expect(small).toContain(capNotice);
    expect(large).toContain(capNotice);
  });
});

describe("buildReflectPrompt — a patch of three fields, and 'nothing to change' is an answer", () => {
  const input = { ref: "knowledge/foo", type: "knowledge", name: "foo", assetContent: "Existing body." };

  test.each(["lesson", "skill", "knowledge"])("one goal sentence covers a %s asset", (type) => {
    const rendered = buildReflectPrompt({ ...input, type, ref: `${type}s/foo` }).prompt;
    expect(rendered).toContain(
      `Your task is to check this ${type} asset's \`description\`, \`when_to_use\` and title against its body and the feedback below, and fix any that is missing, broken, or claims something the body does not cover. AKM keeps the body exactly as it is: you change only these fields, and when none needs a change you return null for each.`,
    );
  });

  test("with no feedback the prompt says to fix only a missing or broken field", () => {
    const rendered = buildReflectPrompt(input).prompt;
    expect(rendered).toContain(
      "No usage feedback recorded. Fix only a missing or broken `description`, `when_to_use` or title; otherwise return null for each.",
    );
  });

  test("a rejected proposal is not to be proposed again, and null is the answer when nothing else is justified", () => {
    const rendered = buildReflectPrompt({
      ...input,
      rejectedProposals: [{ ref: "knowledge/foo", reason: "not an improvement", contentPreview: "preview" }],
    }).prompt;
    expect(rendered).toContain(
      "Do not propose the same change again; if no other change is justified, return null for each field.",
    );
  });

  test("akm names the problems it can see: a stray-period description, no when_to_use, no title", () => {
    const rendered = buildReflectPrompt({
      ...input,
      assetContent: "---\ndescription: The indexer needs explicit calls. asset writes go stale.\n---\nBody text.\n",
    }).prompt;
    expect(rendered).toContain("akm found these problems in the asset; fix each one:");
    expect(rendered).toContain(
      'a stray period splits a sentence ("The indexer needs explicit calls. asset writes go stale.")',
    );
    expect(rendered).toContain(
      "there is no `when_to_use`: write one, a single sentence the body supports, saying when to reach for this asset",
    );
    expect(rendered).toContain("the body has no level-1 title: give one in `title`");
  });

  test("an escaped quote breaks a description; an abbreviation's period does not", () => {
    const quoted = buildReflectPrompt({
      ...input,
      assetContent:
        '---\ndescription: "\\"Three modes: command" (shell) and workflow."\nwhen_to_use: When choosing a mode.\n---\n# Modes\n',
    }).prompt;
    expect(quoted).toContain("the `description` is broken by an escaped quote");
    const clean = buildReflectPrompt({
      ...input,
      assetContent:
        "---\ndescription: Compares bun vs. node, e.g. their startup times.\nwhen_to_use: When picking a runtime.\n---\n# Runtimes\n",
    }).prompt;
    expect(clean).toContain(
      "akm found no missing or broken field: return null for each unless the feedback shows one claims more than the body covers.",
    );
  });

  test("none of the sentences that demanded a change, or a body rewrite, is left", () => {
    const rendered = buildReflectPrompt({
      ...input,
      type: "skill",
      ref: "skills/foo",
      feedback: ["did not help"],
      rejectedProposals: [{ ref: "skills/foo", reason: "not an improvement" }],
      priorDraft: "a previous reply",
      assetContent: "x".repeat(2000),
    }).prompt;
    for (const removed of [
      "must correct or add something the source lacks",
      "Do not reproduce the source content",
      "must meaningfully differ",
      "do not return the same content unchanged",
      "you MUST generate",
      "Content preservation rules",
      "Related distilled lessons",
      "companion reference",
      "knowledge/skills/<skill>/references",
    ]) {
      expect(rendered).not.toContain(removed);
    }
  });
});

describe("the reflect output contract — a patch and no body", () => {
  test("the JSON contract asks for confidence and a patch of description, when_to_use and title", () => {
    const targeted = reflectResponseContract("json_schema", true);
    expect(targeted).toContain("exactly the required fields `confidence` and `frontmatterPatch`");
    expect(targeted).toContain("exactly `description`, `when_to_use` and `title`");
    expect(targeted).not.toContain("content");
    expect(reflectResponseContract("json_schema", false)).toContain("`ref`, `confidence`, and `frontmatterPatch`");
  });

  test("the framed contract is header lines only: no content markers, a `title` in the patch", () => {
    const framed = reflectResponseContract("framed_markdown", false);
    expect(framed).toContain("AKM_REFLECT_REF: <selected asset ref>");
    expect(framed).toContain(
      'AKM_REFLECT_FRONTMATTER_PATCH: {"description": null, "when_to_use": null, "title": null}',
    );
    expect(framed).not.toContain("AKM_REFLECT_CONTENT");
    expect(reflectResponseContract("framed_markdown", true)).not.toContain("AKM_REFLECT_REF");
  });

  test("the repair prompt asks to keep the values, not markdown, and carries the contract", () => {
    for (const mode of ["json_schema", "framed_markdown"] as const) {
      const contract = reflectResponseContract(mode, true);
      const repair = buildReflectOutputRepairPrompt(mode, true);
      expect(repair).toContain(contract);
      expect(repair.replace(contract, "")).toContain("Keep its proposed values as they are");
      expect(repair.replace(contract, "")).not.toMatch(/markdown/i);
      expect(contract).not.toContain(REFLECT_TRUNCATION_MARKER);
    }
  });
});
