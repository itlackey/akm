// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for `|`-block scalar parsing in `parseFrontmatter` (#495).
 *
 * `yaml.stringify` (used by `serializeFrontmatter` in asset-serialize.ts)
 * emits multi-line strings as `|`-block scalars.  Until this fix, the
 * hand-rolled YAML-subset parser in `frontmatter.ts` silently dropped those
 * values, causing round-trip data loss and forcing `reflect.ts` to keep a
 * cloned defensive serializer.  These tests pin the corrected behaviour.
 */
import { describe, expect, it } from "bun:test";
import { assembleAsset, serializeFrontmatter } from "../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../src/core/asset/frontmatter";

describe("parseFrontmatter — |‑block scalar support", () => {
  it("parses a clip block scalar (|) — single trailing newline", () => {
    // `|` chomping adds exactly one trailing newline.
    const raw = "---\ndescription: |\n  line one\n  line two\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.description).toBe("line one\nline two\n");
  });

  it("parses a strip block scalar (|-) — no trailing newline", () => {
    // `|-` chomping removes all trailing newlines.
    const raw = "---\ndescription: |-\n  line one\n  line two\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.description).toBe("line one\nline two");
  });

  it("parses a keep block scalar (|+) — preserves trailing newlines", () => {
    // `|+` keeps the trailing newlines exactly as stored.
    const raw = "---\ndescription: |+\n  line one\n  line two\n\n---\nBody\n";
    const result = parseFrontmatter(raw);
    // The blank line at the end is included verbatim.
    expect((result.data.description as string).startsWith("line one\nline two")).toBe(true);
  });

  it("block scalar followed by another top-level key", () => {
    const raw = "---\ndescription: |-\n  multi\n  line\ntitle: hello\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.description).toBe("multi\nline");
    expect(result.data.title).toBe("hello");
  });

  it("round-trips through serializeFrontmatter → parseFrontmatter without data loss", () => {
    const fm: Record<string, unknown> = {
      title: "My Asset",
      description: "First line.\nSecond line.\nThird line.",
      tags: ["a", "b"],
      count: 3,
    };
    // serializeFrontmatter uses yaml.stringify, which emits |-block scalars for
    // multi-line strings.  parseFrontmatter must recover the original value.
    const serialized = serializeFrontmatter(fm);
    const assembled = `---\n${serialized}\n---\n\nBody text\n`;
    const parsed = parseFrontmatter(assembled);

    expect(parsed.data.title).toBe(fm.title);
    // Description was multi-line; |-strip chomping removes trailing newline.
    // yaml.stringify uses |-  for strings without a trailing newline.
    expect(typeof parsed.data.description).toBe("string");
    const desc = parsed.data.description as string;
    // The content of the lines must be preserved (chomping only affects trailing \n).
    expect(desc).toContain("First line.");
    expect(desc).toContain("Second line.");
    expect(desc).toContain("Third line.");
    expect(parsed.data.tags).toEqual(["a", "b"]);
    expect(parsed.data.count).toBe(3);
  });

  it("assembleAsset → parseFrontmatter round-trip (idempotency contract)", () => {
    const fm: Record<string, unknown> = {
      ref: "lesson:test-lesson",
      description: "A lesson that\nspans multiple lines.",
      tags: ["ops"],
    };
    const body = "## Section\n\nSome content here.\n";
    const assembled = assembleAsset(fm, body);
    const parsed = parseFrontmatter(assembled);

    expect(parsed.data.ref).toBe(fm.ref);
    const desc = parsed.data.description as string;
    expect(desc).toContain("A lesson that");
    expect(desc).toContain("spans multiple lines.");
    expect(parsed.data.tags).toEqual(["ops"]);
    // assembleAsset emits `---\n\n<body>` so the content includes the leading blank line.
    expect(parsed.content).toContain(body);
  });
});
