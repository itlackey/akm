// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseFrontmatter } from "./frontmatter";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TocHeading {
  level: number;
  text: string;
  line: number;
}

export interface KnowledgeToc {
  headings: TocHeading[];
  totalLines: number;
}

/** Stable GitHub-style selector for a Markdown heading. */
export function markdownHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function markdownFragmentSlugs(content: string): string[] {
  return uniqueHeadingSlugs(parseMarkdownToc(content).headings).filter(Boolean);
}

/** One addressable heading: `slug` is what `<ref>#<slug>` selects, `startLine` its 1-based file line. */
export interface MarkdownTocEntry {
  level: number;
  text: string;
  slug: string;
  startLine: number;
}

/**
 * The headings `extractSection` can select, with the slug it resolves each by.
 * A heading with no sluggable text has no selector, so it is left out.
 */
export function markdownToc(content: string): MarkdownTocEntry[] {
  const headings = parseMarkdownToc(content).headings;
  const slugs = uniqueHeadingSlugs(headings);
  return headings.flatMap((heading, index) =>
    slugs[index] ? [{ level: heading.level, text: heading.text, slug: slugs[index]!, startLine: heading.line }] : [],
  );
}

/** One slug per heading, in order; a heading with no sluggable text gets "". */
export function uniqueHeadingSlugs(headings: TocHeading[]): string[] {
  const used = new Set<string>();
  return headings.map((heading) => {
    const base = markdownHeadingSlug(heading.text);
    if (!base) return "";
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  });
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function parseMarkdownToc(content: string): KnowledgeToc {
  const lines = content.split(/\r?\n/);
  const headings: TocHeading[] = [];

  const parsed = parseFrontmatter(content);
  const start = parsed.frontmatter ? parsed.bodyStartLine - 1 : 0;

  // Fenced code blocks follow CommonMark, so headings inside them are skipped:
  // a fence opens with 3+ backticks or tildes indented at most 3 spaces (a
  // backtick fence's info string has no backtick) and closes only on a line of
  // the same character, at least as long, followed by nothing but whitespace.
  let fence: { char: string; length: number } | undefined;
  for (let i = start; i < lines.length; i++) {
    const [, run = "", rest = ""] = lines[i]!.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (fence) {
      if (run[0] === fence.char && run.length >= fence.length && !rest.trim()) fence = undefined;
      continue;
    }
    if (run && !(run[0] === "`" && rest.includes("`"))) {
      fence = { char: run[0]!, length: run.length };
      continue;
    }

    const match = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1]!.length,
        text: match[2]!.replace(/\s+#+\s*$/, "").trim(),
        line: i + 1,
      });
    }
  }

  return { headings, totalLines: lines.length };
}

// ── Extraction ──────────────────────────────────────────────────────────────

export function extractSection(
  content: string,
  heading: string,
): { content: string; startLine: number; endLine: number } | null {
  const lines = content.split(/\r?\n/);
  const headings = parseMarkdownToc(content).headings;
  const fragment = heading.trim();
  const slugIndex = uniqueHeadingSlugs(headings).indexOf(fragment);
  const exact =
    slugIndex < 0 ? headings.find((candidate) => candidate.text.toLowerCase() === fragment.toLowerCase()) : undefined;
  const selected = slugIndex >= 0 ? headings[slugIndex] : exact;
  if (!selected) return null;

  const next = headings.find((candidate) => candidate.line > selected.line && candidate.level <= selected.level);
  const startIdx = selected.line - 1;
  const endIdx = next ? next.line - 1 : lines.length;
  return {
    content: lines.slice(startIdx, endIdx).join("\n"),
    startLine: selected.line,
    endLine: endIdx,
  };
}

// ── Fence stripping ──────────────────────────────────────────────────────────

/**
 * Best-effort fence stripping. Strips `<think>` reasoning blocks emitted by
 * local LLMs (e.g. Qwen3) before the content, which otherwise breaks YAML
 * frontmatter detection. Only strips outer triple-fence pairs — leaves inner
 * code blocks intact.
 */
export function stripMarkdownFences(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fence = stripped.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) return fence[1]!.trim();
  return stripped;
}
