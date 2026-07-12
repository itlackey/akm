// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 8 — Anti-collapse merge guards.
 *
 *   (a) Generation counter: merged.generation = max(sources)+1; refuse merge
 *       of two assets both above generation N (default 2); merges cite sources.
 *   (b) Lexical-diversity check: low n-gram diversity ⇒ raise merge threshold.
 *   (c) Merge-information floor (R5 §4.2): provenance union must not shrink and
 *       the merged body must retain a minimum fraction of the source tokens.
 *   (d) Occasional random non-similar cluster in the pool.
 *
 * @module anti-collapse
 */

/** Default max generation depth before merge is refused. */
export const DEFAULT_MAX_GENERATION = 2;

/** Default fraction of pool to fill with random (non-similar) clusters. */
export const DEFAULT_RANDOM_CLUSTER_FRACTION = 0.05;

export interface AntiCollapseConfig {
  /**
   * DEFAULT ON since R5 (docs/design/improve-collapse-churn-detector-design.md
   * §4.1, owner-approved): the generation guard, lexical-diversity check, and
   * random-cluster injection are deterministic, cheap, and (except the narrow
   * two-participants-both-over-generation refusal) advisory. Set `false` to
   * opt out and restore the pre-R5 unguarded behavior.
   */
  enabled?: boolean;
  maxGeneration?: number;
  lexicalDiversityCheck?: boolean;
  randomClusterFraction?: number;
  /**
   * R5 §4.2 — measure the merge-information floor (provenance union must not
   * shrink; merged body must retain ≥ minSpecificityRetention of the distinct
   * tokens of its sources). Default true. ADVISORY in v1: a failing merge
   * proceeds but is counted (`merge_floor_violations`) and surfaced via the
   * collapse-detector advisory; the documented promotion path turns it into a
   * refusal once live data confirms the threshold's false-positive rate.
   */
  mergeInformationFloor?: boolean;
  /** Distinct-token retention floor for merges (default 0.6). */
  minSpecificityRetention?: number;
}

/**
 * Read the `generation` field from an asset's frontmatter.
 * Returns 0 when absent (no generation metadata = original asset).
 */
export function readAssetGeneration(frontmatterData: Record<string, unknown>): number {
  const gen = frontmatterData.generation;
  if (typeof gen === "number" && Number.isFinite(gen) && gen >= 0) {
    return Math.floor(gen);
  }
  return 0;
}

/**
 * Compute the new generation for a merged asset.
 * Rule: `merged.generation = max(source generations) + 1`.
 */
export function computeMergedGeneration(sourceGenerations: number[]): number {
  if (sourceGenerations.length === 0) return 1;
  return Math.max(...sourceGenerations) + 1;
}

/**
 * Check whether a merge of the given assets should be refused due to the
 * anti-collapse generation guard.
 *
 * Returns `{ refused: true, reason }` when BOTH assets have generation > maxGeneration.
 * Returns `{ refused: false }` when the merge is allowed.
 *
 * @param sourceGenerations - Generation values for all merge participants.
 * @param config - Anti-collapse config.
 */
export function checkGenerationGuard(
  sourceGenerations: number[],
  config: AntiCollapseConfig,
): { refused: boolean; reason?: string } {
  // R5: default ON — only an explicit opt-out disables the guard.
  if (config.enabled === false) return { refused: false };

  const maxGen = config.maxGeneration ?? DEFAULT_MAX_GENERATION;
  const highGenCount = sourceGenerations.filter((g) => g > maxGen).length;

  if (highGenCount >= 2) {
    return {
      refused: true,
      reason: `Anti-collapse: ${highGenCount} merge participants have generation > ${maxGen} (${sourceGenerations.join(", ")}); refusing to merge over-consolidated assets.`,
    };
  }
  return { refused: false };
}

// ── Merge-information floor (R5 §4.2) ────────────────────────────────────────

export interface MergeInformationFloorResult {
  passed: boolean;
  /** Provenance: |required union| before vs. |merged xrefs| after. */
  provenanceBefore: number;
  provenanceAfter: number;
  /** Specificity proxy: distinct-token retention of merged body vs. union of sources. */
  specificityRetention: number; // 0..1
  reason?: string;
}

/** Distinct-token retention floor default (R5 §4.2). */
export const DEFAULT_MIN_SPECIFICITY_RETENTION = 0.6;

function distinctTokens(text: string): Set<string> {
  // Same lowercase whitespace tokenization computeBigramDiversity uses.
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

/**
 * A merge must strictly increase information (R5 §4.2):
 *  1. Provenance: the merged asset's `xrefs` must be a superset of the union of
 *     all participants' `xrefs` plus the participant refs
 *     themselves — provenance never shrinks through a merge.
 *  2. Specificity: distinctTokens(mergedBody) ≥ minSpecificityRetention ×
 *     |union(distinctTokens(participant bodies))| — a merge that only
 *     shortens/genericizes fails.
 *
 * Pure and deterministic; ADVISORY in v1 (the caller counts violations, it
 * does not refuse the merge). Returns `passed: true` immediately when the
 * anti-collapse suite or the floor itself is opted out.
 */
export function checkMergeInformationFloor(
  mergedBody: string,
  mergedSourceRefs: string[],
  participants: Array<{ ref: string; body: string; sourceRefs: string[] }>,
  config: AntiCollapseConfig,
): MergeInformationFloorResult {
  if (config.enabled === false || config.mergeInformationFloor === false || participants.length === 0) {
    return { passed: true, provenanceBefore: 0, provenanceAfter: 0, specificityRetention: 1 };
  }

  // 1. Provenance union: participants + everything they already cited.
  const required = new Set<string>();
  for (const p of participants) {
    required.add(p.ref);
    for (const sr of p.sourceRefs) required.add(sr);
  }
  const after = new Set(mergedSourceRefs);
  const missing = [...required].filter((r) => !after.has(r));

  // 2. Specificity retention over the union of source tokens.
  const sourceTokens = new Set<string>();
  for (const p of participants) {
    for (const t of distinctTokens(p.body)) sourceTokens.add(t);
  }
  const mergedTokens = distinctTokens(mergedBody);
  // Clamped at computation so the pass/fail decision, the reason string, and
  // the reported field all describe the same value.
  const specificityRetention = Math.min(1, sourceTokens.size === 0 ? 1 : mergedTokens.size / sourceTokens.size);

  const minRetention = config.minSpecificityRetention ?? DEFAULT_MIN_SPECIFICITY_RETENTION;
  const provenanceOk = missing.length === 0;
  const specificityOk = specificityRetention >= minRetention;

  const reasons: string[] = [];
  if (!provenanceOk) {
    reasons.push(`provenance shrank: merged xrefs missing ${missing.length} ref(s) (e.g. ${missing[0]})`);
  }
  if (!specificityOk) {
    reasons.push(
      `specificity retention ${specificityRetention.toFixed(2)} < ${minRetention} (merge genericized/shortened)`,
    );
  }

  return {
    passed: provenanceOk && specificityOk,
    provenanceBefore: required.size,
    provenanceAfter: after.size,
    specificityRetention,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

/**
 * Compute the bigram n-gram diversity of a text string.
 * Returns a value in [0, 1] where 0 = all identical bigrams, 1 = all unique.
 * Used by the lexical-diversity check to detect correlated-extraction artifacts.
 */
export function computeBigramDiversity(text: string): number {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length < 2) return 1; // too short to have bigrams; treat as diverse

  const total = words.length - 1;
  const unique = new Set<string>();
  for (let i = 0; i < total; i++) {
    unique.add(`${words[i]}\t${words[i + 1]}`);
  }
  return unique.size / total;
}

/**
 * Check whether a cluster of memories exhibits suspiciously low lexical diversity.
 * When true, the cluster is likely a correlated-extraction artifact; the merge
 * threshold should be raised.
 *
 * @param bodies - The stripped body texts of the cluster members.
 * @param config - Anti-collapse config.
 * @returns `{ lowDiversity: true, diversity }` when the cluster diversity is
 *   below the 0.3 threshold; `{ lowDiversity: false }` otherwise.
 */
export function checkLexicalDiversity(
  bodies: string[],
  config: AntiCollapseConfig,
): { lowDiversity: boolean; diversity?: number } {
  // R5: default ON — only an explicit opt-out disables the check.
  if (config.enabled === false || config.lexicalDiversityCheck === false) {
    return { lowDiversity: false };
  }
  if (bodies.length === 0) return { lowDiversity: false };

  // Average bigram diversity across all bodies in the cluster.
  const avg = bodies.reduce((sum, b) => sum + computeBigramDiversity(b), 0) / bodies.length;
  const DIVERSITY_FLOOR = 0.3;
  if (avg < DIVERSITY_FLOOR) {
    return { lowDiversity: true, diversity: avg };
  }
  return { lowDiversity: false };
}
