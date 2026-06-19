// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Encoding-time salience scoring for issue #608.
 *
 * Pure module — no I/O. All inputs are pre-fetched by the caller.
 * Implements the three-signal model: novelty × 0.40 + magnitude × 0.35 +
 * predictionError × 0.25, clamped to [0, 1].
 */

// ── Weights ────────────────────────────────────────────────────────────────────

const W_NOVELTY = 0.4;
const W_MAGNITUDE = 0.35;
const W_PREDICTION_ERROR = 0.25;

// Guard: weights must sum to 1.0 (consistent with the pattern in salience.ts).
// This check fires at module load and catches any future re-tuning mistakes.
if (Math.abs(W_NOVELTY + W_MAGNITUDE + W_PREDICTION_ERROR - 1.0) > 1e-9) {
  throw new Error(
    `encoding-salience.ts: sub-signal weights must sum to 1.0 (got ${W_NOVELTY + W_MAGNITUDE + W_PREDICTION_ERROR})`,
  );
}

// ── Novelty type floors ────────────────────────────────────────────────────────

const TYPE_NOVELTY_FLOOR: Readonly<Record<string, number>> = Object.freeze({
  skill: 0.8,
  agent: 0.8,
  memory: 0.4,
});

const DEFAULT_NOVELTY_FLOOR = 0.5;

// ── Magnitude keyword sets ──────────────────────────────────────────────────────

const SEVERITY_BUCKET = new Set(["error", "critical", "warning", "incident", "regression"]);

// Note: "fails" and "urgent" are from the spec's initial keyword list and are included
// here as strong constraint signals, even though the spec's final bucket table omits them.
const CONSTRAINT_BUCKET = new Set(["must", "never", "always", "blocked", "breaking", "deprecated", "fails", "urgent"]);

const ALL_MAGNITUDE_KEYWORDS = new Set([...SEVERITY_BUCKET, ...CONSTRAINT_BUCKET]);

// Number of distinct keyword matches to reach full magnitude score.
const MAGNITUDE_FULL_SCORE_THRESHOLD = 4;

// Single-bucket magnitude cap: when only one semantic bucket matches.
const MAGNITUDE_SINGLE_BUCKET_CAP = 0.5;

// ── Stop-words (excluded from bigram tokenization) ────────────────────────────

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "it",
  "its",
  "be",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "not",
  "this",
  "that",
  "these",
  "those",
  "i",
  "we",
  "you",
  "he",
  "she",
  "they",
  "my",
  "our",
  "your",
  "his",
  "her",
  "their",
  "can",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "shall",
  "so",
  "if",
  "then",
  "than",
  "when",
  "while",
  "what",
  "which",
  "who",
  "how",
  "no",
  "any",
  "all",
  "more",
  "also",
]);

// ── Input / output interfaces ──────────────────────────────────────────────────

export interface EncodingSalienceInputs {
  body: string;
  type: string;
  /** Pre-built bigram vocabulary from known ref names and tags. */
  existingRefVocabulary: Set<string>;
  /** 0 for a brand-new asset. */
  revisionCount: number;
}

export interface EncodingSalienceResult {
  /** Final clamped score in [0, 1]. */
  score: number;
  novelty: number;
  magnitude: number;
  predictionError: number;
}

// ── Tokenization helpers ──────────────────────────────────────────────────────

/**
 * Tokenize text into lowercase words, splitting on whitespace and punctuation,
 * dropping stop-words. Used for body bigram extraction (novelty signal).
 */
function tokenizeBody(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}\-_/]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Tokenize a ref name or tag into lowercase words without stop-word filtering.
 * Ref names are identifiers, not prose — all tokens are significant.
 */
function tokenizeRef(ref: string): string[] {
  return ref
    .toLowerCase()
    .split(/[\s\p{P}\p{S}\-_/]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Generate all consecutive bigrams from an array of tokens.
 * Returns them as "token1 token2" strings.
 */
function bigrams(tokens: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    result.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return result;
}

/**
 * Build the existing-ref vocabulary: a Set of bigrams derived from tokenizing
 * the provided ref names (and tags). Pass this to `scoreEncodingSalience` as
 * `existingRefVocabulary` so the novelty signal can measure how much of the
 * asset body is already represented in the stash vocabulary.
 */
export function buildRefVocabulary(refs: string[]): Set<string> {
  const vocab = new Set<string>();
  for (const ref of refs) {
    const tokens = tokenizeRef(ref);
    for (const bg of bigrams(tokens)) {
      vocab.add(bg);
    }
  }
  return vocab;
}

// ── Sub-signal computations ────────────────────────────────────────────────────

function computeNovelty(body: string, type: string, vocab: Set<string>): number {
  const tokens = tokenizeBody(body);
  const bgs = bigrams(tokens);

  const floor = TYPE_NOVELTY_FLOOR[type] ?? DEFAULT_NOVELTY_FLOOR;

  if (bgs.length === 0) return floor;

  const novelCount = bgs.filter((bg) => !vocab.has(bg)).length;
  const bigramNoveltyFraction = novelCount / bgs.length;

  return Math.max(floor, bigramNoveltyFraction);
}

function computeMagnitude(body: string): number {
  const lowerBody = body.toLowerCase();
  // Split on word boundaries to avoid partial matches (e.g. "errors" matching "error").
  const words = new Set(lowerBody.split(/\W+/).filter((w) => w.length > 0));

  const matched = [...ALL_MAGNITUDE_KEYWORDS].filter((kw) => words.has(kw));
  if (matched.length === 0) return 0;

  const distinctCount = matched.length;
  const rawMagnitude = Math.min(1.0, distinctCount / MAGNITUDE_FULL_SCORE_THRESHOLD);

  // Require at least one match from each bucket to lift the single-bucket cap.
  const hasSeverity = matched.some((kw) => SEVERITY_BUCKET.has(kw));
  const hasConstraint = matched.some((kw) => CONSTRAINT_BUCKET.has(kw));

  if (hasSeverity && hasConstraint) return rawMagnitude;
  return Math.min(rawMagnitude, MAGNITUDE_SINGLE_BUCKET_CAP);
}

function computePredictionError(revisionCount: number): number {
  if (revisionCount === 0) return 1.0;
  return 1 / (1 + Math.log(1 + revisionCount));
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Compute the encoding-time salience score for an asset.
 *
 * Three sub-signals:
 *   novelty (0.40) — how much of the body is absent from the stash vocabulary.
 *   magnitude (0.35) — presence of severity/constraint keywords.
 *   predictionError (0.25) — surprise: high for new assets, decays with revisions.
 */
export function scoreEncodingSalience(inputs: EncodingSalienceInputs): EncodingSalienceResult {
  const novelty = computeNovelty(inputs.body, inputs.type, inputs.existingRefVocabulary);
  const magnitude = computeMagnitude(inputs.body);
  const predictionError = computePredictionError(inputs.revisionCount);

  const raw = W_NOVELTY * novelty + W_MAGNITUDE * magnitude + W_PREDICTION_ERROR * predictionError;
  const score = Math.min(1, Math.max(0, raw));

  return { score, novelty, magnitude, predictionError };
}
