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
