// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 0 — Intake + homeostatic tier.
 *
 * Sub-features (0b is default-ON for extract since R3; the rest default-OFF):
 *
 * (The former **0a homeostatic demotion** pass was removed (R4,
 * docs/design/improve-self-learning-analysis.md G3): it was default-off and
 * self-undoing — the next `upsertAssetSalience` recompute unconditionally
 * overwrote the demoted values. SHY-style continuous downscaling now lives in
 * `computeSalience`'s always-applied recency decay, whose 0.1 floor itself
 * decays on a long half-life so unreviewed-forever assets keep drifting down.)
 *
 * **0b Schema-similarity gate**
 *   At intake, if a new candidate's body embedding is within ε of an existing
 *   derived-layer lesson/knowledge node, mark `schema-consistent` and lower
 *   its priority; only schema-inconsistent/contradicting candidates get full
 *   `encodingSalience`. One embedding lookup via body_embeddings cache; relieves
 *   dedup pressure before it accumulates.
 *
 * **0c Hot-probation intake buffer (#604)**
 *   New system-generated extractions enter `captureMode: hot-probation` and
 *   spend ONE consolidation cycle in probation before promotion to the main
 *   stash; dedup + quality second-pass runs against them. Stops noisy
 *   extractions from polluting the stash at the source. Reuses shared
 *   dedupHash + body_embeddings. Default OFF.
 *
 * **Anti-collapse guards (step 8)**
 *   (a) Generation counter: merged.generation = max(sources)+1; refuse merge
 *       of two assets both above generation N (default 2); merges cite sources.
 *   (b) Lexical-diversity check: low n-gram diversity ⇒ raise merge threshold.
 *   (c) Occasional random non-similar cluster in the pool.
 *
 * **CLS interleaving (step 9)**
 *   distill/memoryInference prompts include embedding-retrieved adjacent
 *   lessons/knowledge so the pipeline doesn't overwrite prior generalizations.
 *
 * **Distill→source fidelity (step 10)**
 *   After a distill proposal, check it against cited source memories; a
 *   contradiction flag routes to human review.
 *
 * @module homeostatic
 */

import { warn } from "../../core/warn";
import { closeDatabase, openExistingDatabase } from "../../indexer/db/db";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default epsilon for schema-similarity gate (looser than dedup's 0.97). */
export const DEFAULT_SCHEMA_SIMILARITY_EPSILON = 0.85;

/** Default multiplicative confidence penalty applied to schema-consistent candidates. */
export const DEFAULT_SCHEMA_CONFIDENCE_PENALTY = 0.5;

/** Default max generation depth before merge is refused. */
export const DEFAULT_MAX_GENERATION = 2;

/** Default fraction of pool to fill with random (non-similar) clusters. */
export const DEFAULT_RANDOM_CLUSTER_FRACTION = 0.05;

/** Default number of adjacent lessons/knowledge for CLS interleaving. */
export const DEFAULT_CLS_ADJACENT_COUNT = 3;

// ── Schema-similarity gate (step 0b) ─────────────────────────────────────────

export interface SchemaSimilarityConfig {
  enabled?: boolean;
  epsilon?: number;
  /** Multiplicative factor applied to candidate confidence when schema-consistent. Default 0.5. */
  confidencePenalty?: number;
}

/**
 * Check whether a candidate body embedding is schema-consistent with an existing
 * derived-layer lesson/knowledge node. Returns `true` when the candidate is
 * within ε of ANY existing derived node (i.e. it's likely covering ground the
 * derived layer already knows about, so give it lower priority).
 *
 * One embedding lookup via the body_embeddings cache; no LLM call.
 * Fails open: returns `false` (not schema-consistent) on any error so the
 * candidate is not silently dropped.
 *
 * @param candidateEmbedding - Float32 embedding vector for the candidate body.
 * @param existingDerivedEmbeddings - Pre-loaded embeddings for existing derived assets.
 * @param config - Schema-similarity gate config.
 */
export function isSchemaConsistent(
  candidateEmbedding: number[],
  existingDerivedEmbeddings: Array<{ ref: string; embedding: number[] }>,
  config: SchemaSimilarityConfig,
): { consistent: boolean; matchedRef?: string; similarity?: number } {
  if (!config.enabled || existingDerivedEmbeddings.length === 0) {
    return { consistent: false };
  }

  const epsilon = config.epsilon ?? DEFAULT_SCHEMA_SIMILARITY_EPSILON;

  let bestSim = -Infinity;
  let bestRef: string | undefined;

  for (const { ref, embedding } of existingDerivedEmbeddings) {
    // cosine similarity: dot(a,b) / (|a| * |b|)
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < candidateEmbedding.length; i++) {
      const a = candidateEmbedding[i] ?? 0;
      const b = embedding[i] ?? 0;
      dot += a * b;
      magA += a * a;
      magB += b * b;
    }
    const sim = magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
    if (sim > bestSim) {
      bestSim = sim;
      bestRef = ref;
    }
  }

  if (bestSim >= epsilon) {
    return { consistent: true, matchedRef: bestRef, similarity: bestSim };
  }
  return { consistent: false };
}

/**
 * WS-3b Step-0b: apply the schema-similarity intake gate to one extract
 * candidate. Pure/deterministic given `embedText`, so it is directly unit
 * testable without the full extract→LLM harness.
 *
 * Returns the (possibly penalised) effective confidence plus a `penalised` flag
 * and an optional human-readable `warning`. Parity guarantees:
 *  - `ctx === null` (gate disabled / default-off)  → no change, never embeds.
 *  - empty `derivedEmbeddings`                      → no change, never embeds.
 *  - candidate type not lesson/knowledge            → no change, never embeds.
 *  - embed throws                                   → fail open (no change), warns.
 */
export async function applySchemaSimilarityPenalty(
  candidate: { type: string; name: string; body: string; confidence?: number },
  ctx: { config: SchemaSimilarityConfig; derivedEmbeddings: Array<{ ref: string; embedding: number[] }> } | null,
  embedText: (text: string) => Promise<number[]>,
): Promise<{ effectiveConfidence: number | undefined; penalised: boolean; warning?: string }> {
  const baseConfidence = typeof candidate.confidence === "number" ? candidate.confidence : undefined;
  if (ctx === null || ctx.derivedEmbeddings.length === 0) {
    return { effectiveConfidence: baseConfidence, penalised: false };
  }
  if (candidate.type !== "lesson" && candidate.type !== "knowledge") {
    return { effectiveConfidence: baseConfidence, penalised: false };
  }
  try {
    const candidateVec = await embedText(candidate.body);
    const check = isSchemaConsistent(candidateVec, ctx.derivedEmbeddings, ctx.config);
    if (check.consistent) {
      const penalty = ctx.config.confidencePenalty ?? DEFAULT_SCHEMA_CONFIDENCE_PENALTY;
      return {
        effectiveConfidence: (baseConfidence ?? 1.0) * penalty,
        penalised: true,
        warning:
          `[extract] schema-consistent candidate ${candidate.type}:${candidate.name} ` +
          `(sim=${check.similarity?.toFixed(3)} vs ${check.matchedRef}) — confidence penalised ×${penalty}`,
      };
    }
    return { effectiveConfidence: baseConfidence, penalised: false };
  } catch (embedErr) {
    // Fail open: embed errors must never abort extraction.
    return {
      effectiveConfidence: baseConfidence,
      penalised: false,
      warning:
        `[extract] schema-similarity embed failed for ${candidate.type}:${candidate.name} — skipping gate: ` +
        (embedErr instanceof Error ? embedErr.message : String(embedErr)),
    };
  }
}

/**
 * Load persisted body embeddings for all indexed **derived-layer**
 * (lesson + knowledge) entries from index.db. Returns an empty array when
 * the DB is unavailable, empty, or the embeddings table has no entries for
 * those types — the caller treats an empty array as "gate inactive".
 *
 * FAIL-OPEN: any error emits a debug warning and returns an empty array.
 * This ensures the extract pass never fails because of a missing index.
 *
 * The returned entries are keyed by `entry_key` (e.g. "lesson:foo",
 * "knowledge:bar"). Only entries whose embedding dimension matches the first
 * observed dimension are included (mixed-dim BLOBs are silently skipped).
 *
 * @param dbPath - Optional path override for index.db (for testing).
 */
export function loadDerivedLayerEmbeddings(dbPath?: string): Array<{ ref: string; embedding: number[] }> {
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase(dbPath);
    const rows = db
      .prepare(
        `SELECT e.entry_key, emb.embedding
         FROM entries e
         JOIN embeddings emb ON emb.id = e.id
         WHERE e.entry_type IN ('lesson', 'knowledge')`,
      )
      .all() as Array<{ entry_key: string; embedding: Buffer }>;

    if (rows.length === 0) return [];

    let expectedDim: number | undefined;
    const result: Array<{ ref: string; embedding: number[] }> = [];
    for (const row of rows) {
      const buf = row.embedding;
      if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) continue;
      const dim = buf.byteLength / 4;
      if (expectedDim === undefined) expectedDim = dim;
      if (dim !== expectedDim) continue;

      const aligned = new ArrayBuffer(buf.byteLength);
      new Uint8Array(aligned).set(buf);
      const f32 = new Float32Array(aligned);
      result.push({ ref: row.entry_key, embedding: Array.from(f32) });
    }
    return result;
  } catch (err) {
    warn(
      "[homeostatic] loadDerivedLayerEmbeddings: failed to load from index.db — gate inactive:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        // ignore close errors
      }
    }
  }
}

// ── Anti-collapse guards (step 8) ─────────────────────────────────────────────

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
  /** Provenance: |required union| before vs. |merged source_refs| after. */
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
 *  1. Provenance: the merged asset's `source_refs` must be a superset of the
 *     union of all participants' `source_refs` plus the participant refs
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
  const specificityRetention = sourceTokens.size === 0 ? 1 : mergedTokens.size / sourceTokens.size;

  const minRetention = config.minSpecificityRetention ?? DEFAULT_MIN_SPECIFICITY_RETENTION;
  const provenanceOk = missing.length === 0;
  const specificityOk = specificityRetention >= minRetention;

  const reasons: string[] = [];
  if (!provenanceOk) {
    reasons.push(`provenance shrank: merged source_refs missing ${missing.length} ref(s) (e.g. ${missing[0]})`);
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
    specificityRetention: Math.min(1, specificityRetention),
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

// ── CLS adjacent lesson context (step 9) ─────────────────────────────────────

export interface ClsConfig {
  enabled?: boolean;
  adjacentCount?: number;
}

/**
 * Build a CLS (Complementary Learning System) context snippet for injection
 * into distill/memoryInference prompts.
 *
 * Given a list of embedding-retrieved adjacent lessons/knowledge, formats them
 * as a markdown section to append to the prompt so the LLM avoids overwriting
 * prior generalizations.
 *
 * Returns an empty string when CLS is disabled or no adjacent items are found.
 *
 * @param adjacentItems - Top-N adjacent lessons/knowledge retrieved by embedding.
 * @param config - CLS config.
 */
export function buildClsContext(adjacentItems: Array<{ ref: string; content: string }>, config: ClsConfig): string {
  if (!config.enabled || adjacentItems.length === 0) return "";

  const lines = [
    "",
    "## Existing adjacent lessons / knowledge (CLS context)",
    "The following are semantically related entries already in the stash.",
    "Your proposal MUST NOT contradict or silently overwrite these — if you",
    "disagree with one, flag it as contradicted (do not ignore it).",
    "",
  ];

  for (const item of adjacentItems) {
    lines.push(`### ${item.ref}`);
    // Truncate to 400 chars to keep the prompt size reasonable.
    lines.push(item.content.trim().slice(0, 400));
    lines.push("");
  }

  return lines.join("\n");
}

// ── Distill→source fidelity check (step 10) ──────────────────────────────────

export interface FidelityCheckConfig {
  enabled?: boolean;
}

export interface FidelityCheckResult {
  /** Whether a contradiction was detected between the proposal and its sources. */
  contradictionDetected: boolean;
  /** Human-readable reason for the contradiction flag, if any. */
  reason?: string;
}

/**
 * Check a distill proposal against its cited source memories for contradictions.
 *
 * Uses a simple heuristic: looks for explicit negation of key claims in the
 * proposal body that appear in the source bodies. A full LLM-based
 * contradiction check is expensive (one LLM call per proposal); this cheap
 * heuristic catches the most obvious cases and flags them for human review.
 *
 * When `fidelityCheck.enabled` is false, returns `{ contradictionDetected: false }`
 * immediately (no work done).
 *
 * @param proposalBody - The stripped body of the distill proposal.
 * @param sourceBodies - The stripped bodies of the cited source memories.
 * @param config - Fidelity check config.
 */
export function checkDistillFidelity(
  proposalBody: string,
  sourceBodies: string[],
  config: FidelityCheckConfig,
): FidelityCheckResult {
  if (!config.enabled || sourceBodies.length === 0) {
    return { contradictionDetected: false };
  }

  // Heuristic: detect explicit negation of "never" / "always" / "must" claims.
  // A proposal that says "always X" while the source says "never X" (or vice
  // versa) is a clear contradiction worth flagging.
  //
  // This is intentionally conservative: it only flags when both the proposal
  // AND the source contain the opposing polarity of the same key term. False
  // negatives (missed contradictions) are preferred over false positives
  // (blocking valid proposals) since the consequence of a false positive is
  // a human review request, while the cost of a false negative is a slightly
  // degraded stash.

  const proposalLow = proposalBody.toLowerCase();

  // Extract "always/never/must/must not" claims from the proposal.
  const strongClaims = extractStrongClaims(proposalLow);
  if (strongClaims.length === 0) return { contradictionDetected: false };

  for (const sourceBody of sourceBodies) {
    const sourceLow = sourceBody.toLowerCase();
    for (const { polarity, term } of strongClaims) {
      const oppositePolarity = polarity === "positive" ? "negative" : "positive";
      const sourceHasOpposite = hasStrongClaim(sourceLow, term, oppositePolarity);
      if (sourceHasOpposite) {
        return {
          contradictionDetected: true,
          reason: `Proposal makes a ${polarity} strong claim about "${term}" that conflicts with an opposing claim in a cited source. Route to human review.`,
        };
      }
    }
  }

  // Also flag proposals whose source_refs are empty (broken provenance).
  // This is a degradation signal, not a contradiction, but worth surfacing.
  return { contradictionDetected: false };
}

interface StrongClaim {
  polarity: "positive" | "negative";
  term: string;
}

function extractStrongClaims(text: string): StrongClaim[] {
  const claims: StrongClaim[] = [];
  // Match "always <term>", "never <term>", "must <term>", "must not <term>".
  const patterns: Array<{ polarity: "positive" | "negative"; re: RegExp }> = [
    { polarity: "positive", re: /\b(?:always|must)\s+(\w+)/g },
    { polarity: "negative", re: /\b(?:never|must\s+not|should\s+not)\s+(\w+)/g },
  ];
  for (const { polarity, re } of patterns) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      const term = m[1];
      if (term && term.length > 2) claims.push({ polarity, term });
      m = re.exec(text);
    }
  }
  return claims;
}

function hasStrongClaim(text: string, term: string, polarity: "positive" | "negative"): boolean {
  if (polarity === "positive") {
    return /\b(?:always|must)\s/.test(text) && text.includes(term);
  }
  return /\b(?:never|must\s+not|should\s+not)\s/.test(text) && text.includes(term);
}

// ── captureMode: hot-probation helpers ───────────────────────────────────────

/**
 * captureMode value for system-generated extractions in probation.
 * Automatic counterpart to the user-explicit `captureMode: hot`.
 */
export const CAPTURE_MODE_HOT_PROBATION = "hot-probation" as const;

/**
 * Returns true when an asset is in hot-probation (system-generated, not yet
 * graduated from the intake dedup+quality pass).
 */
export function isHotProbation(captureModeValue: unknown): boolean {
  return captureModeValue === CAPTURE_MODE_HOT_PROBATION;
}

/**
 * Returns true when an asset should be skipped by the consolidation LLM
 * because it's still in hot-probation (hasn't completed the intake pass yet).
 *
 * Hot-probation assets are processed by the consolidation dedup pre-pass
 * (runDeterministicDedup) but excluded from the LLM merge clustering, so
 * noisy extractions can't pollute the LLM context.
 */
export function shouldSkipHotProbationInLlm(frontmatterData: Record<string, unknown>): boolean {
  return isHotProbation(frontmatterData.captureMode);
}

/**
 * Build frontmatter fields to inject when creating a hot-probation proposal.
 * The proposal will carry `captureMode: hot-probation` so downstream logic
 * knows to run the intake dedup pass before graduating it.
 */
export function buildHotProbationFrontmatter(): { captureMode: typeof CAPTURE_MODE_HOT_PROBATION } {
  return { captureMode: CAPTURE_MODE_HOT_PROBATION };
}
