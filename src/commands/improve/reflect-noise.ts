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

export type ReflectChangeKind = "noop" | "cosmetic" | "low-value" | "substantive";

/**
 * `noop` (identical up to trailing whitespace) and `cosmetic` (identical after
 * normalizing frontmatter as parsed YAML and prose as unwrapped text) never
 * become proposals. `low-value` (#639) is a small prose rewrite — few changed
 * words, nothing structural; the caller decides (off by default).
 */
export function classifyReflectChange(sourceContent: string, candidateContent: string): ReflectChangeKind {
  if (normalizeTrailingWhitespace(sourceContent) === normalizeTrailingWhitespace(candidateContent)) return "noop";
  try {
    if (cosmeticNormalForm(sourceContent) === cosmeticNormalForm(candidateContent)) return "cosmetic";
  } catch {
    // unprovable → substantive
  }
  try {
    if (isLowValueChange(sourceContent, candidateContent)) return "low-value";
  } catch {
    // unprovable → substantive
  }
  return "substantive";
}

export type ReflectDefect = "placeholder_added" | "meta_commentary_added" | "frontmatter_copied_into_body";

/**
 * The first defect the candidate has and its source lacks, or `undefined`. Each
 * rule counts only what the revision adds, so text the asset already carried is
 * not held against it. On 396 labelled reflect edits (83 good, 313 bad) the
 * three rules hit 32 bad edits and no good one, so a hit is refused unjudged.
 */
export function findReflectDefect(sourceContent: string, candidateContent: string): ReflectDefect | undefined {
  if (placeholderAdded(sourceContent, candidateContent)) return "placeholder_added";
  if (metaCommentaryAdded(sourceContent, candidateContent)) return "meta_commentary_added";
  if (frontmatterCopiedIntoBody(sourceContent, candidateContent)) return "frontmatter_copied_into_body";
  return undefined;
}

/** TODO, TBD, FIXME, "please confirm", "to be confirmed", or a bare `# Title` heading. */
const PLACEHOLDER_PATTERNS = [
  /\b(?:TODO|TBD|FIXME)\b/g,
  /\b(?:please (?:confirm|verify)|to be (?:confirmed|determined|verified))\b/gi,
  /^#[ \t]+Title[ \t]*$/gm,
];

/** The asset talking about its own edit: the feedback, the source asset, this revision, a gate rejection. */
const META_COMMENTARY_PATTERNS = [
  /\b(?:the )?feedback (?:signals?|indicates?|suggests?|asks?|says|reports?|requests?)\b/gi,
  /\bthis revision\b/gi,
  /\bthe (?:source|original) (?:asset|note|memory)\b/gi,
  /\bthe original version of this\b/gi,
  /\b(?:quality gate|proposal) rejected\b/gi,
];

/** A body line that starts with one of these frontmatter keys is frontmatter copied into the body. */
const FRONTMATTER_KEY_LINE =
  /^(?:sources|updated|inferenceProcessed|captureMode|beliefState|xrefs|contradictedBy|outcomeData|orderedActions|generated|verified|description|when_to_use|tags|searchHints|quality|salience|salienceInputs|lint_skip|type):(?:[ \t].*)?$/;
/** Frontmatter fields that name other assets; one of their values newly in the body is provenance copied over. */
const PROVENANCE_KEYS = ["sources", "xrefs", "contradictedBy"];
/** Shorter values (a bare name or id) say too little to find in a body. */
const PROVENANCE_VALUE_MIN_CHARS = 12;

/** Whether the candidate holds more matches of `patterns` than the source. */
function gainsMatches(patterns: readonly RegExp[], source: string, candidate: string): boolean {
  const count = (text: string) => patterns.reduce((n, pattern) => n + (text.match(pattern)?.length ?? 0), 0);
  return count(candidate) > count(source);
}

function placeholderAdded(source: string, candidate: string): boolean {
  return gainsMatches(PLACEHOLDER_PATTERNS, source, candidate);
}

function metaCommentaryAdded(source: string, candidate: string): boolean {
  return gainsMatches(META_COMMENTARY_PATTERNS, source, candidate);
}

/** The body gains frontmatter key lines outside code, or a provenance value from either asset's frontmatter. */
function frontmatterCopiedIntoBody(source: string, candidate: string): boolean {
  const keyLines = (text: string) =>
    parseLowValueSections(text).proseLines.filter((line) => FRONTMATTER_KEY_LINE.test(line)).length;
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

/** At most this many changed words (and at least 2 — one word may be a flag flip) is low-value. */
const LOW_VALUE_TOKEN_THRESHOLD = 4;
/** A change to any of these is never low-value. */
const NEGATION_WORDS = new Set(["never", "not", "no", "don't", "avoid", "cannot", "can't"]);
/** Lines recording a decision or outcome are always significant; their words are not counted. */
const DECISION_MARKER_RE = /\b(decision|outcome)\b/i;
const STRUCTURAL_LINE_RE = /^\s*(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|---+|===+|\|\s)/;

function isLowValueChange(source: string, candidate: string): boolean {
  const src = parseLowValueSections(source);
  const cnd = parseLowValueSections(candidate);
  // Code and frontmatter changes are always substantive.
  if (src.codeFences.join("\n") !== cnd.codeFences.join("\n") || src.frontmatter !== cnd.frontmatter) return false;
  if (Math.abs(src.proseLines.length - cnd.proseLines.length) > 2) return false;
  let changedTokens = 0;
  for (let i = 0; i < Math.max(src.proseLines.length, cnd.proseLines.length); i++) {
    const srcLine = src.proseLines[i] ?? "";
    const cndLine = cnd.proseLines[i] ?? "";
    if (srcLine === cndLine || DECISION_MARKER_RE.test(srcLine) || DECISION_MARKER_RE.test(cndLine)) continue;
    if (STRUCTURAL_LINE_RE.test(cndLine) || STRUCTURAL_LINE_RE.test(srcLine)) return false;
    const srcTokens = tokenize(srcLine);
    const cndTokens = tokenize(cndLine);
    const srcNeg = new Set(srcTokens.filter((t) => NEGATION_WORDS.has(t)));
    const cndNeg = new Set(cndTokens.filter((t) => NEGATION_WORDS.has(t)));
    if (srcNeg.size !== cndNeg.size || [...srcNeg].some((t) => !cndNeg.has(t))) return false;
    // max(added, removed) approximates substitutions: "is→runs" counts once.
    const srcSet = new Set(srcTokens);
    const cndSet = new Set(cndTokens);
    changedTokens += Math.max(
      cndTokens.filter((t) => !srcSet.has(t)).length,
      srcTokens.filter((t) => !cndSet.has(t)).length,
    );
  }
  return changedTokens >= 2 && changedTokens < LOW_VALUE_TOKEN_THRESHOLD;
}

/** Frontmatter text, fenced code blocks, and prose lines (an unclosed fence counts as prose). */
function parseLowValueSections(text: string): { frontmatter: string; codeFences: string[]; proseLines: string[] } {
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

function tokenize(line: string): string[] {
  return line
    .toLowerCase()
    .replace(/’/g, "'") // curly apostrophes still match "don't"
    .replace(/[^a-z0-9'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
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
