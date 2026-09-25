// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single embedding materializer for full index runs and targeted writes.
 *
 * A full run omits `entryIds` and heals every entry that has no vector for the
 * configured model. A targeted write supplies the canonical entry IDs it just
 * changed, so the command does not return successfully with lexical state
 * newer than semantic state.
 *
 * Every stored vector carries the model it was generated under
 * (`embeddings.model`, the provider fingerprint below). That column is the
 * pass's cursor: a model change widens a targeted call to every entry, keeps
 * every stored row, and re-embeds incrementally — per-batch commits, resumable
 * after an interruption — while readers serve only the current model's rows.
 * Nothing is purged except by the explicit `akm index --reembed` override.
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
import type { Database } from "../storage/database";
import { getEmbeddableEntryCount } from "../storage/repositories/index-entries-repository";
import { deleteMeta, getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import { EMBEDDING_DIM } from "../storage/repositories/index-schema";
import {
  clearVecMirror,
  ensureVecTableWidth,
  getAllEntriesForEmbedding,
  getEmbeddingCount,
  isVecFastPathComplete,
  isVecFastPathReady,
  purgeEmbeddings,
  repairVecFastPath,
  setVecFastPathReady,
  upsertEmbedding,
} from "../storage/repositories/index-vec-repository";
import { reclassifyIndexDbContention } from "./index-db-contention";

/** Identifies the embedding provider+model+dimension a stored vector was generated with. */
export function deriveSemanticProviderFingerprint(embedding?: EmbeddingConnectionConfig): string {
  if (isDeterministicEmbedEnabled()) {
    return `deterministic:${DETERMINISTIC_EMBED_MODEL_ID}`;
  }
  if (embedding?.endpoint) {
    // Fingerprint keys on vector identity only (model + dimension). The endpoint
    // is transport/routing and has no bearing on vector compatibility, so moving
    // the same model+dimension to a different host must not force a re-embed.
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
   * `akm index --reembed`: purge every stored vector and re-embed all entries
   * under the configured model. The only path that discards vectors; a model
   * change without it keeps the stored rows and re-embeds incrementally.
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
    onProgress({ phase: "embeddings", message: "Semantic search disabled; skipping embeddings." });
    return { success: false, message: "Semantic search is disabled." };
  }

  // #953 field gap: the actionable outcome is a self-diagnosing run, not a
  // fix (every RemoteEmbedder path already resolves secret:// through one
  // boundary — a keyless request can only mean embedding.apiKey was absent
  // from the config THIS run loaded). One default-level line, before the
  // first provider request of the phase, naming the endpoint/model/credential
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
  const model = deriveSemanticProviderFingerprint(config.embedding);
  const storedModel = getMeta(db, "embeddingFingerprint");
  let targetEntryIds = entryIds;
  /** Set only when every entry is (re)embedded, so the up-front "Re-embedding N entries" line names why. */
  let rebuildReason: string | undefined;
  const maxInputTokens = config.embedding?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;

  if (opts?.forceReembed) {
    // The explicit operator override: purge and re-embed everything. The model
    // is recorded in the SAME transaction as the purge, before any embedding
    // request, so a restart heals only what is still missing instead of
    // purging again from zero (#955/#956).
    db.transaction(() => {
      purgeEmbeddings(db, { dropVecTable: true });
      deleteMeta(db, "embeddingDim");
      setMeta(db, "embeddingFingerprint", model);
    })();
    targetEntryIds = undefined;
    rebuildReason = "forced by --reembed";
  } else if (storedModel && storedModel !== model) {
    // The configured model changed. Nothing is purged: each stored row keeps
    // the model that produced it until the pass below replaces it, so an
    // interrupted pass resumes with only the rows still on the old model.
    // The sqlite-vec mirror serves one model at a time and is refilled as
    // entries are re-embedded. Readers serve the current model's rows only,
    // so nothing mixes vectors from two models.
    db.transaction(() => {
      clearVecMirror(db);
      setMeta(db, "embeddingFingerprint", model);
    })();
    targetEntryIds = undefined;
    rebuildReason = `the embedding model changed (${storedModel} → ${model}); stored vectors are kept until each entry is re-embedded`;
  } else {
    // First pass ever for this index, or the model already matches — record
    // it NOW rather than after a fully successful pass (#955/#956), so an
    // interrupted first pass still labels the vectors it durably committed.
    setMeta(db, "embeddingFingerprint", model);
  }

  try {
    throwIfAborted(signal);
    if (entryIds === undefined && (!vecFastPathWasReady || !isVecFastPathComplete(db))) {
      const storedDim = Number(getMeta(db, "embeddingDim"));
      const expectedDim =
        Number.isInteger(storedDim) && storedDim > 0 ? storedDim : (config.embedding?.dimension ?? EMBEDDING_DIM);
      const repair = repairVecFastPath(db, expectedDim);
      if (
        repair.available &&
        (repair.repaired > 0 || repair.removedOrphans > 0 || repair.rejected > 0 || repair.error !== undefined)
      ) {
        const detail = repair.error ? `; repair stopped: ${repair.error}` : "";
        onProgress({
          phase: "embeddings",
          message: `[embed] Repaired ${repair.repaired} missing sqlite-vec row${repair.repaired === 1 ? "" : "s"}; removed ${repair.removedOrphans} orphan${repair.removedOrphans === 1 ? "" : "s"}; ${repair.rejected} rejected${detail}.`,
        });
      }
    }
    const candidateEntries = getAllEntriesForEmbedding(db, targetEntryIds, model);

    let vecFailedCount = 0;
    let vecUnavailableCount = 0;

    if (candidateEntries.length === 0) {
      onProgress({ phase: "embeddings", message: "Embeddings already up to date." });
      return { success: true };
    }

    // Cap each document's embedded text at embedding.maxInputTokens (default
    // DEFAULT_MAX_INPUT_TOKENS) instead of ever failing a whole batch over one
    // oversized entry — truncation keeps the head of the text, unicode-safe. A
    // document is skipped only when its head is empty (the impossible case:
    // nothing left to embed), never merely for being long.
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
      // The first real vector of the run also fixes the sqlite-vec mirror's
      // width: a model that returns a different width than the mirror was
      // declared with (a local model swap with no `embedding.dimension` set)
      // gets the mirror recreated instead of every insert failing.
      let vecWidthChecked = false;
      // Whether the remote provider's endpoint/model/token language is
      // meaningful for this run — the per-batch diagnostic line below is
      // remote-only, same gate the credential diagnostic (#953) above uses.
      const reportPerBatchLine = hasRemoteEndpoint(config.embedding ?? {});
      const onBatch: EmbeddingBatchCommit = (indices, batchEmbeddings, outcome) => {
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
            const index = indices[k] as number;
            const entry = pendingEntries[index];
            if (!entry) continue;
            const embedding = batchEmbeddings[k];
            if (!embedding) {
              embedFailedCount++;
              continue;
            }
            if (!vecWidthChecked) {
              vecWidthChecked = true;
              ensureVecTableWidth(db, embedding.length);
              setMeta(db, "embeddingDim", String(embedding.length));
            }
            const result = upsertEmbedding(db, entry.id, embedding, model);
            if (result.stored) {
              storedCount++;
              // #954: sum the estimate of the text actually sent —
              // `texts[index]` is the capped string `embedBatch` was handed,
              // parallel to `pendingEntries` by construction above (the
              // `entry` guard covers both) — not `entry.searchText`, which is
              // the pre-cap original and overstates throughput for every
              // entry over the cap.
              storedTokens += estimateTokenCount(texts[index] as string);
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
      onProgress({
        phase: "embeddings",
        message:
          `Stored ${storedCount} embedding${storedCount === 1 ? "" : "s"} in ${elapsedSeconds.toFixed(1)}s ` +
          `(${entriesPerSec.toFixed(1)} entries/s, ~${Math.round(tokensPerSec)} tokens/s); ` +
          `${oversizedSkips.length} oversized skipped, ${timedOutSkips.length} timed out, ${failedSkips.length} failed.`,
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
      return { success: true, vecInsertFailures: vecFailedCount };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  } catch (error) {
    // Field follow-up to #956 (dev-team field review 2026-09-10): a
    // contention-shaped error (another akm process writing index.db right
    // now) used to escape this catch as a raw driver string ("database is
    // locked"), reaching this user-facing message unclassified even though
    // the acquisition-time path (`akmIndex`'s outer catch) already
    // reclassifies the same shape into `TransientError("INDEX_DB_CONTENDED")`.
    // Reuses that ONE shared classifier rather than a second one — see
    // `index-db-contention.ts`. This catch stays non-fatal (a caller sees
    // `success: false` and a message, never a thrown error): the run
    // continues through the remaining index phases exactly as it did
    // before, only the message is now classified when the error is
    // contention-shaped.
    const reclassified = reclassifyIndexDbContention(error);
    const message = reclassified instanceof Error ? reclassified.message : String(reclassified);
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
  const embeddingCount = getEmbeddingCount(db, deriveSemanticProviderFingerprint(config.embedding));
  const ready = entryCount > 0 && embeddingCount >= entryCount;
  setMeta(db, "hasEmbeddings", ready ? "1" : "0");
}
