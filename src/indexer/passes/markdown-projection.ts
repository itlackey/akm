// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { IndexDocument } from "../../core/adapter/types";
import { parseFrontmatter } from "../../core/asset/frontmatter";

// ── Native Markdown search projection ──────────────────────────────────────

/**
 * Maximum native Markdown prose carried by the low-weight `content` field.
 *
 * Set far past any real authored document, so ordinary long-form
 * skills/knowledge docs never lose their tail from FTS or the embedding
 * input. The bound exists only to
 * stop a truly pathological single file (a committed data dump, a decompressed
 * log) from ballooning index size — not to shave real content — so a caller
 * that hits it is always told, unconditionally.
 */
export const MARKDOWN_CONTENT_MAX_CHARS = 1_000_000;

/**
 * Locate a leading nested frontmatter block in a body: up to three blank
 * lines, then a `---` line, closed by a later `---` line. Mirrors the
 * base-linter's `parseInnerFrontmatterBlock` recognition — when `akm
 * remember` wraps a session-capture hook's file in its own frontmatter, the
 * hook's `---\nakm_memory_kind: …\n---` block survives at the top of the
 * body. Returns the open/close line indexes, or `null` when no block opens.
 * Location only — callers apply their own interior checks (marker scan in
 * {@link hasSessionMemoryMarker}, shape test in {@link isFrontmatterShaped}).
 */
function findInnerFrontmatterBlock(lines: string[]): { open: number; close: number } | null {
  let i = 0;
  while (i < lines.length && i < 3 && lines[i]!.trim() === "") i += 1;
  if (lines[i] !== "---") return null;
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j] === "---") return { open: i, close: j };
  }
  return null;
}

/**
 * True when the document carries the session-capture `akm_memory_kind`
 * marker — in the outer frontmatter data OR in a nested inner block at the
 * top of the body (both producer layouts exist; see base-linter's
 * `extractFrontmatterRefs`). Session bodies are raw transcripts, never a
 * searchable content projection.
 */
export function hasSessionMemoryMarker(fmData: Record<string, unknown>, body: string): boolean {
  if (typeof fmData.akm_memory_kind === "string") return true;
  const lines = body.split(/\r?\n/);
  const block = findInnerFrontmatterBlock(lines);
  if (!block) return false;
  for (let i = block.open + 1; i < block.close; i += 1) {
    if (/^akm_memory_kind:\s*\S/.test(lines[i]!)) return true;
  }
  return false;
}

/**
 * True when the interior of a candidate inner block (located by
 * {@link findInnerFrontmatterBlock}) actually reads as YAML frontmatter:
 * every line is blank, indented (a continuation or nested value), or shaped
 * like a top-level `key:` mapping entry. Ordinary prose bracketed by two
 * thematic-break `---` lines fails this test, so a decorative opening
 * callout is treated as the paragraph it is instead of being discarded
 * (the block finder alone accepts ANY content up
 * to an arbitrarily distant closing `---`).
 */
function isFrontmatterShaped(lines: string[], block: { open: number; close: number }): boolean {
  for (let i = block.open + 1; i < block.close; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue; // indented continuation / nested value
    if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(line)) continue; // top-level key
    return false;
  }
  return true;
}

export function truncateUnicodeSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  const boundary = cut.lastIndexOf(" ");
  if (boundary >= Math.floor(maxChars * 0.9)) cut = cut.slice(0, boundary);
  return cut.trimEnd();
}

type MarkdownFence = { marker: "`" | "~"; length: number };

function parseMarkdownFenceOpening(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const run = match?.[1];
  if (!run) return undefined;
  const marker = run[0] as "`" | "~";
  // CommonMark forbids backticks in the info string of a backtick fence.
  if (marker === "`" && match?.[2]?.includes("`")) return undefined;
  return { marker, length: run.length };
}

function isMarkdownFenceClosing(line: string, fence: MarkdownFence): boolean {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") cursor += 1;
  const runStart = cursor;
  while (cursor < line.length && line[cursor] === fence.marker) cursor += 1;
  if (cursor - runStart < fence.length) return false;
  return /^[\t ]*$/.test(line.slice(cursor));
}

/**
 * Version of what {@link projectMarkdownContent} indexes. It is part of every
 * directory's index fingerprint, so bumping it makes the next `akm index`
 * re-project every directory once instead of keeping the old text for
 * unchanged files. 3: count each fenced identifier once per document (akm#1284).
 */
export const CONTENT_PROJECTION_VERSION = 3;

/** At or above this length a token with a digit reads as a key or hash, not a name. */
const TOKEN_LIKE_MIN_LENGTH = 20;

/**
 * The searchable identifiers of one line of fenced code, without its literal
 * values (akm#1260). Fenced code holds the names agents look for (functions,
 * classes, CLI flags, config keys, environment variable names, paths) and
 * also example secrets, so it keeps names and drops values:
 *
 * - a quoted string survives only as a key (`"name":`) or an absolute path;
 *   every other quoted literal is dropped;
 * - the value of an assignment (`KEY=value`, `key: value`, `"key": value`,
 *   `Authorization: Bearer token`) is dropped unless it is a dotted code
 *   reference (`process.env.CI`); the name stays;
 * - long token-like strings with digits (keys, hashes) are dropped, base64
 *   included: its `/`, `+` and `=` do not cut it into short kept pieces;
 * - camelCase, snake_case, dotted and dashed names also add their parts.
 *
 * Numbers, punctuation and operators never reach the result.
 */
export function fencedCodeIdentifiers(line: string): string {
  const cleaned = line
    .replace(
      /(["'`])((?:\\.|(?!\1).)*)\1(\s*:)?/g,
      (match: string, _quote: string, body: string, colon: string | undefined, offset: number) => {
        // Keep a key's colon when an unquoted value follows, so the assignment rule below drops that value.
        if (colon) return /^\s*["'`]/.test(line.slice(offset + match.length)) ? ` ${body} ` : ` ${body}: `;
        return /^\/[\w./-]+$/.test(body) ? ` ${body} ` : " ";
      },
    )
    .replace(
      /([A-Za-z_][A-Za-z0-9_.-]*\s*[:=]\s*)((?:[Bb]earer|[Bb]asic|[Tt]oken|[Dd]igest)\s+\S+|\S+)/g,
      (_match, name: string, value: string) =>
        /^[!(]*[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+[()\]}]*[,;]?$/.test(value) ? `${name} ${value}` : name,
    )
    // Base64 is one token: its `/`, `+` and `=` would otherwise cut a key body into short pieces that are kept.
    .replace(/(?<![\w.-])[A-Za-z0-9+/=]{20,}(?![\w.-])/g, (run) =>
      /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? " " : run,
    );
  const words: string[] = [];
  for (let token of cleaned.match(/--?[A-Za-z][A-Za-z0-9-]*|[A-Za-z_][A-Za-z0-9_.-]*/g) ?? []) {
    token = token.replace(/[.-]+$/, "");
    const bare = token.replace(/^-+/, "");
    if (bare.length < 2) continue;
    if (bare.length >= TOKEN_LIKE_MIN_LENGTH && /\d/.test(bare)) continue;
    words.push(token);
    const parts = bare.split(/[_.-]|(?<=[a-z0-9])(?=[A-Z])/).filter((part) => part.length > 1);
    if (parts.length > 1) words.push(...parts);
  }
  return words.join(" ");
}

function stripMarkdownHtmlComments(line: string, state: { inComment: boolean }): string {
  let cursor = 0;
  let visible = "";
  while (cursor < line.length) {
    if (state.inComment) {
      const close = line.indexOf("-->", cursor);
      if (close < 0) return visible;
      state.inComment = false;
      cursor = close + 3;
      continue;
    }
    const open = line.indexOf("<!--", cursor);
    if (open < 0) return `${visible}${line.slice(cursor)}`;
    visible += line.slice(cursor, open);
    state.inComment = true;
    cursor = open + 4;
  }
  return visible;
}

function findBalancedMarkdownClose(text: string, openAt: number, open: string, close: string): number | undefined {
  let depth = 1;
  for (let cursor = openAt + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === open) depth += 1;
    if (char !== close) continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return undefined;
}

/**
 * Find the closing parenthesis of an inline link destination. Parentheses in
 * angle-delimited destinations and quoted titles are data, while unquoted
 * parentheses remain balanced. Backslash escapes suppress delimiter meaning.
 */
function findMarkdownDestinationClose(text: string, openAt: number): number | undefined {
  let depth = 1;
  let phase: "before-destination" | "angle-destination" | "bare-destination" | "after-destination" | "title" =
    "before-destination";
  let quote: '"' | "'" | undefined;
  let parenthesizedTitle = false;
  let titleSeparator = false;
  for (let cursor = openAt + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }

    if (phase === "before-destination") {
      if (/\s/u.test(char ?? "")) continue;
      if (char === "<") {
        phase = "angle-destination";
        continue;
      }
      if (char === ")") return cursor;
      phase = "bare-destination";
    }

    if (phase === "angle-destination") {
      if (char === ">") phase = "after-destination";
      continue;
    }

    if (phase === "title") {
      if (quote) {
        if (char === quote) {
          quote = undefined;
          phase = "after-destination";
          titleSeparator = false;
        }
        continue;
      }
      if (parenthesizedTitle) {
        if (char === "(") depth += 1;
        if (char !== ")") continue;
        depth -= 1;
        if (depth === 1) {
          parenthesizedTitle = false;
          phase = "after-destination";
          titleSeparator = false;
        }
      }
      continue;
    }

    if (phase === "after-destination") {
      if (/\s/u.test(char ?? "")) {
        titleSeparator = true;
        continue;
      }
      if (char === ")") return cursor;
      if (titleSeparator && (char === '"' || char === "'")) {
        quote = char;
        phase = "title";
        continue;
      }
      if (titleSeparator && char === "(") {
        depth += 1;
        parenthesizedTitle = true;
        phase = "title";
        continue;
      }
      // Invalid trailing bytes are still consumed conservatively until the
      // balanced outer close. Quotes here are ordinary bytes, never titles.
      phase = "bare-destination";
    }

    if (phase !== "bare-destination") continue;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
      continue;
    }
    if (/\s/u.test(char ?? "") && depth === 1) {
      phase = "after-destination";
      titleSeparator = true;
    }
  }
  return undefined;
}

const MAX_MARKDOWN_LINK_NESTING = 32;

/** Retain recursively projected link labels while dropping complete destinations. */
function stripMarkdownLinkDestinations(text: string, nesting = 0): string {
  let visible = "";
  let cursor = 0;
  while (cursor < text.length) {
    const isImage = text[cursor] === "!" && text[cursor + 1] === "[";
    const labelOpen = isImage ? cursor + 1 : cursor;
    if (text[labelOpen] !== "[") {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    const labelClose = findBalancedMarkdownClose(text, labelOpen, "[", "]");
    const destinationOpen = labelClose === undefined ? undefined : labelClose + 1;
    if (destinationOpen === undefined || text[destinationOpen] !== "(") {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    const destinationClose = findMarkdownDestinationClose(text, destinationOpen);
    if (destinationClose === undefined) {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    // Labels may themselves contain images/links. Recursively project them so
    // an inner destination cannot become visible when its outer link is
    // removed. At an adversarial nesting depth, omit the label rather than
    // leaking its unparsed bytes into the search projection.
    if (nesting < MAX_MARKDOWN_LINK_NESTING) {
      visible += stripMarkdownLinkDestinations(text.slice(labelOpen + 1, labelClose), nesting + 1);
    }
    cursor = destinationClose + 1;
  }
  return visible;
}

/**
 * Derive the one low-weight search projection for an AKM-native Markdown body.
 * Frontmatter is removed by the caller. This projection drops comments, raw
 * link targets, and structural punctuation while retaining prose, headings,
 * link labels, and inline identifiers. From fenced code it keeps only the
 * identifiers ({@link fencedCodeIdentifiers}): names, flags, keys and paths,
 * never literal values (akm#1260). It never receives secret/env/session bytes;
 * that policy is enforced at the adapter metadata boundary below.
 *
 * Changing what this returns changes the indexed text of every Markdown entry,
 * so bump {@link CONTENT_PROJECTION_VERSION} with it: the indexer re-projects
 * every directory once on the next `akm index`.
 */
export function projectMarkdownContent(body: string, truncationInfo?: { truncated: boolean }): string | undefined {
  const lines = body.split(/\r?\n/);
  const innerBlock = findInnerFrontmatterBlock(lines);
  const start = innerBlock && isFrontmatterShaped(lines, innerBlock) ? innerBlock.close + 1 : 0;
  const projected: string[] = [];
  const fenced = new Map<string, string>();
  forEachVisibleMarkdownLine(
    lines,
    start,
    (_index, visible) => {
      let trimmed = visible.trim();
      if (!trimmed || /^(-{3,}|\*{3,}|_{3,}|=+)$/.test(trimmed)) return;
      if (/^\s*\[[^\]]+\]:\s*\S+/.test(trimmed)) return;
      if (/^<[^>]+>$/.test(trimmed)) return;

      // Preserve human-facing labels and inline identifiers, never destinations.
      trimmed = stripMarkdownLinkDestinations(trimmed);
      trimmed = trimmed.replace(/`{1,2}([^`]+)`{1,2}/g, "$1");
      trimmed = trimmed.replace(/^#{1,6}\s+/, "");
      trimmed = trimmed.replace(/^(?:>|[-+*]|\d+[.)])\s+/, "");
      trimmed = trimmed.replace(/<[^>]+>/g, " ");
      trimmed = trimmed.replace(/[|]+/g, " ");
      trimmed = trimmed.replace(/\s+/g, " ").trim();
      if (trimmed) projected.push(trimmed);
    },
    (_index, fencedLine) => {
      const identifiers = fencedCodeIdentifiers(fencedLine);
      for (const identifier of identifiers.split(/\s+/)) {
        if (identifier) fenced.set(identifier.toLowerCase(), identifier);
      }
    },
  );

  // Fenced identifiers follow the prose, so a head-truncated embedding input keeps the prose first.
  const text = [...projected, ...fenced.values()].join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (truncationInfo) truncationInfo.truncated = text.length > MARKDOWN_CONTENT_MAX_CHARS;
  return truncateUnicodeSafe(text, MARKDOWN_CONTENT_MAX_CHARS);
}

/**
 * Visit each line from `start` that lies outside fenced code, with HTML
 * comments removed (`visible`); fence lines themselves are never visited.
 * `visitFenced`, when given, receives each raw line inside a fence (not the
 * opening or closing fence line), from the same fence state.
 */
function forEachVisibleMarkdownLine(
  lines: string[],
  start: number,
  visit: (index: number, visible: string) => void,
  visitFenced?: (index: number, rawLine: string) => void,
): void {
  let fence: MarkdownFence | undefined;
  const htmlComment = { inComment: false };
  for (let index = start; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (fence) {
      if (isMarkdownFenceClosing(rawLine, fence)) fence = undefined;
      else visitFenced?.(index, rawLine);
      continue;
    }
    // A leading fence owns the whole line, including any info string that
    // resembles HTML. Comment state therefore cannot begin inside a fence.
    const leadingFence = htmlComment.inComment ? undefined : parseMarkdownFenceOpening(rawLine);
    if (leadingFence) {
      fence = leadingFence;
      continue;
    }
    const visible = stripMarkdownHtmlComments(rawLine, htmlComment);
    const openingFence = parseMarkdownFenceOpening(visible.trim());
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    visit(index, visible);
  }
}

// Fragment text is intentionally not an IndexDocument field. IndexDocument is
// an adapter/search payload boundary; this is an internal, derived index input
// that is persisted separately by the entries repository for deterministic FTS
// rebuilds. The WeakMap follows the already-read document through recognition
// without making safe body bytes observable through public payloads.
const markdownFragmentContentByEntry = new WeakMap<IndexDocument, string>();
const markdownFragmentProjectionEntries = new WeakSet<IndexDocument>();

export function setMarkdownFragmentContent(entry: IndexDocument, content: string | undefined): void {
  markdownFragmentProjectionEntries.add(entry);
  if (content) markdownFragmentContentByEntry.set(entry, content);
}

export function getMarkdownFragmentContent(entry: IndexDocument): string | undefined {
  return markdownFragmentContentByEntry.get(entry);
}

export function hasMarkdownFragmentContent(entry: IndexDocument): boolean {
  return markdownFragmentProjectionEntries.has(entry);
}

/**
 * Produce a safe, structure-preserving projection for fragment indexing.
 * Excluded source lines are retained as blank lines so fragment locations map
 * exactly to authored line numbers. This must be called from both indexing and
 * `show`; it deliberately never performs a storage-layer file reread.
 */
export function projectMarkdownFragmentContent(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const parsed = parseFrontmatter(raw);
  const projected = lines.map(() => "");
  forEachVisibleMarkdownLine(lines, parsed.frontmatter ? parsed.bodyStartLine - 1 : 0, (index, visible) => {
    // Reference link destinations and standalone HTML are not retrieval
    // evidence and can contain credential-bearing URLs.
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(visible) || /^\s*<[^>]+>\s*$/.test(visible)) return;
    projected[index] = stripMarkdownLinkDestinations(visible)
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+$/g, "");
  });
  const text = projected.join("\n");
  return text.trim() ? text : undefined;
}
