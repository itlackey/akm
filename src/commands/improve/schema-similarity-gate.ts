// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 0b — Schema-similarity intake gate.
 *
 * At intake, if a new candidate's body embedding is within ε of an existing
 * derived-layer lesson/knowledge node, mark `schema-consistent` and lower its
 * priority; only schema-inconsistent/contradicting candidates get full
 * `encodingSalience`. One embedding lookup via body_embeddings cache; relieves
 * dedup pressure before it accumulates.
 *
 * @module schema-similarity-gate
 */

import { warn } from "../../core/warn";
import { closeDatabase, openExistingDatabase } from "../../indexer/db/db";

/** Default epsilon for schema-similarity gate (looser than dedup's 0.97). */
export const DEFAULT_SCHEMA_SIMILARITY_EPSILON = 0.85;

/** Default multiplicative confidence penalty applied to schema-consistent candidates. */
export const DEFAULT_SCHEMA_CONFIDENCE_PENALTY = 0.5;

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
      "[schema-similarity-gate] loadDerivedLayerEmbeddings: failed to load from index.db — gate inactive:",
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
