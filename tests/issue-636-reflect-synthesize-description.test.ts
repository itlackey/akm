// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #636 — reflect must not emit proposals that fail the promote-time
 * `description` gate just because the SOURCE asset had no frontmatter
 * `description` (e.g. scraped docs: `source`/`title`/`scraped` but no
 * `description`).
 *
 * The fix is GENERATION-TIME only:
 *   1. `buildReflectPrompt` injects a synthesize-a-description instruction when
 *      the source lacks a non-empty `description` and the type requires one.
 *   2. `sanitizeReflectPayload` (reflect proposal-build path) derives a valid
 *      `description` DETERMINISTICALLY from `title`/heading when the proposal
 *      still lacks one — BEFORE the proposal is created. The validator /
 *      promote / repair path is unchanged.
 *
 * These tests are pure string/object assertions — no spawn/serve/LLM/disk.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeReflectPayload } from "../src/commands/improve/reflect";
import { isValidDescription } from "../src/commands/proposal/validators/proposal-quality-validators";
import { parseFrontmatter } from "../src/core/asset/frontmatter";
import { buildReflectPrompt } from "../src/integrations/agent/prompts";

// Distinctive substring of the #636 synthesize-a-description instruction.
const SYNTH_INSTRUCTION = "synthesize a `description`".toLowerCase();
const SYNTH_HEADER = "REQUIRED — synthesize a `description`";

// A scraped-doc shape: frontmatter with source/title/scraped but NO description.
const SCRAPED_SOURCE = [
  "---",
  "source: https://pagedjs.org/en/documentation/8-named-page/",
  "title: Paged.js — Named Page",
  "scraped: 2025-11-07T00:00:00Z",
  "language: en",
  "status: active",
  "---",
  "# Named Page",
  "> **When to use:** you need a differently-sized page in a print layout.",
  "",
  "Named pages let you assign a specific page size and margins to a section of content.",
].join("\n");

describe("#636 buildReflectPrompt — synthesize-description instruction", () => {
  test("knowledge source WITHOUT description → instruction is injected", () => {
    const { prompt } = buildReflectPrompt({
      ref: "knowledge:documentation/pagedjs/pagedjs_named_page",
      type: "knowledge",
      name: "documentation/pagedjs/pagedjs_named_page",
      assetContent: SCRAPED_SOURCE,
    });
    expect(prompt).toContain(SYNTH_HEADER);
    expect(prompt.toLowerCase()).toContain(SYNTH_INSTRUCTION);
    // The bounds are spelled out so the model knows the gate it must satisfy.
    expect(prompt).toContain("20–400 characters");
  });

  test("type derived from ref prefix (type omitted) still injects instruction", () => {
    const { prompt } = buildReflectPrompt({
      ref: "knowledge:documentation/pagedjs/pagedjs_named_page",
      assetContent: SCRAPED_SOURCE,
    });
    expect(prompt).toContain(SYNTH_HEADER);
  });

  test("source that ALREADY has a valid description → no instruction (no double-injection)", () => {
    const withDesc = [
      "---",
      "title: Paged.js — Named Page",
      "description: Named pages assign a specific page size and margins to a section of print content.",
      "---",
      "# Named Page",
      "Body text.",
    ].join("\n");
    const { prompt } = buildReflectPrompt({
      ref: "knowledge:documentation/pagedjs/pagedjs_named_page",
      type: "knowledge",
      name: "documentation/pagedjs/pagedjs_named_page",
      assetContent: withDesc,
    });
    expect(prompt).not.toContain(SYNTH_HEADER);
  });

  test("empty-string description in source IS treated as missing → instruction injected", () => {
    const emptyDesc = ["---", "title: Foo", "description: ", "---", "# Foo", "Body."].join("\n");
    const { prompt } = buildReflectPrompt({
      ref: "knowledge:foo",
      type: "knowledge",
      name: "foo",
      assetContent: emptyDesc,
    });
    expect(prompt).toContain(SYNTH_HEADER);
  });

  test("type that does NOT require a description → no instruction", () => {
    // `script` is not in DESCRIPTION_TYPES (requiresDescription === false).
    const { prompt } = buildReflectPrompt({
      ref: "script:foo",
      type: "script",
      name: "foo",
      assetContent: "---\ntitle: Foo\n---\n# Foo\nBody.",
    });
    expect(prompt).not.toContain(SYNTH_HEADER);
  });
});

describe("#636 sanitizeReflectPayload — deterministic description fallback", () => {
  test("proposal lacking a description gets a valid one derived from source title/heading", () => {
    // The model echoed the description-less source frontmatter and a body.
    const result = sanitizeReflectPayload(
      { content: "# Named Page\n\nNamed pages assign a specific page size and margins to a section of content." },
      SCRAPED_SOURCE,
      "knowledge:documentation/pagedjs/pagedjs_named_page",
    );
    expect(result.reject).toBeUndefined();
    const fm = parseFrontmatter(result.content).data;
    expect(typeof fm.description).toBe("string");
    expect(
      isValidDescription(fm.description, "knowledge:documentation/pagedjs/pagedjs_named_page", {
        skipRefTailCheck: true,
      }).ok,
    ).toBe(true);
    // Derived deterministically from the title (not free-form invention).
    expect((fm.description as string).toLowerCase()).toContain("named page");
    expect(result.warnings.some((w) => w.includes("#636"))).toBe(true);
  });

  test("derived description PASSES isValidDescription (the gate that was rejecting before)", () => {
    const result = sanitizeReflectPayload(
      { content: "# Named Page\n\nBody describing named pages in detail across several useful sentences." },
      SCRAPED_SOURCE,
      "knowledge:pagedjs_named_page",
    );
    const fm = parseFrontmatter(result.content).data;
    const check = isValidDescription(fm.description, "knowledge:pagedjs_named_page", { skipRefTailCheck: true });
    expect(check.ok).toBe(true);
  });

  test("proposal that ALREADY has a valid description is NOT overridden", () => {
    const existing = "A precise, human-authored description of the named-page feature in Paged.js print layouts.";
    const result = sanitizeReflectPayload(
      {
        content: "# Named Page\n\nBody.",
        frontmatter: { description: existing },
      },
      SCRAPED_SOURCE,
      "knowledge:pagedjs_named_page",
    );
    const fm = parseFrontmatter(result.content).data;
    expect(fm.description).toBe(existing);
    expect(result.warnings.some((w) => w.includes("#636"))).toBe(false);
  });

  test("type that does not require a description → no fallback injected", () => {
    // No description, type does not require one; nothing is fabricated.
    const result = sanitizeReflectPayload(
      { content: "echo hello" },
      "---\ntitle: A Script\n---\necho hi",
      "script:foo",
    );
    const fm = parseFrontmatter(result.content).data;
    expect(fm.description).toBeUndefined();
  });
});
