// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic, addressable Markdown fragments.
 *
 * Input is the safe, line-preserving Markdown projection, never the raw file.
 * Keeping that distinction here means search can only emit selectors that
 * `show` can reproduce without disclosing fenced/commented/link-target bytes.
 */
import { createHash } from "node:crypto";
import { markdownHeadingSlug, parseMarkdownToc } from "./markdown";

export const MARKDOWN_FRAGMENT_MAX_CHARS = 1600;
export const MARKDOWN_FRAGMENT_PREFIX = "akm-fragment-";
export const MARKDOWN_FRAGMENT_CONTEXT_DEFAULT_MAX_CHARS = 3200;
export const MARKDOWN_FRAGMENT_SELECTED_LABEL = "[Selected matching fragment]";

export interface MarkdownFragment {
  fragmentId: string;
  ordinal: number;
  startLine: number;
  endLine: number;
  /** A friendly alias only for an unsplit heading section. */
  headingSlug?: string;
  text: string;
  hash: string;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function uniqueSlugs(body: string): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  for (const heading of parseMarkdownToc(body).headings) {
    const base = markdownHeadingSlug(heading.text);
    if (!base) continue;
    let slug = base;
    for (let suffix = 1; seen.has(slug); suffix++) slug = `${base}-${suffix}`;
    seen.add(slug);
    out.set(heading.line, slug);
  }
  return out;
}

interface Piece {
  lines: string[];
  startLine: number;
  headingSlug?: string;
}

function textOf(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

/** Split a large sequence only at paragraph, then word, boundaries. */
function splitPiece(piece: Piece, maxChars: number): Piece[] {
  if (textOf(piece.lines).length <= maxChars) return [piece];
  const pieces: Piece[] = [];
  let start = 0;
  while (start < piece.lines.length) {
    let end = start;
    let chars = 0;
    while (end < piece.lines.length) {
      const next = piece.lines[end]!;
      // Let the single-line word-window path below own an oversized first
      // line. Without this guard it is consumed whole before that path can
      // run, silently defeating the fragment bound for transcripts/logs.
      if (end === start && next.length > maxChars) break;
      if (end > start && chars + next.length + 1 > maxChars) break;
      chars += next.length + (end > start ? 1 : 0);
      end++;
    }
    // A single long authored line needs word windows, but its source range is
    // intentionally the same line for every window.
    if (end === start) {
      const line = piece.lines[start]!;
      let offset = 0;
      while (offset < line.length) {
        let cut = Math.min(offset + maxChars, line.length);
        if (cut < line.length) {
          const space = line.lastIndexOf(" ", cut);
          if (space > offset + Math.floor(maxChars * 0.55)) cut = space;
        }
        pieces.push({ lines: [line.slice(offset, cut).trim()], startLine: piece.startLine + start });
        offset = cut;
        while (line[offset] === " ") offset++;
      }
      start++;
      continue;
    }
    // Prefer not to split a paragraph if a blank boundary fits before `end`.
    let preferred = -1;
    for (let i = start + 1; i < end; i++) if (!piece.lines[i]!.trim()) preferred = i;
    if (preferred > start) end = preferred;
    pieces.push({ lines: piece.lines.slice(start, end), startLine: piece.startLine + start });
    start = end;
    while (start < piece.lines.length && !piece.lines[start]!.trim()) start++;
  }
  return pieces.filter((candidate) => textOf(candidate.lines));
}

/**
 * Heading sections first, then paragraph/word windows. `startLine`/`endLine`
 * always refer to the authored file's line numbers because the projection
 * preserves one line per source line (with excluded bytes blanked out).
 */
export function splitMarkdownFragmentStats(
  body: string,
  maxChars = MARKDOWN_FRAGMENT_MAX_CHARS,
): { fragments: MarkdownFragment[]; hardSplitCount: number } {
  const lines = body.split(/\r?\n/);
  const headings = parseMarkdownToc(body).headings;
  const boundaries = [1, ...headings.map((heading) => heading.line), lines.length + 1]
    .filter((line, index, all) => index === 0 || line !== all[index - 1])
    .sort((left, right) => left - right);
  const slugs = uniqueSlugs(body);
  const pieces: Piece[] = [];
  let sectionCount = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startLine = boundaries[i]!;
    const end = boundaries[i + 1]! - 1;
    const section = { lines: lines.slice(startLine - 1, end), startLine, headingSlug: slugs.get(startLine) };
    if (textOf(section.lines)) {
      sectionCount++;
      pieces.push(...splitPiece(section, maxChars));
    }
  }
  // Whether a heading section survived as one fragment is a property of the
  // complete piece set. Count once before materialization instead of scanning
  // every piece for every fragment (which made many headed documents O(N²)).
  const piecesPerHeading = new Map<string, number>();
  for (const piece of pieces) {
    if (piece.headingSlug) piecesPerHeading.set(piece.headingSlug, (piecesPerHeading.get(piece.headingSlug) ?? 0) + 1);
  }
  const fragments = pieces.map((piece, ordinal) => {
    const text = textOf(piece.lines);
    const contentLines = piece.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
    const first = contentLines[0]?.index ?? 0;
    const last = contentLines.at(-1)?.index ?? 0;
    const digest = hash(text);
    const unsplitHeading = piece.headingSlug && piecesPerHeading.get(piece.headingSlug) === 1;
    return {
      fragmentId: `${MARKDOWN_FRAGMENT_PREFIX}${ordinal + 1}-${digest.slice(0, 12)}`,
      ordinal,
      startLine: piece.startLine + first,
      endLine: piece.startLine + last,
      ...(unsplitHeading ? { headingSlug: piece.headingSlug } : {}),
      text,
      hash: digest,
    };
  });
  return { fragments, hardSplitCount: Math.max(0, pieces.length - sectionCount) };
}

export function splitMarkdownFragments(body: string, maxChars = MARKDOWN_FRAGMENT_MAX_CHARS): MarkdownFragment[] {
  return splitMarkdownFragmentStats(body, maxChars).fragments;
}

export function fragmentForSelector(body: string, selector: string): MarkdownFragment | undefined {
  return splitMarkdownFragments(body).find(
    (fragment) => fragment.fragmentId === selector || fragment.headingSlug === selector,
  );
}

export interface MarkdownLeadContext {
  content: string;
  truncated: boolean;
}

/**
 * Assemble the document lead and selected fragment under one hard character
 * budget. The selected match is always labelled and last. When both pieces do
 * not fit, lead bytes are discarded before any selected-fragment bytes so the
 * evidence that caused retrieval remains intact whenever the caller's budget
 * can hold it.
 */
export function buildMarkdownLeadContext(
  fragments: readonly MarkdownFragment[],
  selectedOrdinal: number,
  maxChars = MARKDOWN_FRAGMENT_CONTEXT_DEFAULT_MAX_CHARS,
): MarkdownLeadContext {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("Markdown fragment context maxChars must be a positive safe integer");
  }
  const selected = fragments[selectedOrdinal];
  if (!selected) throw new RangeError(`Markdown fragment ordinal ${selectedOrdinal} is out of range`);

  const selectedBlock = `${MARKDOWN_FRAGMENT_SELECTED_LABEL}\n${selected.text}`;
  if (selectedBlock.length > maxChars) {
    return { content: selectedBlock.slice(0, maxChars), truncated: true };
  }

  const lead = fragments[0];
  if (!lead || lead.ordinal === selected.ordinal) return { content: selectedBlock, truncated: false };

  const separator = "\n\n";
  const availableLeadChars = maxChars - selectedBlock.length - separator.length;
  if (availableLeadChars <= 0) return { content: selectedBlock, truncated: true };

  const leadText = lead.text.slice(0, availableLeadChars).trimEnd();
  if (!leadText) return { content: selectedBlock, truncated: true };
  return {
    content: `${leadText}${separator}${selectedBlock}`,
    truncated: leadText.length < lead.text.length,
  };
}
