import { expect, test } from "bun:test";
import { extractSection, markdownFragmentSlugs, parseMarkdownToc } from "../src/core/asset/markdown";

const SAMPLE_DOC = `---
title: Guide
description: "A test guide"
---
# Getting Started

Welcome to the guide.

## Installation

Run \`npm install\` to get started.

## Configuration

Set up your config file.

### Advanced Config

For power users.

# API Reference

The API docs.

## Endpoints

List of endpoints.
`;

test("parseMarkdownToc extracts headings with correct levels and line numbers", () => {
  const toc = parseMarkdownToc(SAMPLE_DOC);
  expect(toc.headings.length).toBe(6);
  expect(toc.headings[0]).toEqual({ level: 1, text: "Getting Started", line: 5 });
  expect(toc.headings[1]).toEqual({ level: 2, text: "Installation", line: 9 });
  expect(toc.headings[2]).toEqual({ level: 2, text: "Configuration", line: 13 });
  expect(toc.headings[3]).toEqual({ level: 3, text: "Advanced Config", line: 17 });
  expect(toc.headings[4]).toEqual({ level: 1, text: "API Reference", line: 21 });
  expect(toc.headings[5]).toEqual({ level: 2, text: "Endpoints", line: 25 });
});

test("parseMarkdownToc skips frontmatter block", () => {
  const doc = "---\ntitle: Test\n---\n# Heading\n";
  const toc = parseMarkdownToc(doc);
  expect(toc.headings.length).toBe(1);
  expect(toc.headings[0]!.text).toBe("Heading");
});

test("parseMarkdownToc handles document without frontmatter", () => {
  const doc = "# Title\n\nSome text\n\n## Section\n";
  const toc = parseMarkdownToc(doc);
  expect(toc.headings.length).toBe(2);
  expect(toc.headings[0]).toEqual({ level: 1, text: "Title", line: 1 });
  expect(toc.headings[1]).toEqual({ level: 2, text: "Section", line: 5 });
});

test("parseMarkdownToc handles empty content", () => {
  const toc = parseMarkdownToc("");
  expect(toc.headings).toEqual([]);
  expect(toc.totalLines).toBe(1);
});

test("parseMarkdownToc strips trailing hash markers", () => {
  const doc = "# Heading ##\n## Another ###\n";
  const toc = parseMarkdownToc(doc);
  expect(toc.headings[0]!.text).toBe("Heading");
  expect(toc.headings[1]!.text).toBe("Another");
});

test("extractSection returns content from heading to next same-or-higher level", () => {
  const result = extractSection(SAMPLE_DOC, "Installation");
  expect(result).not.toBeNull();
  expect(result?.content).toContain("npm install");
  expect(result?.content).not.toContain("Configuration");
});

test("extractSection returns content including sub-headings", () => {
  const result = extractSection(SAMPLE_DOC, "Configuration");
  expect(result).not.toBeNull();
  expect(result?.content).toContain("Advanced Config");
  expect(result?.content).not.toContain("API Reference");
});

test("extractSection is case-insensitive", () => {
  const result = extractSection(SAMPLE_DOC, "installation");
  expect(result).not.toBeNull();
  expect(result?.content).toContain("npm install");
});

test("extractSection returns null for non-existent heading", () => {
  const result = extractSection(SAMPLE_DOC, "Nonexistent");
  expect(result).toBeNull();
});

test("extractSection handles last section (no following heading)", () => {
  const result = extractSection(SAMPLE_DOC, "Endpoints");
  expect(result).not.toBeNull();
  expect(result?.content).toContain("List of endpoints");
});

test("extractSection prefers an exact heading when normalized slugs collide", () => {
  const content = "# C++\n\nPlus.\n\n# C#\n\nSharp.\n";
  expect(extractSection(content, "C#")?.content).toContain("Sharp.");
  expect(extractSection(content, "C#")?.content).not.toContain("Plus.");
});

test("markdown fragments suffix duplicate and colliding heading slugs", () => {
  const content = "# C++\n\nPlus.\n\n# C#\n\nSharp.\n\n# C++\n\nPlus again.\n";
  expect(markdownFragmentSlugs(content)).toEqual(["c", "c-1", "c-2"]);
  expect(extractSection(content, "c-1")?.content).toContain("Sharp.");
  expect(extractSection(content, "c-2")?.content).toContain("Plus again.");
});

test("markdown fragments stay globally unique when a natural slug uses a generated suffix", () => {
  const content = "# Foo\n\nFirst.\n\n# Foo\n\nSecond.\n\n# Foo-1\n\nLiteral suffix.\n";
  expect(markdownFragmentSlugs(content)).toEqual(["foo", "foo-1", "foo-1-1"]);
  expect(extractSection(content, "foo-1")?.content).toContain("Second.");
  expect(extractSection(content, "foo-1")?.content).not.toContain("Literal suffix.");
  expect(extractSection(content, "foo-1-1")?.content).toContain("Literal suffix.");
});

test("markdown fragments replace punctuation runs with separators", () => {
  const content = "# Foo.Bar\n\nDot body.\n";
  expect(markdownFragmentSlugs(content)).toEqual(["foo-bar"]);
  expect(extractSection(content, "foo-bar")?.content).toContain("Dot body.");
});

test("parseMarkdownToc skips headings inside fenced code blocks", () => {
  const doc = `# Real Heading

\`\`\`markdown
# Fake Heading Inside Fence

## Also Fake
\`\`\`

## Real Section

\`\`\`
# Another Fake
\`\`\`

### Real Subsection
`;
  const toc = parseMarkdownToc(doc);
  expect(toc.headings.length).toBe(3);
  expect(toc.headings[0]).toEqual({ level: 1, text: "Real Heading", line: 1 });
  expect(toc.headings[1]).toEqual({ level: 2, text: "Real Section", line: 9 });
  expect(toc.headings[2]).toEqual({ level: 3, text: "Real Subsection", line: 15 });
});

test("parseMarkdownToc closes a fence only on the same character at least as long (CommonMark)", () => {
  const doc = [
    "# Real",
    "````markdown",
    "```",
    "# Inside the outer fence",
    "```",
    "~~~~",
    "## Still inside",
    "```` trailing text is not a closing fence",
    "````  ",
    "## After the four-backtick fence",
    "~~~",
    "# Inside tildes",
    "```",
    "~~~~",
    "    ```",
    "# Indented four spaces is not a fence",
    "```js ``` backticks in the info string",
    "## Inline backticks do not open a fence",
  ].join("\n");
  expect(parseMarkdownToc(doc).headings).toEqual([
    { level: 1, text: "Real", line: 1 },
    { level: 2, text: "After the four-backtick fence", line: 10 },
    { level: 1, text: "Indented four spaces is not a fence", line: 16 },
    { level: 2, text: "Inline backticks do not open a fence", line: 18 },
  ]);
});
