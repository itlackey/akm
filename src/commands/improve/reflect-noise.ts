// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reflect noise gate (#580) — deterministic detection of no-op and
 * cosmetic-only reflect candidates.
 *
 * Manual review of the proposal queue (June 2026) found that 2 of 5 pending
 * reflect proposals had literally EMPTY diffs and 2 more were cosmetic-only
 * (YAML description re-folding, code-fence language hints, whitespace
 * reflow / unwrapping of hard-wrapped prose). Each wasted an LLM call AND a
 * review-queue slot. This module classifies a candidate edit against the
 * current asset BEFORE `createProposal()` so reflect can short-circuit.
 *
 * Classification is pure text comparison — no LLM involved:
 *
 *   - `"noop"`     — byte-identical after trailing-whitespace normalization.
 *   - `"cosmetic"` — identical after a conservative cosmetic normalization
 *                    of both sides (frontmatter compared as parsed YAML so
 *                    folded/literal scalar re-folding cancels out; markdown
 *                    body compared with hard-wrapped prose unwrapped,
 *                    whitespace runs collapsed, and code-fence language
 *                    hints stripped).
 *   - `"substantive"` — everything else, including every case the
 *                    normalizer is unsure about.
 *
 * The normalizer is deliberately conservative: a false NEGATIVE (letting a
 * cosmetic proposal through) costs one review-queue slot; a false POSITIVE
 * (suppressing a real fix) loses work. When in doubt, classify as
 * substantive. Concretely:
 *
 *   - Fenced code block contents are compared verbatim (whitespace inside
 *     code is significant).
 *   - Indented (4-space / tab) code lines are compared verbatim.
 *   - Headings, tables, and thematic breaks never absorb the following
 *     line, so `# Title\nprose` vs `# Title prose` stays substantive.
 *   - Prose only unwraps into the previous line when that line is itself
 *     plain prose or a list/blockquote item (CommonMark lazy continuation).
 */

import { parse as yamlParse } from "yaml";

/** Outcome of {@link classifyReflectChange}. */
export type ReflectChangeKind = "noop" | "cosmetic" | "low-value" | "substantive";

/**
 * Classify a reflect candidate against the current asset content.
 *
 * `"noop"` and `"cosmetic"` candidates must never become proposals; only
 * `"substantive"` changes proceed to `createProposal()`.
 *
 * `"low-value"` is a tier between `"cosmetic"` and `"substantive"` (#639):
 * a small prose rewrite that changes few content-words outside fenced code,
 * without introducing new headings, list items, or code lines. The caller
 * decides whether to act on it (config-gated, DEFAULT OFF).
 */
export function classifyReflectChange(sourceContent: string, candidateContent: string): ReflectChangeKind {
  if (normalizeTrailingWhitespace(sourceContent) === normalizeTrailingWhitespace(candidateContent)) {
    return "noop";
  }
  try {
    if (cosmeticNormalForm(sourceContent) === cosmeticNormalForm(candidateContent)) {
      return "cosmetic";
    }
  } catch {
    // Conservative: a normalizer error means we cannot prove the change is
    // cosmetic — let the proposal through.
  }
  // Low-value tier (#639): deterministic semantic-value-floor check.
  try {
    if (isLowValueChange(sourceContent, candidateContent)) {
      return "low-value";
    }
  } catch {
    // Conservative: treat any classifier error as substantive.
  }
  return "substantive";
}

// ---------------------------------------------------------------------------
// Low-value tier (#639) helpers
// ---------------------------------------------------------------------------

/**
 * Threshold: the maximum number of net changed content-words in eligible prose
 * lines for a change to be classified as `"low-value"`. Conservative/low to
 * minimise false positives (substantive changes suppressed).
 */
const LOW_VALUE_TOKEN_THRESHOLD = 4;

/**
 * Negation / flag-correction words that make a line exempt from low-value
 * classification even when the token-change count is below the threshold.
 * A line that introduces or removes one of these words carries enough semantic
 * weight to be treated as substantive.
 */
const NEGATION_WORDS = new Set(["never", "not", "no", "don't", "avoid", "cannot", "can't"]);

/**
 * Pattern for lines that contain decision / outcome markers. Changed tokens on
 * these lines are EXEMPT from the low-value token count (they are semantically
 * significant regardless of token volume).
 */
const DECISION_MARKER_RE = /\b(decision|outcome)\b/i;

/**
 * Pattern for lines that start a new structural element (ATX heading, list
 * item, thematic break). A candidate that ADDS such lines is not low-value.
 */
const STRUCTURAL_LINE_RE = /^\s*(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|---+|===+|\|\s)/;

/**
 * Determine whether the change from `source` to `candidate` qualifies as
 * `"low-value"`: a small prose rewrite with few changed content-words outside
 * fenced code / frontmatter / decision markers, without adding structural lines.
 *
 * Conservative / false-negative-biased: returns `false` (= substantive) when
 * any exemption condition is met or when the parser is unsure.
 */
function isLowValueChange(source: string, candidate: string): boolean {
  const srcParsed = parseLowValueSections(source);
  const cndParsed = parseLowValueSections(candidate);

  // Any change inside a code fence → substantive (code is always significant).
  if (srcParsed.codeFences.join("\n") !== cndParsed.codeFences.join("\n")) {
    return false;
  }

  // Any change in frontmatter → substantive (description / when_to_use are semantic).
  if (srcParsed.frontmatter !== cndParsed.frontmatter) {
    return false;
  }

  // Check prose body lines for low-value criteria.
  const srcLines = srcParsed.proseLines;
  const cndLines = cndParsed.proseLines;

  // Build a word-diff over prose lines. Align by line index (conservative: if
  // line counts differ significantly, call it substantive).
  if (Math.abs(srcLines.length - cndLines.length) > 2) {
    return false;
  }

  const maxLen = Math.max(srcLines.length, cndLines.length);
  let changedTokens = 0;
  let hasNewStructuralLine = false;

  for (let i = 0; i < maxLen; i++) {
    const srcLine = srcLines[i] ?? "";
    const cndLine = cndLines[i] ?? "";

    if (srcLine === cndLine) continue;

    // Lines with decision/outcome markers are exempt — skip their token diff.
    if (DECISION_MARKER_RE.test(srcLine) || DECISION_MARKER_RE.test(cndLine)) {
      continue;
    }

    // Any structural line (heading, list item, thematic break) changed → not
    // low-value. Structural changes affect document organization and are
    // inherently significant regardless of token count.
    if (STRUCTURAL_LINE_RE.test(cndLine) || STRUCTURAL_LINE_RE.test(srcLine)) {
      hasNewStructuralLine = true;
      break;
    }

    // Tokenise both lines into lowercase words.
    const srcTokens = tokenize(srcLine);
    const cndTokens = tokenize(cndLine);

    // Check for negation / flag-correction words: if the set of negation words
    // differs between versions → the change is semantically significant (exempt).
    const srcNegSet = new Set(srcTokens.filter((t) => NEGATION_WORDS.has(t)));
    const cndNegSet = new Set(cndTokens.filter((t) => NEGATION_WORDS.has(t)));
    const negSetsEqual = srcNegSet.size === cndNegSet.size && [...srcNegSet].every((t) => cndNegSet.has(t));
    if (!negSetsEqual) {
      return false;
    }

    // Count changed tokens: words unique to each side (symmetric difference).
    // Counting max(added, removed) approximates "number of substitutions" so
    // that "is→runs" + "default→defaults" counts as 2, not 4.
    const srcSet = new Set(srcTokens);
    const cndSet = new Set(cndTokens);
    const addedTokens = cndTokens.filter((t) => !srcSet.has(t));
    const removedTokens = srcTokens.filter((t) => !cndSet.has(t));
    changedTokens += Math.max(addedTokens.length, removedTokens.length);
  }

  if (hasNewStructuralLine) return false;

  // Must have at least 2 changed tokens to qualify as low-value:
  //   - 0 changed tokens → noop/cosmetic (handled upstream, never reaches here)
  //   - 1 changed token  → single-word substitution; too small to be reliably
  //     "low-value" vs a semantically significant flag flip → treat as substantive
  //   - 2..threshold-1   → genuine prose micro-rewrite → low-value
  return changedTokens >= 2 && changedTokens < LOW_VALUE_TOKEN_THRESHOLD;
}

/** Split a document into its frontmatter text, code-fence blocks, and prose lines. */
function parseLowValueSections(text: string): {
  frontmatter: string;
  codeFences: string[];
  proseLines: string[];
} {
  const normalized = normalizeTrailingWhitespace(text);
  // Split off frontmatter.
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = fmMatch ? (fmMatch[1] ?? "") : "";
  const body = fmMatch ? (fmMatch[2] ?? normalized) : normalized;

  const lines = body.split("\n");
  const codeFences: string[] = [];
  const proseLines: string[] = [];
  let inFence = false;
  let currentFence: string[] = [];
  let fenceMarker = "";

  for (const line of lines) {
    if (inFence) {
      const closeMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*$/);
      if (closeMatch?.[2]?.startsWith(fenceMarker)) {
        inFence = false;
        codeFences.push(currentFence.join("\n"));
        currentFence = [];
        fenceMarker = "";
      } else {
        currentFence.push(line);
      }
    } else {
      const openMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
      if (openMatch) {
        inFence = true;
        fenceMarker = openMatch[2] ?? "```";
        currentFence = [];
      } else {
        proseLines.push(line);
      }
    }
  }
  // Unclosed fence: treat as prose (conservative).
  if (inFence && currentFence.length > 0) {
    proseLines.push(...currentFence);
  }

  return { frontmatter, codeFences, proseLines };
}

/** Split a prose line into lowercase word tokens, filtering punctuation. */
function tokenize(line: string): string[] {
  return (
    line
      .toLowerCase()
      // Normalize the curly apostrophe (U+2019) to a straight one so negation words
      // like "don't"/"can't" match regardless of which glyph the content uses.
      .replace(/’/g, "'")
      .replace(/[^a-z0-9'-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0)
  );
}

/**
 * Trailing-whitespace normalization used for the `"noop"` check: CRLF → LF,
 * strip trailing spaces/tabs per line, drop trailing newlines.
 */
export function normalizeTrailingWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

/**
 * Compute the cosmetic normal form of an asset: canonicalized frontmatter
 * (parsed YAML, keys sorted) + normalized markdown body, joined with a
 * separator that cannot occur in either part.
 *
 * Two assets with equal normal forms differ only cosmetically.
 */
export function cosmeticNormalForm(text: string): string {
  const { fmText, body } = splitFrontmatterText(normalizeTrailingWhitespace(text));
  const fmCanonical = fmText === null ? "" : canonicalizeYamlText(fmText);
  return `${fmCanonical}\u0000${normalizeMarkdownBody(body)}`;
}

/**
 * Split a normalized blob into `{ fmText, body }`. Returns `fmText: null`
 * when the blob does not start with a `---` frontmatter block. Mirrors the
 * splitter in `reflect.ts` (kept local: this module must stay dependency-light
 * and pure so the normalizer is trivially unit-testable).
 */
function splitFrontmatterText(raw: string): { fmText: string | null; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fmText: null, body: raw };
  return { fmText: m[1] ?? "", body: m[2] ?? "" };
}

/**
 * Canonicalize a YAML frontmatter block: parse and re-serialize as JSON with
 * recursively sorted object keys. Folded (`>`) and literal (`|`) scalars,
 * quoting style, and key order all cancel out; the parsed VALUES are what we
 * compare. Unparsable YAML falls back to the raw text (trailing-stripped) so
 * any real edit still registers as a difference.
 */
function canonicalizeYamlText(fmText: string): string {
  try {
    return stableStringify(yamlParse(fmText));
  } catch {
    return fmText;
  }
}

/** JSON.stringify with recursively sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Opening or closing fence: optional indent + ``` / ~~~ + optional info string. */
const FENCE_LINE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
/**
 * Lines that terminate a logical line and never absorb a following prose
 * line: ATX headings, setext underlines, thematic breaks, table rows.
 */
const TERMINAL_LINE = /^\s{0,3}(#{1,6}(\s|$)|=+\s*$|(-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$|\|)/;
/** List items and blockquotes — start a logical line but allow lazy continuation. */
const CONTINUABLE_LINE = /^\s*([-*+]\s|\d{1,9}[.)]\s|>)/;
/** Indented code block line (outside any list context — treated verbatim). */
const INDENTED_CODE_LINE = /^(\t| {4})/;

type LogicalKind = "blank" | "verbatim" | "terminal" | "continuable" | "prose";

/**
 * Normalize a markdown body for cosmetic comparison:
 *
 *   - code-fence language hints stripped from opening fences; fenced
 *     contents kept verbatim
 *   - indented code lines kept verbatim
 *   - hard-wrapped prose unwrapped into the preceding prose / list /
 *     blockquote line (single space join)
 *   - runs of spaces/tabs inside prose collapsed to one space
 *   - runs of blank lines collapsed to one; leading/trailing blanks dropped
 */
export function normalizeMarkdownBody(body: string): string {
  const lines = normalizeTrailingWhitespace(body).split("\n");
  const logical: string[] = [];
  let lastKind: LogicalKind = "blank";
  let fenceMarker: string | null = null;

  for (const line of lines) {
    if (fenceMarker !== null) {
      const close = line.match(FENCE_LINE);
      if (close?.[2]?.startsWith(fenceMarker) && close[3]?.trim() === "") {
        fenceMarker = null;
        logical.push(line.trim());
        lastKind = "terminal";
      } else {
        logical.push(line); // code content: compare verbatim
        lastKind = "verbatim";
      }
      continue;
    }

    const fence = line.match(FENCE_LINE);
    if (fence) {
      fenceMarker = fence[2] ?? "```";
      // Strip the info string (language hint) — ```js and ``` compare equal.
      logical.push(fenceMarker);
      lastKind = "terminal";
      continue;
    }

    if (line.trim() === "") {
      if (lastKind !== "blank") {
        logical.push("");
        lastKind = "blank";
      }
      continue;
    }

    if (INDENTED_CODE_LINE.test(line)) {
      logical.push(line);
      lastKind = "verbatim";
      continue;
    }

    if (TERMINAL_LINE.test(line)) {
      logical.push(collapseInnerWhitespace(line));
      lastKind = "terminal";
      continue;
    }

    if (CONTINUABLE_LINE.test(line)) {
      logical.push(collapseInnerWhitespace(line));
      lastKind = "continuable";
      continue;
    }

    // Plain prose: unwrap into the previous logical line when it can lazily
    // continue (prose or list/blockquote); otherwise start a new logical line.
    const collapsed = collapseInnerWhitespace(line.trim());
    if (lastKind === "prose" || lastKind === "continuable") {
      // lastKind stays joinable (prose continuation keeps absorbing).
      logical[logical.length - 1] = `${logical[logical.length - 1]} ${collapsed}`;
    } else {
      logical.push(collapsed);
      lastKind = "prose";
    }
  }

  // Drop leading/trailing blank logical lines.
  while (logical[0] === "") logical.shift();
  while (logical[logical.length - 1] === "") logical.pop();
  return logical.join("\n");
}

/** Collapse internal space/tab runs to a single space, preserving leading indent. */
function collapseInnerWhitespace(line: string): string {
  const m = line.match(/^([ \t]*)([\s\S]*)$/);
  const indent = m?.[1] ?? "";
  const rest = m?.[2] ?? "";
  return indent + rest.replace(/[ \t]+/g, " ");
}
