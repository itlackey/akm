import { test, expect } from "bun:test"
import {
  parseMarkdownToc,
  extractSection,
  extractLineRange,
  extractFrontmatterOnly,
  formatToc,
} from "../src/markdown"

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
`

test("parseMarkdownToc extracts headings with correct levels and line numbers", () => {
  const toc = parseMarkdownToc(SAMPLE_DOC)
  expect(toc.headings.length).toBe(6)
  expect(toc.headings[0]).toEqual({ level: 1, text: "Getting Started", line: 5 })
  expect(toc.headings[1]).toEqual({ level: 2, text: "Installation", line: 9 })
  expect(toc.headings[2]).toEqual({ level: 2, text: "Configuration", line: 13 })
  expect(toc.headings[3]).toEqual({ level: 3, text: "Advanced Config", line: 17 })
  expect(toc.headings[4]).toEqual({ level: 1, text: "API Reference", line: 21 })
  expect(toc.headings[5]).toEqual({ level: 2, text: "Endpoints", line: 25 })
})

test("parseMarkdownToc skips frontmatter block", () => {
  const doc = "---\ntitle: Test\n---\n# Heading\n"
  const toc = parseMarkdownToc(doc)
  expect(toc.headings.length).toBe(1)
  expect(toc.headings[0].text).toBe("Heading")
})

test("parseMarkdownToc handles document without frontmatter", () => {
  const doc = "# Title\n\nSome text\n\n## Section\n"
  const toc = parseMarkdownToc(doc)
  expect(toc.headings.length).toBe(2)
  expect(toc.headings[0]).toEqual({ level: 1, text: "Title", line: 1 })
  expect(toc.headings[1]).toEqual({ level: 2, text: "Section", line: 5 })
})

test("parseMarkdownToc handles empty content", () => {
  const toc = parseMarkdownToc("")
  expect(toc.headings).toEqual([])
  expect(toc.totalLines).toBe(1)
})

test("parseMarkdownToc strips trailing hash markers", () => {
  const doc = "# Heading ##\n## Another ###\n"
  const toc = parseMarkdownToc(doc)
  expect(toc.headings[0].text).toBe("Heading")
  expect(toc.headings[1].text).toBe("Another")
})

test("extractSection returns content from heading to next same-or-higher level", () => {
  const result = extractSection(SAMPLE_DOC, "Installation")
  expect(result).not.toBeNull()
  expect(result!.content).toContain("npm install")
  expect(result!.content).not.toContain("Configuration")
})

test("extractSection returns content including sub-headings", () => {
  const result = extractSection(SAMPLE_DOC, "Configuration")
  expect(result).not.toBeNull()
  expect(result!.content).toContain("Advanced Config")
  expect(result!.content).not.toContain("API Reference")
})

test("extractSection is case-insensitive", () => {
  const result = extractSection(SAMPLE_DOC, "installation")
  expect(result).not.toBeNull()
  expect(result!.content).toContain("npm install")
})

test("extractSection returns null for non-existent heading", () => {
  const result = extractSection(SAMPLE_DOC, "Nonexistent")
  expect(result).toBeNull()
})

test("extractSection handles last section (no following heading)", () => {
  const result = extractSection(SAMPLE_DOC, "Endpoints")
  expect(result).not.toBeNull()
  expect(result!.content).toContain("List of endpoints")
})

test("extractLineRange returns correct lines (1-based inclusive)", () => {
  const content = "line1\nline2\nline3\nline4\nline5"
  expect(extractLineRange(content, 2, 4)).toBe("line2\nline3\nline4")
})

test("extractLineRange clamps to valid range", () => {
  const content = "line1\nline2\nline3"
  expect(extractLineRange(content, 0, 100)).toBe("line1\nline2\nline3")
  expect(extractLineRange(content, 2, 2)).toBe("line2")
})

test("extractFrontmatterOnly returns YAML block", () => {
  const fm = extractFrontmatterOnly(SAMPLE_DOC)
  expect(fm).not.toBeNull()
  expect(fm).toContain("title: Guide")
  expect(fm).toContain('description: "A test guide"')
})

test("extractFrontmatterOnly returns null when no frontmatter", () => {
  expect(extractFrontmatterOnly("# Just a heading\n")).toBeNull()
})

test("formatToc produces readable output with line numbers", () => {
  const toc = parseMarkdownToc(SAMPLE_DOC)
  const output = formatToc(toc)
  expect(output).toContain("# Getting Started")
  expect(output).toContain("## Installation")
  expect(output).toContain("### Advanced Config")
  expect(output).toContain("lines total")
  expect(output).toMatch(/L\s*\d+/)
})

test("formatToc handles empty headings", () => {
  const output = formatToc({ headings: [], totalLines: 5 })
  expect(output).toContain("no headings found")
  expect(output).toContain("5 lines total")
})
