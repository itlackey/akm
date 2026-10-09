// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reflect noise gate (#580): classify a candidate edit against the current
 * asset before it becomes a proposal, by text comparison alone. Empty and
 * cosmetic-only edits (YAML re-folding, fence language hints, re-wrapped prose)
 * each cost an LLM call and a review slot. The gate is conservative — letting a
 * cosmetic edit through costs a review, suppressing a real fix loses work — so
 * anything uncertain is `substantive`: code (fenced or indented) compares
 * verbatim, and headings, tables and breaks never absorb the next line.
 *
 * `findReflectDefect` is its counterpart for an edit that is not noise but a
 * defect no judge needs to weigh: placeholder text, talk about the edit itself,
 * or frontmatter copied into the body.
 */

import { parse as yamlParse } from "yaml";
import { parseFrontmatter } from "../../core/asset/frontmatter";

export type ReflectChangeKind = "noop" | "cosmetic" | "substantive";

/**
 * `noop` (identical up to trailing whitespace) and `cosmetic` (identical after
 * normalizing frontmatter as parsed YAML and prose as unwrapped text) never
 * become proposals.
 */
export function classifyReflectChange(sourceContent: string, candidateContent: string): ReflectChangeKind {
  if (normalizeTrailingWhitespace(sourceContent) === normalizeTrailingWhitespace(candidateContent)) return "noop";
  try {
    if (cosmeticNormalForm(sourceContent) === cosmeticNormalForm(candidateContent)) return "cosmetic";
  } catch {
    // unprovable → substantive
  }
  return "substantive";
}

export type ReflectDefect = "placeholder_added" | "meta_commentary_added" | "frontmatter_copied_into_body";

/**
 * The wording the defect rules look for, one list per rule
 * (`processes.reflect.defectFilter`). A list that is set replaces that rule's
 * default; an empty list turns the rule off.
 */
export interface ReflectDefectFilter {
  /** Placeholder text. Phrases: whole words, any case, any run of whitespace between words. */
  placeholders?: readonly string[];
  /** An asset talking about its own edit. Phrases, matched like `placeholders`. */
  metaCommentary?: readonly string[];
  /** Frontmatter keys: a body line that starts `key:` is frontmatter copied into the body. Exact names. */
  frontmatterKeys?: readonly string[];
}

/** Not TODO, TBD or FIXME: an asset may carry those on purpose, and the owner does not want them refused. */
const DEFAULT_PLACEHOLDERS = [
  "please confirm",
  "please verify",
  "to be confirmed",
  "to be determined",
  "to be verified",
];

const DEFAULT_META_COMMENTARY = [
  "feedback signal",
  "feedback signals",
  "feedback indicate",
  "feedback indicates",
  "feedback suggest",
  "feedback suggests",
  "feedback ask",
  "feedback asks",
  "feedback says",
  "feedback report",
  "feedback reports",
  "feedback request",
  "feedback requests",
  "this revision",
  "the source asset",
  "the source note",
  "the source memory",
  "the original asset",
  "the original note",
  "the original memory",
  "the original version of this",
  "quality gate rejected",
  "proposal rejected",
];

const DEFAULT_FRONTMATTER_KEYS = [
  "sources",
  "updated",
  "inferenceProcessed",
  "captureMode",
  "beliefState",
  "xrefs",
  "contradictedBy",
  "outcomeData",
  "orderedActions",
  "generated",
  "verified",
  "description",
  "when_to_use",
  "tags",
  "searchHints",
  "quality",
  "salience",
  "salienceInputs",
  "lint_skip",
  "type",
];

/**
 * The first defect the candidate has and its source lacks, or `undefined`. Each
 * rule counts only what the revision adds, so text the asset already carried is
 * not held against it. On 396 labelled reflect edits (83 good, 313 bad) the
 * default lists hit 22 bad edits and no good one, so a hit is refused unjudged.
 */
export function findReflectDefect(
  sourceContent: string,
  candidateContent: string,
  filter: ReflectDefectFilter = {},
): ReflectDefect | undefined {
  if (gainsPhrases(filter.placeholders ?? DEFAULT_PLACEHOLDERS, sourceContent, candidateContent)) {
    return "placeholder_added";
  }
  if (gainsPhrases(filter.metaCommentary ?? DEFAULT_META_COMMENTARY, sourceContent, candidateContent)) {
    return "meta_commentary_added";
  }
  if (frontmatterCopiedIntoBody(sourceContent, candidateContent, filter.frontmatterKeys ?? DEFAULT_FRONTMATTER_KEYS)) {
    return "frontmatter_copied_into_body";
  }
  return undefined;
}

/** Frontmatter fields that name other assets; one of their values newly in the body is provenance copied over. */
const PROVENANCE_KEYS = ["sources", "xrefs", "contradictedBy"];
/** Shorter values (a bare name or id) say too little to find in a body. */
const PROVENANCE_VALUE_MIN_CHARS = 12;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the candidate holds more of the phrases than the source: whole words, any case, any whitespace between words. */
function gainsPhrases(phrases: readonly string[], source: string, candidate: string): boolean {
  const alternatives = phrases
    .map((phrase) => phrase.trim().split(/\s+/).map(escapeRegExp).join("\\s+"))
    .filter((alternative) => alternative !== "");
  if (alternatives.length === 0) return false;
  const pattern = new RegExp(`(?<!\\w)(?:${alternatives.join("|")})(?!\\w)`, "gi");
  return (candidate.match(pattern)?.length ?? 0) > (source.match(pattern)?.length ?? 0);
}

/** The body gains a line that starts with one of the frontmatter keys outside code, or a provenance value from either asset's frontmatter. */
function frontmatterCopiedIntoBody(source: string, candidate: string, keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  const keyLine = new RegExp(`^(?:${keys.map(escapeRegExp).join("|")}):(?:[ \\t].*)?$`);
  const keyLines = (text: string) => parseSections(text).proseLines.filter((line) => keyLine.test(line)).length;
  if (keyLines(candidate) > keyLines(source)) return true;
  const sourceBody = lettersAndDigits(splitFrontmatter(source).body);
  const candidateBody = lettersAndDigits(splitFrontmatter(candidate).body);
  return [...provenanceValues(source), ...provenanceValues(candidate)].some((value) => {
    const v = lettersAndDigits(value);
    return v.length >= PROVENANCE_VALUE_MIN_CHARS && candidateBody.includes(v) && !sourceBody.includes(v);
  });
}

/** Every string under the provenance keys of a frontmatter block: a scalar, or the items of a list. */
function provenanceValues(content: string): string[] {
  const { data } = parseFrontmatter(content);
  return PROVENANCE_KEYS.flatMap((key) => {
    const value = data[key];
    return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
  });
}

/** Lower-case letters and digits, each run of anything else a single space. */
function lettersAndDigits(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A `---` frontmatter block and the rest (`fmText: null` when there is none). */
export function splitFrontmatter(raw: string): { fmText: string | null; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { fmText: m[1] ?? "", body: m[2] ?? "" } : { fmText: null, body: raw };
}

/** Frontmatter text, fenced code blocks, and prose lines (an unclosed fence counts as prose). */
function parseSections(text: string): { frontmatter: string; codeFences: string[]; proseLines: string[] } {
  const { fmText, body } = splitFrontmatter(normalizeTrailingWhitespace(text));
  const codeFences: string[] = [];
  const proseLines: string[] = [];
  let fence: { marker: string; lines: string[] } | undefined;
  for (const line of body.split("\n")) {
    if (fence) {
      const close = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*$/);
      if (close?.[2]?.startsWith(fence.marker)) {
        codeFences.push(fence.lines.join("\n"));
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const open = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (open) fence = { marker: open[2] ?? "```", lines: [] };
    else proseLines.push(line);
  }
  if (fence) proseLines.push(...fence.lines);
  return { frontmatter: fmText ?? "", codeFences, proseLines };
}

/** CRLF → LF, no trailing spaces per line, no trailing newlines. */
export function normalizeTrailingWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

/** Canonical frontmatter (parsed YAML, keys sorted) plus the normalized body; equal forms differ only cosmetically. */
export function cosmeticNormalForm(text: string): string {
  const { fmText, body } = splitFrontmatter(normalizeTrailingWhitespace(text));
  let fmCanonical = "";
  if (fmText !== null) {
    try {
      fmCanonical = stableStringify(yamlParse(fmText));
    } catch {
      fmCanonical = fmText; // unparsable: any real edit still registers
    }
  }
  return `${fmCanonical}\u0000${normalizeMarkdownBody(body)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const FENCE_LINE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
/** Headings, setext underlines, thematic breaks and table rows never absorb the next line. */
const TERMINAL_LINE = /^\s{0,3}(#{1,6}(\s|$)|=+\s*$|(-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$|\|)/;
/** List items and blockquotes allow lazy continuation. */
const CONTINUABLE_LINE = /^\s*([-*+]\s|\d{1,9}[.)]\s|>)/;
const INDENTED_CODE_LINE = /^(\t| {4})/;

type LogicalKind = "blank" | "verbatim" | "terminal" | "continuable" | "prose";

/**
 * A markdown body for cosmetic comparison: fence language hints dropped (code
 * kept verbatim), indented code verbatim, hard-wrapped prose joined into the
 * preceding prose/list/quote line, inner whitespace runs collapsed, blank runs
 * collapsed and trimmed.
 */
export function normalizeMarkdownBody(body: string): string {
  const logical: string[] = [];
  let lastKind = "blank" as LogicalKind;
  let fenceMarker: string | null = null;
  const push = (line: string, kind: LogicalKind) => {
    logical.push(line);
    lastKind = kind;
  };
  for (const line of normalizeTrailingWhitespace(body).split("\n")) {
    if (fenceMarker !== null) {
      const close = line.match(FENCE_LINE);
      if (close?.[2]?.startsWith(fenceMarker) && close[3]?.trim() === "") {
        fenceMarker = null;
        push(line.trim(), "terminal");
      } else {
        push(line, "verbatim");
      }
      continue;
    }
    const fence = line.match(FENCE_LINE);
    if (fence) {
      fenceMarker = fence[2] ?? "```";
      push(fenceMarker, "terminal");
    } else if (line.trim() === "") {
      if (lastKind !== "blank") push("", "blank");
    } else if (INDENTED_CODE_LINE.test(line)) {
      push(line, "verbatim");
    } else if (TERMINAL_LINE.test(line)) {
      push(collapseInnerWhitespace(line), "terminal");
    } else if (CONTINUABLE_LINE.test(line)) {
      push(collapseInnerWhitespace(line), "continuable");
    } else if (lastKind === "prose" || lastKind === "continuable") {
      logical[logical.length - 1] = `${logical[logical.length - 1]} ${collapseInnerWhitespace(line.trim())}`;
    } else {
      push(collapseInnerWhitespace(line.trim()), "prose");
    }
  }
  while (logical[0] === "") logical.shift();
  while (logical[logical.length - 1] === "") logical.pop();
  return logical.join("\n");
}

/** Collapse inner space/tab runs, keeping the leading indent. */
function collapseInnerWhitespace(line: string): string {
  const m = line.match(/^([ \t]*)([\s\S]*)$/);
  return (m?.[1] ?? "") + (m?.[2] ?? "").replace(/[ \t]+/g, " ");
}
