import { afterEach, describe, expect, it, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildSessionAssetContent } from "../src/commands/improve/session-asset";
import { buildMemoryFrontmatter, parseEnrichObserved } from "../src/commands/remember";
import { assembleAsset, serializeFrontmatter } from "../src/core/asset/asset-serialize";
import {
  mutateFrontmatter,
  parseFrontmatter,
  parseFrontmatterBlock,
  parseYamlScalar,
  readFrontmatterDate,
} from "../src/core/asset/frontmatter";
import { checkUnquotedDescriptionColon } from "../src/core/asset/frontmatter-lint";
import { asNonEmptyString } from "../src/core/common";
import type { SessionData } from "../src/integrations/session-logs/types";
import { makeSandboxDir, type SandboxedDir } from "./_helpers/sandbox";

// ── parseFrontmatter ────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses basic frontmatter with key-value pairs", () => {
    const raw = "---\ntitle: Hello\ndescription: A test\n---\nBody content\n";
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe("Hello");
    expect(result.data.description).toBe("A test");
    expect(result.content).toBe("Body content\n");
    expect(result.frontmatter).not.toBeNull();
  });

  test("returns empty data and full content when no frontmatter", () => {
    const raw = "Just some text\nNo frontmatter here\n";
    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({});
    expect(result.content).toBe(raw);
    expect(result.frontmatter).toBeNull();
    expect(result.bodyStartLine).toBe(1);
  });

  test("parses boolean values", () => {
    const raw = "---\nenabled: true\ndisabled: false\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.enabled).toBe(true);
    expect(result.data.disabled).toBe(false);
  });

  test("parses numeric values", () => {
    const raw = "---\ncount: 42\npi: 3.14\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.count).toBe(42);
    expect(result.data.pi).toBe(3.14);
  });

  test("parses quoted string values", () => {
    const raw = "---\ntitle: \"Hello World\"\nsingle: 'test'\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe("Hello World");
    expect(result.data.single).toBe("test");
  });

  test("parses nested key-value pairs", () => {
    const raw = "---\npolicy:\n  allow: Read,Glob\n  deny: Write\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.policy).toEqual({ allow: "Read,Glob", deny: "Write" });
  });

  test("handles empty frontmatter block", () => {
    const raw = "---\n\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({});
    expect(result.content).toBe("Body\n");
  });

  test("handles keys with hyphens", () => {
    const raw = "---\nmodel-hint: gpt-4\ntool-policy: allow\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data["model-hint"]).toBe("gpt-4");
    expect(result.data["tool-policy"]).toBe("allow");
  });

  test("handles empty value (starts nested object)", () => {
    const raw = "---\noptions:\n  verbose: true\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.options).toEqual({ verbose: true });
  });

  test("bodyStartLine is correct", () => {
    const raw = "---\ntitle: X\ndesc: Y\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.bodyStartLine).toBe(5);
  });

  test("handles CRLF line endings", () => {
    const raw = "---\r\ntitle: Test\r\n---\r\nBody\r\n";
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe("Test");
    expect(result.content).toContain("Body");
  });

  // ── List / array support ───────────────────────────────────────────────────

  test("parses flow array (inline style)", () => {
    const raw = "---\ntags: [ops, networking, deploy]\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["ops", "networking", "deploy"]);
  });

  test("parses block-sequence (- item style)", () => {
    const raw = "---\ntags:\n- ops\n- networking\n- deploy\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["ops", "networking", "deploy"]);
  });

  test("parses block-sequence with 2-space indent", () => {
    const raw = "---\ntags:\n  - ops\n  - networking\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["ops", "networking"]);
  });

  test("parses block-sequence with scalar values (bool, number)", () => {
    const raw = "---\nvalues:\n- true\n- 42\n- hello\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.values).toEqual([true, 42, "hello"]);
  });

  test("parses empty flow array", () => {
    const raw = "---\ntags: []\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual([]);
  });

  test("block sequence followed by another top-level key", () => {
    const raw = "---\ntags:\n- ops\n- networking\ndescription: A test\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["ops", "networking"]);
    expect(result.data.description).toBe("A test");
  });

  test("mixed styles: flow array and block sequence in same document", () => {
    const raw = "---\ntags: [ops, networking]\naliases:\n- op\n- net\ndescription: test\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["ops", "networking"]);
    expect(result.data.aliases).toEqual(["op", "net"]);
    expect(result.data.description).toBe("test");
  });

  test("empty value with no continuation remains null", () => {
    const raw = "---\ntitle: Hello\nempty:\ndescription: test\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe("Hello");
    expect(result.data.empty).toBeNull();
    expect(result.data.description).toBe("test");
  });

  test("single-item block sequence", () => {
    const raw = "---\ntags:\n- solo\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["solo"]);
  });

  test("plain-style multi-line scalar folds continuation lines into one string", () => {
    // YAML plain scalars wrap with 2-space indent; the parser must fold them.
    const raw =
      "---\ndescription: Use 4-colon outer containers when mixing\n  nesting depths in markdown-it-container plugins.\ntags:\n- markdown\n---\nBody\n";
    const result = parseFrontmatter(raw);
    expect(result.data.description).toBe(
      "Use 4-colon outer containers when mixing nesting depths in markdown-it-container plugins.",
    );
    expect(result.data.tags).toEqual(["markdown"]);
    expect(result.content).toBe("Body\n");
  });

  test("plain-style scalar continuation: multiple continuation lines all folded", () => {
    const raw = "---\ndescription: First line\n  second line\n  third line.\ntitle: After\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.description).toBe("First line second line third line.");
    expect(result.data.title).toBe("After");
  });
});

// ── parseFrontmatterBlock ───────────────────────────────────────────────────

describe("parseFrontmatterBlock", () => {
  test("returns null for content without frontmatter delimiters", () => {
    expect(parseFrontmatterBlock("No frontmatter")).toBeNull();
  });

  test("returns null for content that doesn't start with ---", () => {
    expect(parseFrontmatterBlock("text\n---\nfoo\n---\n")).toBeNull();
  });

  test("extracts frontmatter and content correctly", () => {
    const result = parseFrontmatterBlock("---\nkey: val\n---\nbody\n");
    expect(result).not.toBeNull();
    expect(result?.frontmatter).toBe("key: val");
    expect(result?.content).toBe("body\n");
  });

  test("handles frontmatter without trailing content", () => {
    const result = parseFrontmatterBlock("---\nkey: val\n---\n");
    expect(result).not.toBeNull();
    expect(result?.frontmatter).toBe("key: val");
    expect(result?.content).toBe("");
  });
});

// ── mutateFrontmatter ───────────────────────────────────────────────────────
//
// SPEC-5 (stash-conventions-code-spec.md): a frontmatter mutation is a
// METADATA edit, not a content edit. When the file already has a frontmatter
// block, only the block is replaced and the body bytes are kept verbatim —
// including a writer's single-newline fence-to-body separator and a missing
// trailing newline, both of which routing through `assembleAsset` would
// silently re-normalize. Files gaining their FIRST block still take the
// canonical `assembleAsset` shape.

describe("mutateFrontmatter", () => {
  const disposers: SandboxedDir[] = [];

  afterEach(() => {
    for (const d of disposers.splice(0)) d.cleanup();
  });

  function writeTmpFile(content: string): string {
    const sandbox = makeSandboxDir("akm-mutate-fm");
    disposers.push(sandbox);
    const filePath = path.join(sandbox.dir, "asset.md");
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  test("existing block: body bytes preserved verbatim (single-newline separator, no trailing newline)", () => {
    // Hot-path writer shape: one newline after the closing fence, body does
    // not end in a newline. assembleAsset would insert a blank-line separator
    // and force a trailing newline — a whitespace content edit.
    const body = "Body line without trailing newline";
    const filePath = writeTmpFile(`---\ncaptureMode: hot\n---\n${body}`);

    const wrote = mutateFrontmatter(filePath, (parsed) => ({ ...parsed.data, beliefState: "superseded" }));
    expect(wrote).toBe(true);

    const raw = fs.readFileSync(filePath, "utf8");
    const block = parseFrontmatterBlock(raw);
    expect(block?.content).toBe(body);
    expect(raw.endsWith("\n")).toBe(false);
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("superseded");
  });

  test("existing block: leading blank lines in the body survive the round-trip", () => {
    const filePath = writeTmpFile("---\nk: v\n---\n\n\nSpaced body.\n");
    const before = parseFrontmatterBlock(fs.readFileSync(filePath, "utf8"));

    mutateFrontmatter(filePath, (parsed) => ({ ...parsed.data, extra: 1 }));

    const after = parseFrontmatterBlock(fs.readFileSync(filePath, "utf8"));
    expect(after?.content).toBe(before?.content);
  });

  test("file gaining its FIRST block uses the canonical assembleAsset shape", () => {
    const filePath = writeTmpFile("Plain incumbent body.\n");

    const wrote = mutateFrontmatter(filePath, (parsed) => ({ ...parsed.data, beliefState: "superseded" }));
    expect(wrote).toBe(true);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.beliefState).toBe("superseded");
    expect(parsed.content.replace(/^\n+/, "")).toBe("Plain incumbent body.\n");
  });

  test("mutator returning null skips the write and leaves the file byte-identical", () => {
    const original = "---\nk: v\n---\nBody.\n";
    const filePath = writeTmpFile(original);

    const wrote = mutateFrontmatter(filePath, () => null);
    expect(wrote).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  test("refuses to serialize a lenient parse of malformed frontmatter", () => {
    const original = '---\nsource: memory:parent\ntitle: "unterminated\ntags:\n  - keep-me\n---\nBody.\n';
    const filePath = writeTmpFile(original);

    expect(() => mutateFrontmatter(filePath, (parsed) => ({ ...parsed.data, source: "memories/parent" }))).toThrow(
      /malformed YAML frontmatter/i,
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });
});

// ── parseYamlScalar ─────────────────────────────────────────────────────────

describe("parseYamlScalar", () => {
  test("returns empty string for empty input", () => {
    expect(parseYamlScalar("")).toBe("");
  });

  test("returns boolean for true/false", () => {
    expect(parseYamlScalar("true")).toBe(true);
    expect(parseYamlScalar("false")).toBe(false);
  });

  test("returns number for numeric strings", () => {
    expect(parseYamlScalar("42")).toBe(42);
    expect(parseYamlScalar("3.14")).toBe(3.14);
    expect(parseYamlScalar("0")).toBe(0);
    expect(parseYamlScalar("-1")).toBe(-1);
  });

  test("strips quotes from quoted strings", () => {
    expect(parseYamlScalar('"hello"')).toBe("hello");
    expect(parseYamlScalar("'world'")).toBe("world");
  });

  test("returns plain string for unquoted non-boolean non-numeric", () => {
    expect(parseYamlScalar("hello")).toBe("hello");
    expect(parseYamlScalar("some-value")).toBe("some-value");
  });

  test("does not strip mismatched quotes", () => {
    expect(parseYamlScalar("\"hello'")).toBe("\"hello'");
  });
});

// ── asNonEmptyString (was: toStringOrUndefined) ──────────────────────────────

describe("asNonEmptyString", () => {
  test("returns string for non-empty string", () => {
    expect(asNonEmptyString("hello")).toBe("hello");
  });

  test("returns undefined for empty string", () => {
    expect(asNonEmptyString("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only string", () => {
    expect(asNonEmptyString("   ")).toBeUndefined();
  });

  test("returns undefined for non-string values", () => {
    expect(asNonEmptyString(42)).toBeUndefined();
    expect(asNonEmptyString(null)).toBeUndefined();
    expect(asNonEmptyString(undefined)).toBeUndefined();
    expect(asNonEmptyString(true)).toBeUndefined();
    expect(asNonEmptyString({})).toBeUndefined();
  });
});

describe("checkUnquotedDescriptionColon", () => {
  test("flags a plain colon-bearing description", () => {
    expect(checkUnquotedDescriptionColon("description: Proposal lint:blocks invalid output.")).toContain(
      "unquoted colon",
    );
  });

  test("accepts quoted descriptions wrapped across physical lines", () => {
    expect(
      checkUnquotedDescriptionColon(
        'description: "A long quoted description: remains valid when YAML wraps it\n  across physical lines."',
      ),
    ).toBeNull();
  });

  test("accepts folded and literal block descriptions containing colons", () => {
    expect(checkUnquotedDescriptionColon("description: >-\n  Folded: description")).toBeNull();
    expect(checkUnquotedDescriptionColon("description: |-\n  Literal: description")).toBeNull();
  });

  test("retains a finding for an ambiguous malformed plain scalar", () => {
    expect(checkUnquotedDescriptionColon("description: Proposal lint: blocks invalid output.")).toContain(
      "unquoted colon",
    );
  });
});

/**
 * Date-valued frontmatter keys have bare names (`observed`, `started`, `ended`),
 * like `created`, `updated` and `expires`. Readers take the new name first and
 * fall back to the old `_at` spelling; writers write only the new name.
 */

describe("readFrontmatterDate", () => {
  test("the new name wins over the old one", () => {
    expect(readFrontmatterDate({ observed: "2026-05-01", observed_at: "2026-04-20" }, "observed")).toBe("2026-05-01");
  });

  test("an old name alone still works", () => {
    expect(readFrontmatterDate({ observed_at: " 2026-04-20 " }, "observed")).toBe("2026-04-20");
    expect(readFrontmatterDate({ started_at: "s", ended_at: "e" }, "started")).toBe("s");
    expect(readFrontmatterDate({ started_at: "s", ended_at: "e" }, "ended")).toBe("e");
  });

  test("a blank new name falls back to the old one, and neither is undefined", () => {
    expect(readFrontmatterDate({ observed: "  ", observed_at: "2026-04-20" }, "observed")).toBe("2026-04-20");
    expect(readFrontmatterDate({}, "observed")).toBeUndefined();
  });
});

describe("writers emit only the new name", () => {
  test("remember writes `observed`", () => {
    const fm = parseFrontmatter(buildMemoryFrontmatter({ tags: ["ops"], observed_at: "2026-04-24" })).data;
    expect(fm.observed).toBe("2026-04-24");
    expect(fm).not.toHaveProperty("observed_at");
  });

  test("a session asset writes `started` and `ended`", () => {
    const data: SessionData = {
      ref: {
        harness: "claude",
        sessionId: "s-12345678",
        filePath: "/tmp/s.jsonl",
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_600_000,
      },
      events: [],
      inlineRefs: [],
    };
    const { frontmatter, content } = buildSessionAssetContent(data, { summary: "Did work.", keyTopics: [] });
    expect(frontmatter.started).toBe(new Date(1_790_000_000_000).toISOString());
    expect(frontmatter.ended).toBe(new Date(1_790_000_600_000).toISOString());
    const written = parseFrontmatter(content).data;
    expect(written).not.toHaveProperty("started_at");
    expect(written).not.toHaveProperty("ended_at");
    expect(written.started).toBe(frontmatter.started);
  });
});

describe("remember --enrich parser", () => {
  test("accepts `observed` and the older `observed_at`, the new name first", () => {
    expect(parseEnrichObserved({ observed: "2026-04-24" })).toBe("2026-04-24");
    expect(parseEnrichObserved({ observed_at: "2026-04-24" })).toBe("2026-04-24");
    expect(parseEnrichObserved({ observed: "2026-05-01", observed_at: "2026-04-24" })).toBe("2026-05-01");
  });

  test("ignores anything that is not a plain YYYY-MM-DD", () => {
    expect(parseEnrichObserved({ observed: "yesterday", observed_at: "2026-04-24" })).toBe("2026-04-24");
    expect(parseEnrichObserved({ observed: "yesterday" })).toBeUndefined();
    expect(parseEnrichObserved({})).toBeUndefined();
  });
});

/**
 * Tests for `|`-block scalar parsing in `parseFrontmatter` (#495).
 *
 * `yaml.stringify` (used by `serializeFrontmatter` in asset-serialize.ts)
 * emits multi-line strings as `|`-block scalars.  Until this fix, the
 * hand-rolled YAML-subset parser in `frontmatter.ts` silently dropped those
 * values, causing round-trip data loss and forcing `reflect.ts` to keep a
 * cloned defensive serializer.  These tests pin the corrected behaviour.
 */

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
      ref: "lessons/test-lesson",
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
