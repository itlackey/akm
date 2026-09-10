// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single embedding materializer for full index runs and targeted writes.
 *
 * A full run omits `entryIds` and heals every missing vector. A targeted write
 * supplies the canonical entry IDs it just changed, so the command does not
 * return successfully with lexical state newer than semantic state. Provider
 * changes deliberately widen a targeted call to all entries because every
 * stored vector becomes incompatible at that boundary.
 */

import type { AkmConfig, EmbeddingConnectionConfig } from "../core/config/config";
import { getConfigPath } from "../core/paths";
import { isVerbose, warn, warnVerbose } from "../core/warn";
import { embedBatch } from "../llm/embedder";
import { DETERMINISTIC_EMBED_MODEL_ID, isDeterministicEmbedEnabled } from "../llm/embedders/deterministic";
import { DEFAULT_LOCAL_MODEL } from "../llm/embedders/local";
import {
  buildTokenBoundedBatches,
  capEmbeddingText,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_REMOTE_BATCH_SIZE,
  DEFAULT_TOKEN_BUDGET,
  describeEmbeddingCredential,
  type EmbeddingBatchCommit,
  type EmbeddingBatchSkip,
  type EmbeddingSkipHandler,
  estimateTokenCount,
  hasRemoteEndpoint,
  normalizeEmbeddingEndpoint,
} from "../llm/embedders/remote";
import { cosineSimilarity, type EmbeddingVector } from "../llm/embedders/types";
import type { Database } from "../storage/database";
import {
  purgeEmbeddingSalvage,
  relabelEmbeddingSalvageFingerprint,
  reuseSalvagedEmbeddings,
} from "../storage/repositories/embedding-salvage-repository";
import { getEmbeddableEntryCount } from "../storage/repositories/index-entries-repository";
import { deleteMeta, getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import {
  type EmbeddingCanarySample,
  getAllEntriesForEmbedding,
  getEmbeddingCount,
  isVecFastPathComplete,
  isVecFastPathReady,
  purgeEmbeddings,
  sampleEmbeddedEntriesForCanary,
  setVecFastPathReady,
  upsertEmbedding,
} from "../storage/repositories/index-vec-repository";

/** Identifies the embedding provider+model+dimension a stored vector was generated with. */
export function deriveSemanticProviderFingerprint(embedding?: EmbeddingConnectionConfig): string {
  if (isDeterministicEmbedEnabled()) {
    return `deterministic:${DETERMINISTIC_EMBED_MODEL_ID}`;
  }
  if (embedding?.endpoint) {
    // Fingerprint keys on vector identity only (model + dimension). The endpoint
    // is transport/routing and has no bearing on vector compatibility, so moving
    // the same model+dimension to a different host must not force a full re-embed.
    return `remote:${embedding.model}|${embedding.dimension ?? "default"}`;
  }
  return `local:${embedding?.localModel ?? DEFAULT_LOCAL_MODEL}`;
}

export interface EmbeddingProgressEvent {
  phase: "embeddings";
  message: string;
}

export interface EmbeddingGenerationResult {
  success: boolean;
  message?: string;
  /** Number of sqlite-vec writes that degraded to the complete BLOB fallback. */
  vecInsertFailures?: number;
}

export interface GenerateEmbeddingsOptions {
  /**
   * Force a full purge + re-embed (`akm index --reembed`), bypassing the
   * fingerprint-rename canary entirely — an explicit operator override for
   * when the canary's own verdict should not be trusted (#955).
   */
  forceReembed?: boolean;
}

/**
 * The heartbeat text emitted every 15s while a provider request is in
 * flight, and by default (not `--verbose`-only) since silence indistinguishable
 * from a hang was the field report's own symptom (#954).
 */
export function formatEmbeddingHeartbeat(storedCount: number, total: number, failedCount: number): string {
  return `Still generating embeddings: ${storedCount}/${total} stored, ${failedCount} failed; waiting on embedding provider.`;
}

/**
 * Number of already-embedded entries sampled for the fingerprint-rename
 * canary (#955) — small and cheap even against a slow local server; a
 * handful of chunks is a strong compatibility signal (a different model
 * cannot plausibly land near-identical vectors by chance).
 */
const CANARY_SAMPLE_SIZE = 8;

/**
 * Minimum median cosine similarity between stored and freshly re-embedded
 * canary vectors for a fingerprint-string change to be treated as a
 * same-model rename rather than a real model change (#955).
 */
const CANARY_SIMILARITY_THRESHOLD = 0.999;

/**
 * Consecutive transport failures after which the embedding pass stops
 * dispatching further requests and ends the run as a failure rather than
 * grinding through every remaining batch against a dead endpoint (#954).
 * Two independent trip conditions
 * share this threshold — see `onSkip` below: 3 consecutive failures at
 * single-document size (timeout OR network error — a multi-document
 * timeout is not by itself evidence the endpoint is dead, since
 * `RemoteEmbedder.embedBatch` already retries and splits it smaller before
 * ever reporting it as failed at single-document size), or 3 consecutive
 * network errors at ANY size (a network error is never retried, so it is
 * trusted immediately regardless of how large the request was).
 * `context-window-exceeded` never counts — that reason proves the provider
 * IS reachable, and split-and-retry already handles it; it resets both
 * streaks instead.
 */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/** One (stored vector, freshly re-embedded vector) pair for the canary decision. */
export interface EmbeddingCanaryPair {
  stored: EmbeddingVector;
  /** Undefined when the canary re-embed failed or skipped this specific sample. */
  fresh: EmbeddingVector | undefined;
}

/** The single similarity computation behind the canary verdict (#955/#956). */
export interface EmbeddingCompatibilityDecision {
  outcome: "keep" | "rebuild" | "unverifiable";
  /** Median cosine similarity across the VERIFIED samples. Undefined when none could be computed. */
  medianSimilarity: number | undefined;
  /** Count of samples whose re-embed actually succeeded (`fresh !== undefined`). */
  verifiedSamples: number;
}

/**
 * Pure decision: do stored vectors remain valid against freshly re-embedded
 * canary samples? The ONE place that computes the canary's similarity
 * numbers — callers must use this result rather than recomputing it (#955).
 *
 * An empty sample means nothing is stored to lose or verify against, so
 * there is nothing to decide — keep.
 *
 * A sample whose re-embed FAILED (`fresh === undefined`, e.g. a provider
 * sub-batch that was skipped) is EXCLUDED from the similarity computation
 * entirely, not scored as zero: a partial provider failure is not evidence
 * of a different model (#955). A dimension mismatch on a successful
 * re-embed still counts as zero similarity via {@link cosineSimilarity}'s
 * own dimension-mismatch guard — that IS evidence. When half or fewer of
 * the sampled entries re-embedded successfully, the sample is too thin to
 * trust either verdict — the outcome is `unverifiable`, the same outcome a
 * total canary failure already produces.
 *
 * Otherwise the MEDIAN pairwise cosine similarity of the verified samples
 * must clear {@link CANARY_SIMILARITY_THRESHOLD}; the median (not the
 * minimum or mean) tolerates one stale or lightly-edited sample without
 * either discarding a real match or being fooled by it.
 */
export function decideEmbeddingCompatibility(pairs: readonly EmbeddingCanaryPair[]): EmbeddingCompatibilityDecision {
  if (pairs.length === 0) return { outcome: "keep", medianSimilarity: undefined, verifiedSamples: 0 };

  const verified = pairs.filter(
    (pair): pair is { stored: EmbeddingVector; fresh: EmbeddingVector } => pair.fresh !== undefined,
  );
  if (verified.length * 2 <= pairs.length) {
    return { outcome: "unverifiable", medianSimilarity: undefined, verifiedSamples: verified.length };
  }

  const similarities = verified.map((pair) => cosineSimilarity(pair.stored, pair.fresh));
  const medianSimilarity = medianOf(similarities);
  return {
    outcome: medianSimilarity >= CANARY_SIMILARITY_THRESHOLD ? "keep" : "rebuild",
    medianSimilarity,
    verifiedSamples: verified.length,
  };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Identity of the embedding vectors actually observed on a run — as opposed
 * to {@link deriveSemanticProviderFingerprint}'s CONFIG-derived string. Keys
 * on what the server (or local model) actually reported plus the observed
 * vector width, so a gateway/transport change that keeps returning the same
 * underlying model can be told apart from a genuine model change without
 * relying on the operator's config string (#955).
 * Returns undefined when nothing was actually observed this call (no vector
 * to measure yet).
 */
function deriveObservedEmbeddingIdentity(
  embedding: EmbeddingConnectionConfig | undefined,
  observedModel: string | undefined,
  observedVectorLen: number | undefined,
): string | undefined {
  if (isDeterministicEmbedEnabled()) {
    return `deterministic:${DETERMINISTIC_EMBED_MODEL_ID}`;
  }
  if (observedVectorLen === undefined) return undefined;
  if (embedding?.endpoint) {
    return `remote:${observedModel ?? embedding.model ?? "unknown"}|${observedVectorLen}`;
  }
  return `local:${embedding?.localModel ?? DEFAULT_LOCAL_MODEL}|${observedVectorLen}`;
}

type CanaryDecision =
  | {
      outcome: "keep";
      /** False for the empty-sample case: nothing was actually verified. */
      verified: boolean;
      identity?: string;
      viaIdentityMatch: boolean;
      medianSimilarity?: number;
    }
  | { outcome: "rebuild"; identity?: string; reason: string }
  | { outcome: "unverifiable"; message: string };

/**
 * Run the fingerprint-rename canary: re-embed a small sample of already-
 * stored entries with the CURRENT config and decide whether the stored
 * index survives. Goes through the standard {@link embedBatch} facade (not a
 * direct `RemoteEmbedder`) so every embedder branch — remote, local,
 * deterministic, and test overrides via `_setEmbedderForTests` — is
 * exercised identically to the main embedding pass.
 *
 * `maxInputTokens` must be the SAME cap the main pass below applies via
 * {@link capEmbeddingText} — the stored vector for each sampled entry was
 * produced from its capped text, so comparing against a fresh vector of the
 * uncapped text would compare unlike inputs for any entry over the cap
 * (#955).
 */
async function runEmbeddingCanary(
  db: Database,
  config: AkmConfig,
  signal: AbortSignal | undefined,
  maxInputTokens: number,
): Promise<CanaryDecision> {
  const samples: EmbeddingCanarySample[] = sampleEmbeddedEntriesForCanary(db, CANARY_SAMPLE_SIZE);
  if (samples.length === 0) {
    return { outcome: "keep", verified: false, viaIdentityMatch: false };
  }

  let observedModel: string | undefined;
  const skips: EmbeddingBatchSkip[] = [];
  let canaryVectors: (EmbeddingVector | undefined)[];
  try {
    canaryVectors = await embedBatch(
      // #955: the stored vector for each sample was produced from
      // capEmbeddingText(searchText, maxInputTokens) — the main pass below
      // caps every document before embedding it. The canary must re-embed
      // the SAME capped text, or an entry over the cap compares a fresh
      // vector of a different input against a stored vector of the capped
      // one, and a genuine model match can read as a rebuild-worthy
      // mismatch for reasons unrelated to the model.
      samples.map((sample) => capEmbeddingText(sample.searchText, maxInputTokens).text),
      config.embedding,
      signal,
      (skip) => skips.push(skip),
      (_indices, _embeddings, model) => {
        if (model) observedModel = model;
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "unverifiable",
      message: `could not verify embedding compatibility (${message}); keeping existing vectors — rerun akm index when the endpoint is reachable`,
    };
  }

  const observedVectorLen = canaryVectors.find((vector): vector is EmbeddingVector => vector !== undefined)?.length;
  const observedIdentity = deriveObservedEmbeddingIdentity(config.embedding, observedModel, observedVectorLen);
  const storedIdentity = getMeta(db, "embeddingIdentity");

  if (storedIdentity && observedIdentity && storedIdentity === observedIdentity) {
    // The server reports the same model identity as last time — no need to
    // even look at the cosines; the config string alone was misleading.
    return { outcome: "keep", verified: true, identity: observedIdentity, viaIdentityMatch: true };
  }

  const pairs: EmbeddingCanaryPair[] = samples.map((sample, i) => ({ stored: sample.vector, fresh: canaryVectors[i] }));
  const decision = decideEmbeddingCompatibility(pairs);

  if (decision.outcome === "unverifiable") {
    // Covers both a total provider failure (RemoteEmbedder skips a failing
    // request rather than throwing, #874, so an unreachable endpoint
    // surfaces here as an all-`undefined` canary result, not a caught
    // exception) and a partial one thin enough that neither verdict can be
    // trusted (#955) — same message path either way.
    const message = skips[0]?.message ?? "embedding provider returned no vectors for the canary sample";
    return {
      outcome: "unverifiable",
      message: `could not verify embedding compatibility (${message}); keeping existing vectors — rerun akm index when the endpoint is reachable`,
    };
  }

  if (decision.outcome === "keep") {
    return {
      outcome: "keep",
      verified: true,
      identity: observedIdentity,
      viaIdentityMatch: false,
      medianSimilarity: decision.medianSimilarity,
    };
  }
  return {
    outcome: "rebuild",
    identity: observedIdentity,
    reason: `vectors differ (median similarity ${decision.medianSimilarity?.toFixed(3)})`,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("index interrupted");
  }
}

export async function generateEmbeddingsForDb(
  db: Database,
  config: AkmConfig,
  onProgress: (event: EmbeddingProgressEvent) => void,
  signal?: AbortSignal,
  entryIds?: readonly number[],
  opts?: GenerateEmbeddingsOptions,
): Promise<EmbeddingGenerationResult> {
  // Drift guard (#954): refuse an ambient transaction. Every
  // per-batch `db.transaction()` below is meant to be its own durable commit
  // (#954) — inside an already-open outer transaction it would nest as an
  // unobservable SAVEPOINT instead, so an interruption (competing-process
  // collision, SIGKILL) could lose the whole pass rather than only the batch
  // in flight. This is an internal contract error (a caller bug), not a
  // user-facing failure class: callers with their own transaction (e.g. `akm
  // bundle update`'s unified update transaction) must run the embedding
  // phase on a separate connection AFTER their own transaction commits — see
  // `runEmbeddingPass` in `src/indexer/indexer.ts`.
  if (db.inTransaction) {
    throw new Error(
      "generateEmbeddingsForDb was called with an ambient transaction already open on `db`: per-batch commits " +
        "would become SAVEPOINTs inside it, losing the crash-durability contract per-batch commit exists for. " +
        "Run the embedding phase on a connection with no open transaction.",
    );
  }
  throwIfAborted(signal);

  if (config.semanticSearchMode === "off") {
    // #955: salvage is self-emptying only if every path that skips reuse
    // also drains it — otherwise a full rebuild performed with semantic
    // search disabled leaves permanent orphaned rows behind (nothing will
    // ever consume them, since this path never reaches the reuse step).
    purgeEmbeddingSalvage(db);
    onProgress({ phase: "embeddings", message: "Semantic search disabled; skipping embeddings." });
    return { success: false, message: "Semantic search is disabled." };
  }

  // #953 field gap: the actionable outcome is a self-diagnosing run, not a
  // fix (every RemoteEmbedder path already resolves secret:// through one
  // boundary — a keyless request can only mean embedding.apiKey was absent
  // from the config THIS run loaded). One default-level line, before the
  // first provider request of the phase (the canary probe or the main
  // pass, whichever runs first below), naming the endpoint/model/credential
  // SOURCE — never the credential value.
  if (hasRemoteEndpoint(config.embedding ?? {})) {
    const endpoint = normalizeEmbeddingEndpoint(config.embedding?.endpoint ?? "");
    const credential = describeEmbeddingCredential(config.embedding?.apiKey);
    const configFileSuffix = isVerbose() ? `; config: ${getConfigPath()}` : "";
    onProgress({
      phase: "embeddings",
      message: `[embed] endpoint ${endpoint}, model ${config.embedding?.model ?? "unknown"}; credential: ${credential}${configFileSuffix}`,
    });
  }

  // A targeted call starts from an already-published generation. Preserve its
  // trust decision in O(1): successful writes for the changed IDs keep a
  // healthy fast path healthy, but can never promote a generation already
  // marked degraded. Global runs can afford to verify the entire derived set.
  const vecFastPathWasReady = isVecFastPathReady(db);
  const currentFingerprint = deriveSemanticProviderFingerprint(config.embedding);
  const storedFingerprint = getMeta(db, "embeddingFingerprint");
  let targetEntryIds = entryIds;
  /** Set only on an actual rebuild, so the up-front "Re-embedding N entries" line names why. */
  let rebuildReason: string | undefined;
  // Resolved once and reused by both the canary (below) and the main pass's
  // cap loop (further down) — the same cap must apply to both, or the canary
  // compares a differently-capped text against the stored vector (#955).
  const maxInputTokens = config.embedding?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;

  if (opts?.forceReembed) {
    // `akm index --reembed`: an explicit operator override, skips the canary
    // entirely. The new fingerprint (and identity, now stale/unknown until
    // the next successful pass observes it) is written in the SAME
    // transaction as the purge, before any embedding request — a restart
    // then sees a matching fingerprint and only heals what is still missing
    // instead of purging again from zero (#955/#956).
    db.transaction(() => {
      purgeEmbeddings(db, { dropVecTable: true });
      // #955: an explicit forced rebuild must re-embed everything, not
      // quietly satisfy some of it from stale salvage.
      purgeEmbeddingSalvage(db);
      deleteMeta(db, "embeddingDim");
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      deleteMeta(db, "embeddingIdentity");
    })();
    targetEntryIds = undefined;
    rebuildReason = "forced by --reembed";
  } else if (storedFingerprint && storedFingerprint !== currentFingerprint) {
    const decision = await runEmbeddingCanary(db, config, signal, maxInputTokens);

    if (decision.outcome === "unverifiable") {
      // Destroying a good index because the server happens to be down right
      // now is worse than leaving a rename unverified until the next run —
      // keep the vectors AND the old fingerprint so the next `akm index`
      // retries the canary instead of silently treating this as resolved.
      warn(`[embed] ${decision.message}`);
      onProgress({ phase: "embeddings", message: decision.message });
      return { success: false, message: decision.message };
    }

    if (decision.outcome === "rebuild") {
      db.transaction(() => {
        purgeEmbeddings(db, { dropVecTable: true });
        // #955: the stored vectors AND any leftover salvage both belong to
        // a different model now — neither is reusable, so both go.
        purgeEmbeddingSalvage(db);
        deleteMeta(db, "embeddingDim");
        setMeta(db, "embeddingFingerprint", currentFingerprint);
        if (decision.identity) setMeta(db, "embeddingIdentity", decision.identity);
        else deleteMeta(db, "embeddingIdentity");
      })();
      targetEntryIds = undefined;
      rebuildReason = decision.reason;
    } else {
      // Keep: adopt the new fingerprint (and identity, when observed)
      // immediately rather than deferring to end-of-run — nothing was
      // purged, so there is nothing an interruption could lose, and an
      // immediate write means a crash right after this decision does not
      // re-run the canary needlessly on the next attempt.
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      // #955: the model did not actually change, only the fingerprint
      // STRING did (e.g. a gateway rename) — any leftover salvage rows
      // tagged with the OLD string are still valid vectors. Relabel them so
      // the reuse step below (and any later pass) can still find them.
      relabelEmbeddingSalvageFingerprint(db, storedFingerprint, currentFingerprint);
      if (decision.identity) setMeta(db, "embeddingIdentity", decision.identity);
      if (decision.verified) {
        const keptCount = getEmbeddingCount(db);
        const detail = decision.viaIdentityMatch
          ? "server-reported model unchanged"
          : `stored vectors are compatible (median similarity ${decision.medianSimilarity?.toFixed(3)})`;
        const message = `[embed] embedding model renamed (${storedFingerprint} → ${currentFingerprint}); ${detail}, keeping ${keptCount} embedding${keptCount === 1 ? "" : "s"}.`;
        warn(message);
        onProgress({ phase: "embeddings", message });
      }
      // Empty-sample case (decision.verified === false): nothing stored to
      // lose or verify against — adopt the label silently, no purge line.
    }
  } else {
    // No rename to verify (either this is the very first
    // pass ever for this db, or the fingerprint already matches the last
    // successful one) — still record it NOW rather than deferring to a
    // fully successful pass, mirroring the rebuild/keep branches above
    // (#955/#956). Without this, an interrupted FIRST-EVER pass left
    // `embeddingFingerprint` unset despite a per-batch commit below (#954)
    // already having durably written real vectors — a later `akm index
    // --full`'s salvage-before-discard step tags rows by this meta
    // (`salvageEmbeddingsBeforeDiscard`) and treats an unset fingerprint as
    // "nothing was ever verified", silently turning genuinely-embedded
    // vectors into a full re-embed instead of a salvage-and-reuse.
    setMeta(db, "embeddingFingerprint", currentFingerprint);
  }

  try {
    throwIfAborted(signal);
    const allEntries = getAllEntriesForEmbedding(db, targetEntryIds);

    let vecFailedCount = 0;
    let vecUnavailableCount = 0;

    // #955: before any provider call, hand back vectors salvaged from a
    // full rebuild or a generation bump for entries whose search_text is
    // byte-identical to what was salvaged under the SAME fingerprint — a
    // fingerprint mismatch or a single-byte content change both correctly
    // fall through to the provider below instead.
    const { reusedCount, remaining: candidateEntries } = reuseSalvagedEmbeddings(
      db,
      allEntries,
      currentFingerprint,
      (entry, embedding) => {
        const result = upsertEmbedding(db, entry.id, embedding);
        if (result.vec === "failed") vecFailedCount++;
        if (result.vec === "unavailable") vecUnavailableCount++;
        return result.stored;
      },
    );
    if (reusedCount > 0) {
      onProgress({
        phase: "embeddings",
        message: `Reused ${reusedCount} embedding${reusedCount === 1 ? "" : "s"} from the previous generation; embedding ${candidateEntries.length} new.`,
      });
    }

    if (candidateEntries.length === 0) {
      onProgress({ phase: "embeddings", message: "Embeddings already up to date." });
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      if (reusedCount > 0) {
        const vecGenerationComplete = targetEntryIds === undefined ? isVecFastPathComplete(db) : vecFastPathWasReady;
        setVecFastPathReady(db, vecFailedCount === 0 && vecUnavailableCount === 0 && vecGenerationComplete);
      }
      // A pass that completes (even one that did nothing but reuse) purges
      // whatever is left — salvage is consumed by the NEXT pass, never kept
      // around as a second cache.
      purgeEmbeddingSalvage(db);
      return reusedCount > 0 ? { success: true, vecInsertFailures: vecFailedCount } : { success: true };
    }

    // Cap each document's embedded text at
    // embedding.maxInputTokens (default DEFAULT_MAX_INPUT_TOKENS, resolved
    // once above so the canary uses the identical cap) instead of ever
    // failing a whole batch over one oversized entry — truncation keeps the
    // head of the text, unicode-safe. A document is skipped only when its
    // head is empty (the impossible case: nothing left to embed), never
    // merely for being long.
    let truncatedCount = 0;
    const texts: string[] = [];
    const pendingEntries: typeof candidateEntries = [];
    for (const entry of candidateEntries) {
      const capped = capEmbeddingText(entry.searchText, maxInputTokens);
      if (capped.text.length === 0) continue;
      if (capped.truncated) truncatedCount++;
      pendingEntries.push(entry);
      texts.push(capped.text);
    }
    if (truncatedCount > 0) {
      // Through onProgress ONLY, not warn() too — onProgress already reaches
      // stderr at the default level in every output mode (#954), and the
      // index CLI's progress handler writes it through info() (log-file
      // aware), so calling warn() as well printed the identical sentence
      // twice in text mode.
      const message = `[embed] ${truncatedCount} entr${truncatedCount === 1 ? "y" : "ies"} truncated to the ${maxInputTokens}-token embedding cap (embedding.maxInputTokens); rerun with a higher cap to embed the full text.`;
      onProgress({ phase: "embeddings", message });
    }

    if (rebuildReason) {
      // See the truncation notice above: onProgress ONLY.
      const message = `[embed] Re-embedding ${pendingEntries.length} entr${pendingEntries.length === 1 ? "y" : "ies"} because ${rebuildReason}`;
      onProgress({ phase: "embeddings", message });
    }
    onProgress({
      phase: "embeddings",
      message: `Generating embeddings for ${pendingEntries.length} entr${pendingEntries.length === 1 ? "y" : "ies"}.`,
    });

    if (isVerbose()) {
      // Mirror RemoteEmbedder's actual token-bounded batching (#874) so this
      // log reflects the real request grouping rather than a fixed count of
      // 100 that no longer matches what gets sent over the wire. Local runs
      // don't batch by size at all (LocalEmbedder chunks by a fixed count
      // for inference throughput only, never fails/skips), so there's
      // nothing meaningful to report per-batch for them.
      if (hasRemoteEndpoint(config.embedding ?? {})) {
        // Mirrors RemoteEmbedder.embedBatch's own tokenBudget resolution
        // (#956: contextLength no longer feeds this).
        const tokenBudget = config.embedding?.maxTokens ?? DEFAULT_TOKEN_BUDGET;
        const maxCount = config.embedding?.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
        const batches = buildTokenBoundedBatches(texts, tokenBudget, maxCount);
        const batchNumberByIndex = new Map<number, number>();
        batches.forEach((batch, batchIdx) => {
          for (const i of batch.indices) batchNumberByIndex.set(i, batchIdx + 1);
        });
        for (const [i, entry] of pendingEntries.entries()) {
          const chars = entry.searchText.length;
          const tokens = estimateTokenCount(entry.searchText);
          const batch = batches[batchNumberByIndex.get(i)! - 1];
          const label = batch?.oversized
            ? "oversized (skipped)"
            : `batch ${batchNumberByIndex.get(i)}/${batches.length}`;
          warnVerbose(`[embed] ${entry.itemRef} (${chars} chars, est. ${tokens} tokens) → ${label}`);
        }
      } else {
        for (const entry of pendingEntries) {
          warnVerbose(
            `[embed] ${entry.itemRef} (${entry.searchText.length} chars, est. ${estimateTokenCount(entry.searchText)} tokens)`,
          );
        }
      }
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let storedCount = 0;
    let skippedCount = 0;
    let embedFailedCount = 0;
    let storedTokens = 0;
    try {
      heartbeatTimer = setInterval(() => {
        onProgress({
          phase: "embeddings",
          message: formatEmbeddingHeartbeat(storedCount, pendingEntries.length, embedFailedCount),
        });
      }, 15000);

      // A failing sub-batch or an oversized document is SKIPPED by embedBatch,
      // not thrown (#874) — collect what couldn't be embedded and why, so a
      // few bad documents don't discard every other entry's embedding.
      const skips: EmbeddingBatchSkip[] = [];
      const embedStart = Date.now();
      // Circuit breaker (#954): stop
      // dispatching further batches once either consecutive-failure streak
      // below reaches CIRCUIT_BREAKER_THRESHOLD — a dead/hung provider used
      // to grind through every remaining batch for hours, one 30s (now
      // configurable, and now backed off/retried/split first — see
      // RemoteEmbedder.embedBatch) timeout at a time, ending in one
      // aggregate warning and `ok: true`. Counted per BATCH
      // (`skip.batchStart`), not per document: a single failed 100-document
      // batch must not look like 100 consecutive failures.
      let consecutiveSingleDocFailures = 0;
      let consecutiveNetworkErrorFailures = 0;
      let circuitBreakerReason: string | undefined;
      const onSkip: EmbeddingSkipHandler = (skip) => {
        skips.push(skip);
        if (!skip.batchStart) return undefined;
        if (skip.reason === "context-window-exceeded") {
          consecutiveSingleDocFailures = 0;
          consecutiveNetworkErrorFailures = 0;
          return undefined;
        }
        // "batch-request-failed": a timeout only counts once retries have
        // already narrowed it down to a single document (embedBatch backs
        // off, retries, and splits a multi-document timeout before ever
        // reporting it here); a network error counts immediately at any
        // size — it was never retried, so it is trusted right away.
        consecutiveSingleDocFailures = skip.batchSize === 1 ? consecutiveSingleDocFailures + 1 : 0;
        consecutiveNetworkErrorFailures =
          skip.failureKind === "network-error" ? consecutiveNetworkErrorFailures + 1 : 0;
        if (
          consecutiveSingleDocFailures >= CIRCUIT_BREAKER_THRESHOLD ||
          consecutiveNetworkErrorFailures >= CIRCUIT_BREAKER_THRESHOLD
        ) {
          circuitBreakerReason = skip.message;
          return false;
        }
        return undefined;
      };
      // Commit each provider batch in its own short transaction as it lands,
      // rather than buffering the whole run in memory for one transaction at
      // the very end (#954) — a competing-process lock error or any other
      // interruption partway through now keeps whatever already committed
      // instead of losing the entire pass.
      // Tracks what this run actually observed, so a successful pass can
      // record `embeddingIdentity` from real data rather than the config
      // string alone (#955) — only the first non-empty batch's vector width
      // is kept; every batch from one run shares the same provider/model.
      let observedModel: string | undefined;
      let observedVectorLen: number | undefined;
      // Whether the remote provider's endpoint/model/token language is
      // meaningful for this run — the per-batch diagnostic line below is
      // remote-only, same gate the credential diagnostic (#953) above uses.
      const reportPerBatchLine = hasRemoteEndpoint(config.embedding ?? {});
      const onBatch: EmbeddingBatchCommit = (indices, batchEmbeddings, model, outcome) => {
        // #954 field-report follow-up: a "retrying" event carries nothing to
        // commit — the request hasn't settled yet — only the notice that a
        // back-off is about to be waited out, default-level so a run is
        // never silently stalled indistinguishably from a hang.
        if (outcome?.outcome === "retrying") {
          if (reportPerBatchLine) {
            onProgress({
              phase: "embeddings",
              message: `[embed] batch ${outcome.batchIndex}/${outcome.batchCount}: ${outcome.docCount} docs, ${outcome.requestTokens.toLocaleString()} tokens → retrying after ${(outcome.elapsedMs / 1000).toFixed(1)} s`,
            });
          }
          return;
        }
        // #954: a "budget-lowered" event is the same kind of notice as
        // "retrying" above — the run's first context-size rejection just
        // shrank the request budget for everything not yet dispatched, but
        // THIS rejected batch's own indices are still being split and
        // retried by the embedder (their real stored/failed outcome lands in
        // a later onBatch call). Nothing here has settled, so it must never
        // touch storage, only report the notice — one line, at most once per
        // run.
        if (outcome?.outcome === "budget-lowered") {
          if (reportPerBatchLine) {
            onProgress({
              phase: "embeddings",
              message: `[embed] batch ${outcome.batchIndex}/${outcome.batchCount}: ${outcome.docCount} docs, ${outcome.requestTokens.toLocaleString()} tokens → ${outcome.reason}`,
            });
          }
          return;
        }
        if (model) observedModel = model;
        // A batch that delivered at least one real embedding proves the
        // provider is currently answering — reset both circuit-breaker
        // streaks. (A wholly failed batch's `batchEmbeddings` are all
        // `undefined`, per commitBatch's skip path, so this never
        // re-triggers what onSkip just counted moments earlier.)
        if (batchEmbeddings.some((embedding) => embedding !== undefined)) {
          consecutiveSingleDocFailures = 0;
          consecutiveNetworkErrorFailures = 0;
        }
        db.transaction(() => {
          for (let k = 0; k < indices.length; k++) {
            const entry = pendingEntries[indices[k] as number];
            if (!entry) continue;
            const embedding = batchEmbeddings[k];
            if (!embedding) {
              embedFailedCount++;
              continue;
            }
            if (observedVectorLen === undefined) observedVectorLen = embedding.length;
            const result = upsertEmbedding(db, entry.id, embedding);
            if (result.stored) {
              storedCount++;
              storedTokens += estimateTokenCount(entry.searchText);
            } else {
              skippedCount++;
            }
            if (result.vec === "failed") vecFailedCount++;
            if (result.vec === "unavailable") vecUnavailableCount++;
          }
        })();
        // Default level, one line per provider batch (#954, field-report
        // follow-up): oversized documents never made a request
        // (`reason === "oversized"`), so there is no batch outcome to
        // report — they are covered by the run's final oversized-skip
        // count and list instead.
        if (outcome && outcome.reason !== "oversized" && reportPerBatchLine) {
          const elapsedSeconds = (outcome.elapsedMs / 1000).toFixed(1);
          const outcomeLabel =
            outcome.outcome === "stored"
              ? `${outcome.docCount} stored (${elapsedSeconds} s)`
              : `failed: ${outcome.reason}`;
          onProgress({
            phase: "embeddings",
            message: `[embed] batch ${outcome.batchIndex}/${outcome.batchCount}: ${outcome.docCount} docs, ${outcome.requestTokens.toLocaleString()} tokens → ${outcomeLabel}`,
          });
        }
        // Every committed batch, not just every 500 stored entries (#954)
        // — the prior bucketing left a non-verbose run silent
        // for the entire embedding phase on anything smaller than 500
        // entries, indistinguishable from a hang.
        onProgress({
          phase: "embeddings",
          message: `Embedded ${storedCount}/${pendingEntries.length} entries.`,
        });
      };
      await embedBatch(texts, config.embedding, signal, onSkip, onBatch);
      throwIfAborted(signal);
      const elapsedSeconds = Math.max((Date.now() - embedStart) / 1000, 0.001);
      if (skippedCount > 0) {
        warn(
          `[embed] ${skippedCount} embedding${skippedCount === 1 ? "" : "s"} skipped (entry deleted between queue and write)`,
        );
      }
      const vecGenerationComplete = targetEntryIds === undefined ? isVecFastPathComplete(db) : vecFastPathWasReady;
      setVecFastPathReady(db, vecFailedCount === 0 && vecUnavailableCount === 0 && vecGenerationComplete);
      if (vecFailedCount > 0) {
        warn(
          `[embed] ${vecFailedCount} sqlite-vec fast-path insert${vecFailedCount === 1 ? "" : "s"} failed — ` +
            "semantic search will use the slower JS-cosine fallback over stored embeddings. " +
            "Rebuild with 'akm index --full' after resolving the vec table (often a vector-dimension mismatch).",
        );
      }
      const entriesPerSec = storedCount / elapsedSeconds;
      const tokensPerSec = storedTokens / elapsedSeconds;
      const totalStored = storedCount + reusedCount;
      // #954, field-report follow-up: the final line
      // reports every outcome, not just what was stored — counts come from
      // the same collected `skips` the circuit breaker already uses,
      // categorized by `reason`/`failureKind`. "oversized skipped" =
      // context-window-exceeded (never fit any request, at any size);
      // "timed out" = a batch-request-failed skip whose last attempt timed
      // out (retries/splits already exhausted before this counted); "failed"
      // = every other batch-request-failed skip (a genuine, never-retried
      // network/HTTP failure).
      const oversizedSkips = skips.filter((skip) => skip.reason === "context-window-exceeded");
      const timedOutSkips = skips.filter(
        (skip) => skip.reason === "batch-request-failed" && skip.failureKind === "timeout",
      );
      const failedSkips = skips.filter(
        (skip) => skip.reason === "batch-request-failed" && skip.failureKind !== "timeout",
      );
      const throughputLine =
        reusedCount > 0
          ? // #955: report reused and newly-embedded counts separately — the
            // rate figures below are provider throughput only (reuse is a
            // plain DB write, not provider work) and would be misleadingly
            // inflated if reused entries were folded into them.
            `Stored ${totalStored} embedding${totalStored === 1 ? "" : "s"} (${reusedCount} reused, ${storedCount} newly embedded) in ${elapsedSeconds.toFixed(1)}s (${entriesPerSec.toFixed(1)} entries/s, ~${Math.round(tokensPerSec)} tokens/s)`
          : `Stored ${storedCount} embedding${storedCount === 1 ? "" : "s"} in ${elapsedSeconds.toFixed(1)}s (${entriesPerSec.toFixed(1)} entries/s, ~${Math.round(tokensPerSec)} tokens/s)`;
      onProgress({
        phase: "embeddings",
        message: `${throughputLine}; ${oversizedSkips.length} oversized skipped, ${timedOutSkips.length} timed out, ${failedSkips.length} failed.`,
      });
      // Bounded itemRef-level detail for every skip category, not just
      // oversized — the aggregate counts above say HOW MANY documents timed
      // out or failed, but give the operator no way to find out WHICH ones
      // short of rerunning with --verbose and re-reading the whole log.
      // Default level caps each list (there is nothing actionable about the
      // 21st identical failure); --verbose prints every one, matching the
      // per-document mapping lines' own verbosity gate above.
      const printSkipList = (label: string, skipList: EmbeddingBatchSkip[]): void => {
        if (skipList.length === 0) return;
        const limit = isVerbose() ? skipList.length : 20;
        const listed = skipList
          .slice(0, limit)
          .map((skip) => `  - ${pendingEntries[skip.index]?.itemRef ?? skip.index}: ${skip.message}`)
          .join("\n");
        const more = skipList.length > limit ? `\n  ...and ${skipList.length - limit} more` : "";
        onProgress({ phase: "embeddings", message: `[embed] ${label} skipped:\n${listed}${more}` });
      };
      printSkipList("oversized documents", oversizedSkips);
      printSkipList("timed-out documents", timedOutSkips);
      printSkipList("failed documents", failedSkips);
      setMeta(db, "embeddingFingerprint", currentFingerprint);
      const observedIdentity = deriveObservedEmbeddingIdentity(config.embedding, observedModel, observedVectorLen);
      if (observedIdentity) setMeta(db, "embeddingIdentity", observedIdentity);
      // Circuit breaker tripped (#954): committed batches are
      // kept (nothing above discards them), but the pass is not a success —
      // the provider looks dead, not just occasionally flaky.
      if (circuitBreakerReason !== undefined) {
        const message =
          `embedding provider failed ${CIRCUIT_BREAKER_THRESHOLD} consecutive batches ` +
          `(last: ${circuitBreakerReason}); stopped after ${storedCount} embedding${storedCount === 1 ? "" : "s"} ` +
          "were stored — rerun akm index when the endpoint is healthy";
        warn(`[embed] ${message}`);
        onProgress({ phase: "embeddings", message });
        return { success: false, message, vecInsertFailures: vecFailedCount };
      }
      // Only a total failure (nothing at all embedded, despite having entries
      // to embed) turns into a phase failure. Any partial success — the vast
      // majority of a large bundle embedding fine around a handful of skips —
      // must not discard what DID get stored (#874).
      if (storedCount === 0 && embedFailedCount > 0) {
        const firstMessage = skips[0]?.message ?? "All embeddings failed.";
        // #873 removed the persisted semantic verdict, so there is no failure
        // class to record — just report what happened on this run.
        return {
          success: false,
          message: `All ${embedFailedCount} embedding batch(es) failed: ${firstMessage}`,
        };
      }
      // A pass that completes without abort or circuit-break purges
      // whatever salvage is left — consumed by this pass's reuse step
      // above, or superseded by what it just embedded.
      purgeEmbeddingSalvage(db);
      return { success: true, vecInsertFailures: vecFailedCount };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn("Embedding generation failed, continuing without:", message);
    onProgress({ phase: "embeddings", message: `Embedding generation failed: ${message}` });
    return {
      success: false,
      message: `Semantic search verification failed: ${message}`,
    };
  }
}

/**
 * Update the `hasEmbeddings` DB fact after a targeted mutation, from the
 * index's actual current embedding coverage — read fresh, not cached.
 */
export function publishTargetedEmbeddingMeta(db: Database, config: AkmConfig): void {
  if (config.semanticSearchMode === "off") {
    setMeta(db, "hasEmbeddings", "0");
    return;
  }

  const entryCount = getEmbeddableEntryCount(db);
  const embeddingCount = getEmbeddingCount(db);
  const ready = entryCount > 0 && embeddingCount >= entryCount;
  setMeta(db, "hasEmbeddings", ready ? "1" : "0");
}
