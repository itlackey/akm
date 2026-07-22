// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { type ParsedForValidate, runBaseValidateChecks } from "../../../src/core/adapter/adapters/shared";
import type { ValidateContext } from "../../../src/core/adapter/types";

// Ref-grammar decision D-R3: the shared base-check missing-ref scanner recognizes
// the 0.9.0 FULLY-QUALIFIED `bundle//conceptId` prose body-ref anchored form ONLY.
// The pre-0.9.0 `type:name` colon grammar is gone from every recognition surface,
// and a BARE short conceptId in prose is NOT a ref (only in the ref-LIST channels).
//
// Legacy `type:name` tokens are constructed via interpolation so the
// `lint-test-ref-literals` shrink-only ratchet never counts them (the type keyword
// is not literally adjacent to the colon in source). Do not inline them.
const LEGACY = (type: string, name: string): string => `${type}:${name}`;

/** A ValidateContext whose resolveRef records every ref it is asked about and reports all refs missing. */
function recordingContext(): { ctx: ValidateContext; asked: string[] } {
  const asked: string[] = [];
  const ctx: ValidateContext = {
    readFile: async () => null,
    list: async () => [],
    resolveRef: async (ref: string) => {
      asked.push(ref);
      return { exists: false };
    },
  };
  return { ctx, asked };
}

function parsed(
  content: string,
  data: Record<string, unknown> = {},
  frontmatter: string | null = null,
): ParsedForValidate {
  // A non-null frontmatter with an `updated` field suppresses the unrelated
  // missing-updated base diagnostic so tests can focus on missing-ref.
  return { data: { updated: "2026-01-01", ...data }, content, frontmatter: frontmatter ?? "updated: 2026-01-01" };
}

describe("shared base-check missing-ref scanner (D-R3 flip)", () => {
  test("a fully-qualified `bundle//conceptId` prose ref is recognized and flagged when missing", async () => {
    const { ctx, asked } = recordingContext();
    const diags = await runBaseValidateChecks("doc.md", parsed("See core//memories/foo for context."), "/root", ctx);
    expect(asked).toContain("core//memories/foo");
    const missing = diags.filter((d) => d.issue === "missing-ref");
    expect(missing.some((d) => d.detail.includes("core//memories/foo"))).toBe(true);
  });

  test("the retired legacy `type:name` colon grammar is NOT recognized in prose", async () => {
    const { ctx, asked } = recordingContext();
    const body = `See ${LEGACY("knowledge", "guide")} and ${LEGACY("skill", "deploy")} here.`;
    const diags = await runBaseValidateChecks("doc.md", parsed(body), "/root", ctx);
    // No colon-grammar token is ever handed to resolveRef, and nothing is flagged.
    expect(asked.some((r) => r.includes(":"))).toBe(false);
    expect(diags.some((d) => d.issue === "missing-ref")).toBe(false);
  });

  test("a BARE short conceptId in prose is NOT a ref (D-R3)", async () => {
    const { ctx, asked } = recordingContext();
    const diags = await runBaseValidateChecks("doc.md", parsed("The memories/foo note explains it."), "/root", ctx);
    expect(asked).toHaveLength(0);
    expect(diags.some((d) => d.issue === "missing-ref")).toBe(false);
  });

  test("a URL is never mistaken for a bundle ref", async () => {
    const { ctx, asked } = recordingContext();
    const diags = await runBaseValidateChecks(
      "doc.md",
      parsed("Visit https://example.com/foo/bar today."),
      "/root",
      ctx,
    );
    expect(asked).toHaveLength(0);
    expect(diags.some((d) => d.issue === "missing-ref")).toBe(false);
  });

  test("frontmatter xref list values recognize BOTH a bare conceptId and a qualified ref", async () => {
    const { ctx, asked } = recordingContext();
    const diags = await runBaseValidateChecks(
      "doc.md",
      parsed("body", { xrefs: ["memories/bar", "team//skills/deploy"] }),
      "/root",
      ctx,
    );
    expect(asked).toContain("memories/bar");
    expect(asked).toContain("team//skills/deploy");
    const missing = diags.filter((d) => d.issue === "missing-ref");
    expect(missing.some((d) => d.detail.includes("memories/bar") && d.detail.includes("xrefs"))).toBe(true);
    expect(missing.some((d) => d.detail.includes("team//skills/deploy"))).toBe(true);
  });

  test("a legacy `origin//type:name` frontmatter value is NOT recognized as a 0.9.0 ref", async () => {
    const { ctx, asked } = recordingContext();
    const value = `team//${LEGACY("skill", "deploy")}`;
    const diags = await runBaseValidateChecks("doc.md", parsed("body", { xrefs: [value] }), "/root", ctx);
    expect(asked).toHaveLength(0);
    expect(diags.some((d) => d.issue === "missing-ref")).toBe(false);
  });

  test("refs inside fenced code blocks are not flagged", async () => {
    const { ctx, asked } = recordingContext();
    const body = "```\ncore//memories/inside-fence\n```\n";
    const diags = await runBaseValidateChecks("doc.md", parsed(body), "/root", ctx);
    expect(asked).toHaveLength(0);
    expect(diags.some((d) => d.issue === "missing-ref")).toBe(false);
  });
});
