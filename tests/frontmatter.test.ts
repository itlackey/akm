import { describe, expect, test } from "bun:test";
import { parseFrontmatter, parseFrontmatterBlock, parseYamlScalar, toStringOrUndefined } from "../src/core/frontmatter";

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

  test("empty value with no continuation becomes empty string (backward compat)", () => {
    const raw = "---\ntitle: Hello\nempty:\ndescription: test\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe("Hello");
    expect(result.data.empty).toBe("");
    expect(result.data.description).toBe("test");
  });

  test("single-item block sequence", () => {
    const raw = "---\ntags:\n- solo\n---\n";
    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["solo"]);
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

// ── toStringOrUndefined ─────────────────────────────────────────────────────

describe("toStringOrUndefined", () => {
  test("returns string for non-empty string", () => {
    expect(toStringOrUndefined("hello")).toBe("hello");
  });

  test("returns undefined for empty string", () => {
    expect(toStringOrUndefined("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only string", () => {
    expect(toStringOrUndefined("   ")).toBeUndefined();
  });

  test("returns undefined for non-string values", () => {
    expect(toStringOrUndefined(42)).toBeUndefined();
    expect(toStringOrUndefined(null)).toBeUndefined();
    expect(toStringOrUndefined(undefined)).toBeUndefined();
    expect(toStringOrUndefined(true)).toBeUndefined();
    expect(toStringOrUndefined({})).toBeUndefined();
  });
});
