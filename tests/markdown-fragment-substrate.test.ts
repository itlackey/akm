// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure Markdown-fragment-splitting coverage, extracted from the former
 * `tests/integration/fts/markdown-fragment-retrieval.test.ts` (index-redesign
 * B5c deleted that file's `entries_fts`/`entry_fragments_fts`-backed "isolated
 * lexical Markdown fragments (#937)" describe block alongside those tables).
 * `splitMarkdownFragments` itself is untouched by the redesign — it is the
 * substrate both `entry_fragments`'s safe-content projection and
 * `deriveUnits`'s fragment units are built from — and opens no database, so
 * it belongs under `tests/`, not `tests/integration/` (AGENTS.md's
 * classification rule).
 */
import { describe, expect, test } from "bun:test";
import { splitMarkdownFragments } from "../src/core/asset/markdown-fragments";
import { projectMarkdownFragmentContent } from "../src/indexer/passes/metadata";

describe("Markdown fragment substrate", () => {
  test("preserves preamble/duplicate headings and real source lines while removing unsafe bytes", () => {
    const raw = [
      "---",
      "description: fixture",
      "---",
      "preamble evidence",
      "",
      "# Same",
      "first heading evidence",
      "",
      "# Same",
      "second heading evidence",
      "",
      "```text",
      "FENCED_SECRET",
      "```",
      "[private]: https://secret.invalid/token",
    ].join("\n");
    const safe = projectMarkdownFragmentContent(raw)!;
    const fragments = splitMarkdownFragments(safe);
    expect(fragments.map((fragment) => fragment.startLine)).toContain(4);
    expect(fragments.find((fragment) => fragment.text.includes("first heading"))?.headingSlug).toBe("same");
    expect(fragments.find((fragment) => fragment.text.includes("second heading"))?.headingSlug).toBe("same-1");
    expect(safe).not.toContain("FENCED_SECRET");
    expect(safe).not.toContain("secret.invalid");
  });

  test("uses paragraph then word windows for headingless oversized transcripts", () => {
    const raw = Array.from({ length: 300 }, (_, index) => `Transcript ${index} carries ordinary evidence.`).join(
      "\n\n",
    );
    const fragments = splitMarkdownFragments(projectMarkdownFragmentContent(raw)!);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.every((fragment) => fragment.fragmentId.startsWith("akm-fragment-"))).toBe(true);
    expect(fragments.some((fragment) => fragment.text.includes("Transcript 150"))).toBe(true);
  });

  test("keeps friendly selectors for many independent headed sections", () => {
    const count = 1_200;
    const raw = Array.from({ length: count }, (_, index) => `## Heading ${index}\nproof ${index}`).join("\n\n");
    const fragments = splitMarkdownFragments(raw);
    expect(fragments).toHaveLength(count);
    expect(fragments.map((fragment) => fragment.headingSlug)).toEqual(
      Array.from({ length: count }, (_, index) => `heading-${index}`),
    );
  });

  test("caps single-line word windows while retaining their source-line range", () => {
    const fragments = splitMarkdownFragments(`line ${"word ".repeat(1000)}`, 100);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.every((fragment) => fragment.text.length <= 100)).toBe(true);
    expect(fragments.every((fragment) => fragment.startLine === 1 && fragment.endLine === 1)).toBe(true);
  });
});
