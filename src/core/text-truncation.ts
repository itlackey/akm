// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared text-truncation heuristics used by `distill` and `consolidate`.
 *
 * Both commands need to recognise when an LLM-produced description string was
 * sliced mid-sentence (typically the model hit its output budget). The two
 * implementations historically maintained overlapping-but-not-identical
 * vocabularies of hanging-connector words, which was a maintenance trap.
 *
 * This module is the single source of truth. `distill` continues to layer its
 * own section-heading regex on top (those patterns are distill-specific and
 * intentionally stay local to that module).
 */

/**
 * Words that, when ending a sentence, suggest the description was truncated
 * mid-sentence. Prepositions, conjunctions, articles, and auxiliary verbs that
 * almost always have *something* following them in well-formed prose.
 *
 * This is the UNION of the two prior vocabularies used by `distill` and
 * `consolidate` — a superset of both, so behaviour is at least as strict as
 * either previous check.
 *
 * Stored lowercased; callers must lower-case the last word before lookup.
 */
export const TRUNCATION_TRAILING_WORDS: ReadonlySet<string> = new Set([
  "a",
  "after",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "may",
  "might",
  "must",
  "of",
  "on",
  "onto",
  "or",
  "per",
  "shall",
  "should",
  "so",
  "than",
  "that",
  "the",
  "to",
  "upon",
  "via",
  "was",
  "were",
  "when",
  "which",
  "while",
  "will",
  "with",
  "would",
]);

/**
 * Returns a reason string when `description` looks truncated mid-sentence;
 * returns `null` if the description appears complete.
 *
 * Heuristics:
 *   - Trailing `,`, `;`, `:`, or `+` (operator-style cutoff like `max-width:100% +`)
 *   - Trailing ellipsis (`...` or `…`)
 *   - Last word matches {@link TRUNCATION_TRAILING_WORDS}
 *
 * Does NOT detect section-heading fragments — that check is distill-specific
 * and lives in `src/commands/distill.ts` (`HEADING_FRAGMENT_PATTERNS`).
 */
export function detectTruncatedDescription(description: string): string | null {
  const trimmed = description.trim();
  if (trimmed.length === 0) return null; // empty handled elsewhere
  if (/[,;:+]$/.test(trimmed)) return "ends with trailing punctuation/operator";
  if (/\.{3,}$/.test(trimmed) || /…$/.test(trimmed)) return "ends with ellipsis";
  const lastWord = trimmed.split(/\s+/).pop() ?? "";
  const normalized = lastWord.toLowerCase();
  if (TRUNCATION_TRAILING_WORDS.has(normalized)) {
    return `ends with hanging connector "${lastWord}"`;
  }
  return null;
}

// ── Post-generation repair pass (issue #556) ─────────────────────────────────

/**
 * Minimum length (chars) for a repaired description to be considered usable.
 * Mirrors the floor in `isValidDescription` (≥20). Kept local so this module
 * stays dependency-free of the validators (avoids an import cycle).
 */
const MIN_REPAIRED_DESCRIPTION_LEN = 20;

/** Maximum length (chars) for a repaired description. Mirrors `isValidDescription` (≤400). */
const MAX_REPAIRED_DESCRIPTION_LEN = 400;

/**
 * Strip trailing truncation fragments from a candidate clause: repeatedly drop
 * a hanging-connector word and/or trailing `,` `;` `:` `+` and ellipses until
 * the clause no longer looks truncated. PURE — no fabrication, only removal.
 *
 * Returns the trimmed-to-last-complete-token clause (may be empty if the whole
 * thing was connectors/punctuation).
 */
function stripTrailingTruncationFragment(clause: string): string {
  let s = clause.trim();
  // Loop because a tail can stack: "… related to the" → drop "the" → drop "to".
  for (let guard = 0; guard < 64; guard++) {
    const before = s;
    // Drop trailing ellipsis / connector-only punctuation+operators.
    s = s.replace(/\s*(\.{3,}|…)$/u, "").trim();
    s = s.replace(/\s*[,;:+]+$/u, "").trim();
    // Drop a trailing hanging-connector word (and any punctuation glued to it).
    const m = s.match(/(?:^|\s)([A-Za-z']+)[.!?]*$/u);
    if (m) {
      const word = (m[1] ?? "").toLowerCase();
      if (TRUNCATION_TRAILING_WORDS.has(word)) {
        // Remove just the final word token (keep preceding text).
        s = s.slice(0, s.length - m[0].length).trim();
      }
    }
    if (s === before) break;
  }
  return s;
}

/**
 * Split prose into sentences on `.`/`!`/`?` boundaries (followed by whitespace
 * or end). Keeps the terminating punctuation. Deliberately simple — good enough
 * for the short, single-paragraph descriptions/bodies this repair operates on.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/gu)) {
    const s = match[0].trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * True when `candidate` is a self-contained, non-truncated clause of acceptable
 * length. Used to gate repair outputs without importing the full validator
 * (which would create a cycle). The full `isValidDescription` still runs
 * downstream — this is only the truncation/length subset the repair targets.
 */
function isUsableClause(candidate: string): boolean {
  const c = candidate.trim();
  if (c.length < MIN_REPAIRED_DESCRIPTION_LEN) return false;
  if (c.length > MAX_REPAIRED_DESCRIPTION_LEN) return false;
  if (detectTruncatedDescription(c) !== null) return false;
  // Must contain at least one word character (not pure punctuation).
  if (!/[A-Za-z0-9]/.test(c)) return false;
  return true;
}

/** Append a period when the clause lacks terminal sentence punctuation. PURE. */
function ensureTerminalPunctuation(clause: string): string {
  const c = clause.trim();
  if (/[.!?]$/.test(c)) return c;
  return `${c}.`;
}

/**
 * Deterministically repair an LLM-generated description that was sliced
 * mid-sentence (issue #556). The repair NEVER fabricates new claims:
 *
 *   1. If the description is not truncated, it is returned **byte-identical**
 *      (zero behaviour change for already-valid descriptions).
 *   2. Otherwise:
 *      a. **trim-to-last-complete-clause** — strip the trailing
 *         truncation-indicator word(s)/punctuation; if a complete earlier
 *         sentence survives, use the longest non-truncated prefix.
 *      b. **swap-in first body sentence** — if (a) yields nothing usable and a
 *         `body` is provided, use the first clean, complete sentence of the
 *         body.
 *      c. **fallback** — if neither produces a usable, non-truncated clause,
 *         return the original string unchanged so the existing validation
 *         rejects it exactly as before (no regression, no fabrication).
 *
 * @param description The raw description (possibly truncated).
 * @param body Optional asset body to source a clean completion sentence from.
 */
export function repairTruncatedDescription(description: string, body?: string): string {
  if (typeof description !== "string") return description;
  // Guarantee: untruncated input passes through byte-identical.
  if (detectTruncatedDescription(description) === null) return description;

  const trimmed = description.trim();

  // (a) trim-to-last-complete-clause.
  // First, try the whole string with its trailing fragment stripped.
  const stripped = stripTrailingTruncationFragment(trimmed);
  if (isUsableClause(stripped)) {
    return ensureTerminalPunctuation(stripped);
  }
  // If the description has multiple sentences, the truncation is in the last
  // one — fall back to the longest leading run of complete sentences.
  const sentences = splitSentences(trimmed);
  if (sentences.length > 1) {
    for (let take = sentences.length - 1; take >= 1; take--) {
      const prefix = sentences.slice(0, take).join(" ").trim();
      const cleaned = stripTrailingTruncationFragment(prefix);
      if (isUsableClause(cleaned)) return ensureTerminalPunctuation(cleaned);
    }
  }

  // (b) swap-in first clean, complete body sentence.
  if (typeof body === "string" && body.trim().length > 0) {
    const bodyText = body
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") // drop any frontmatter
      .replace(/```[\s\S]*?```/g, " ") // drop fenced code
      .replace(/`[^`]*`/g, " "); // drop inline code spans
    for (const rawLine of bodyText.split(/\n/)) {
      const line = rawLine
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/^[#*\->_\s]+/, "")
        .trim();
      if (!line) continue;
      if (/^[a-z_]+:\s/i.test(line)) continue; // skip yaml-ish leak lines
      for (const sentence of splitSentences(line)) {
        if (isUsableClause(sentence)) return ensureTerminalPunctuation(sentence);
      }
    }
  }

  // (c) fallback: return original unchanged — validation rejects as before.
  return description;
}
