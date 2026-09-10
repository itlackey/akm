// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The embedding queue (docs/plans/index-redesign-contract.md, module B4).
 *
 * Drains `unit_texts` rows that have no vector under the active identity
 * (`index_meta.embeddingIdentity`): pending = `unit_texts.unit_hash` minus
 * `units` for that identity (`listMissingHashes`, stage 1's set-difference —
 * docs/plans/index-fragment-vectors.md, "Indexing is a set difference"). When
 * no identity is known yet (a fresh index, or one whose prior identity was
 * dropped), every candidate hash is pending; the identity is learned from
 * whichever provider response lands first and adopted from then on. Every
 * committed batch re-derives the identity actually observed and adopts it
 * the moment it differs from what is currently active — a model swap
 * (`embedding.model` changed, or the gateway now serving a different model)
 * is caught as soon as the provider reports it, rather than mixing a new
 * model's vectors into an old identity's rows (docs/plans/index-redesign.md,
 * rule 1: identity is content-addressed on what the provider actually
 * returned). Units already embedded under an identity this call abandons
 * simply become "missing" again under the new one and drain on a later call
 * (rule 4: embedding is a queue, always resumable from the same set
 * difference). A drain also does nothing when sqlite-vec is unavailable:
 * `upsertUnitVectors` cannot persist a vector without it, so the whole
 * pending set is reported `skipped` without ever calling the provider.
 *
 * Reuses `embedBatch` / `RemoteEmbedder` (src/llm/embedder.ts,
 * src/llm/embedders/remote.ts) for the batching, retry, back-off and
 * per-batch commit machinery rather than duplicating it — this module's own
 * job is the pending set, the identity, and turning each provider batch into
 * a durable `upsertUnitVectors` write. Requests are packed against the
 * provider's own window/slot limits (`probeProviderLimits`,
 * src/llm/embedders/provider-limits.ts) rather than a generic config default.
 *
 * The entry-scoped embedder this replaces (`materialize-embeddings.ts`) is
 * deleted; the one piece of it still shared is `deriveObservedEmbeddingIdentity`.
 * `emitCredentialDiagnostic` ports that file's `#953` credential diagnostic
 * (endpoint/model/credential-source line before the first provider request)
 * forward to this queue.
 */

import type { AkmConfig, EmbeddingConnectionConfig } from "../core/config/config";
import { getConfigPath } from "../core/paths";
import { isVerbose } from "../core/warn";
import { embedBatch } from "../llm/embedder";
import { probeProviderLimits } from "../llm/embedders/provider-limits";
import {
  describeEmbeddingCredential,
  type EmbeddingBatchCommit,
  type EmbeddingBatchSkip,
  type EmbeddingRequestPacking,
  type EmbeddingSkipHandler,
  hasRemoteEndpoint,
  normalizeEmbeddingEndpoint,
} from "../llm/embedders/remote";
import type { EmbeddingVector } from "../llm/embedders/types";
import type { Database } from "../storage/database";
import { getMeta, setMeta } from "../storage/repositories/index-meta-repository";
import { SQLITE_CHUNK_SIZE } from "../storage/repositories/index-sql";
import { isVecAvailable } from "../storage/repositories/index-vec-repository";
import { dropOtherIdentities, listMissingHashes, upsertUnitVectors } from "../storage/repositories/units-repository";
import { deriveObservedEmbeddingIdentity } from "./embedding-identity";

export interface DrainCounts {
  /** Distinct unit hashes found missing a vector for the active identity, before `limit` bounds the work. */
  pending: number;
  /** Unit hashes whose vector was newly written this call. */
  embedded: number;
  /** Unit hashes the provider could not embed (context-window, timeout, or a genuine transport failure). */
  failed: number;
  /** Unit hashes attempted but neither embedded nor reported failed — never dispatched, because the circuit breaker tripped or because sqlite-vec is unavailable (then every pending hash). */
  skipped: number;
  /** The active identity after this call, or `null` if none has ever been learned. */
  identity: string | null;
}

export interface DrainOptions {
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** Cap on how many missing units this call embeds; the rest stay pending for a later call. */
  limit?: number;
  /** Restrict the candidate set to exactly these hashes (still filtered down to what is actually missing) — B2's write-time drain uses this to embed only the units a just-written asset added. */
  onlyHashes?: readonly string[];
}

/**
 * Consecutive-failure threshold that stops dispatching further provider
 * batches. Mirrors materialize-embeddings.ts's own (unexported)
 * `CIRCUIT_BREAKER_THRESHOLD`, #954 — reimplemented here at the same value
 * rather than imported, since that file is private and slated for deletion
 * by B5; the underlying stop-dispatch MECHANISM (`onSkip` returning `false`)
 * is still the real `RemoteEmbedder`'s, reused unmodified. Two independent
 * streaks share it: 3 consecutive single-document failures (a multi-document
 * timeout is not yet evidence of a dead endpoint — `RemoteEmbedder` retries
 * and splits it smaller before ever reporting it this small), or 3
 * consecutive network errors at ANY size (never retried, trusted
 * immediately).
 */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Prefix of the per-committed-batch progress line (`"${DRAIN_BATCH_PROGRESS_PREFIX}N: …"`,
 * emitted once per provider batch this call commits). Exported so a caller
 * juggling several `onProgress` sources (`stash-cli.ts`'s `akm index`) can
 * recognize — and, outside `--verbose`, suppress — this specific
 * high-frequency line by prefix rather than re-deriving its own copy of the
 * pattern (#954).
 */
export const DRAIN_BATCH_PROGRESS_PREFIX = "[drain] batch ";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("drain interrupted");
  }
}

/** Every distinct unit hash the index currently knows about, regardless of identity. */
function selectAllUnitHashes(db: Database): string[] {
  return (db.prepare("SELECT unit_hash FROM unit_texts ORDER BY unit_hash").all() as { unit_hash: string }[]).map(
    (row) => row.unit_hash,
  );
}

/** `unit_hash -> text` for exactly `hashes`, chunked to respect SQLite's bound-parameter limit. */
function fetchUnitTexts(db: Database, hashes: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (let offset = 0; offset < hashes.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = hashes.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT unit_hash, text FROM unit_texts WHERE unit_hash IN (${placeholders})`)
      .all(...chunk) as { unit_hash: string; text: string }[];
    for (const row of rows) texts.set(row.unit_hash, row.text);
  }
  return texts;
}

/**
 * Effective embedding config and request packing for this drain (index
 * redesign, B5 — replaces the retired `embedding.maxTokens`/`batchSize`/
 * `contextLength` config keys): `concurrency` (in-flight requests) defaults
 * to the provider's OWN observed slot count when `embedding.concurrency`
 * itself leaves it unset (`probeProviderLimits` already applies that same
 * override to `slots`). The request TOKEN WINDOW, chars-per-token ratio, and
 * Ollama `num_ctx` are no longer config fields at all — they are threaded
 * into `RemoteEmbedder.embedBatch` as `packing`, sourced straight from the
 * same probe: `windowTokens` for the per-request budget, `charsPerToken` for
 * the calibrated per-text token estimate, and `windowTokens` again for
 * Ollama's `num_ctx` when `source === "ollama"`. `windowIsKnown`
 * (`source !== "default"`) gates `RemoteEmbedder`'s same-run adaptive
 * shrink: a provider that reports nothing about its own context size still
 * gets that corrective, but a probed, authoritative window does not need it
 * second-guessed.
 */
async function resolveEmbeddingPacking(
  config: AkmConfig,
  signal: AbortSignal | undefined,
): Promise<{ embeddingConfig: EmbeddingConnectionConfig; packing: EmbeddingRequestPacking }> {
  const base = config.embedding ?? {};
  const limits = await probeProviderLimits(base, { signal });
  return {
    embeddingConfig: { ...base, concurrency: base.concurrency ?? limits.slots },
    packing: {
      tokenBudget: limits.windowTokens,
      charsPerToken: limits.charsPerToken,
      windowIsKnown: limits.source !== "default",
      ollamaNumCtx: limits.source === "ollama" ? limits.windowTokens : undefined,
    },
  };
}

/**
 * #953 field gap, ported from the deleted `materialize-embeddings.ts`
 * (`git show fc711fd6^:src/indexer/materialize-embeddings.ts`): a keyless
 * request against a remote embedding endpoint could not be reproduced in the
 * lab — every `RemoteEmbedder` path already resolves `secret://` through one
 * boundary, so a keyless request can only mean `embedding.apiKey` was absent
 * from the config THIS run loaded. The actionable outcome is a
 * self-diagnosing run, not a fix: one default-level line, emitted once
 * before the first provider request this call makes, naming the endpoint,
 * model, and credential SOURCE (never the value) so a field run can compare
 * it against what the gateway actually saw. A local (non-remote) endpoint,
 * or a call with nothing pending, has nothing to diagnose and stays silent.
 */
function emitCredentialDiagnostic(config: AkmConfig, onProgress: ((line: string) => void) | undefined): void {
  if (!onProgress || !hasRemoteEndpoint(config.embedding ?? {})) return;
  const endpoint = normalizeEmbeddingEndpoint(config.embedding?.endpoint ?? "");
  const credential = describeEmbeddingCredential(config.embedding?.apiKey);
  const configFileSuffix = isVerbose() ? `; config: ${getConfigPath()}` : "";
  onProgress(
    `[embed] endpoint ${endpoint}, model ${config.embedding?.model ?? "unknown"}; credential: ${credential}${configFileSuffix}`,
  );
}

function formatDoneLine(counts: DrainCounts): string {
  return (
    `[drain] done: ${counts.pending} pending, ${counts.embedded} embedded, ${counts.failed} failed, ` +
    `${counts.skipped} skipped (identity: ${counts.identity ?? "unknown"})`
  );
}

export async function drainEmbeddingQueue(
  db: Database,
  config: AkmConfig,
  opts: DrainOptions = {},
): Promise<DrainCounts> {
  throwIfAborted(opts.signal);

  let identity = getMeta(db, "embeddingIdentity") ?? null;

  if (config.semanticSearchMode === "off") {
    return { pending: 0, embedded: 0, failed: 0, skipped: 0, identity };
  }

  const candidateHashes = opts.onlyHashes ? [...new Set(opts.onlyHashes)] : selectAllUnitHashes(db);
  const missingHashes = identity ? listMissingHashes(db, candidateHashes, identity) : candidateHashes;
  const pending = missingHashes.length;

  const emitDone = (counts: DrainCounts): DrainCounts => {
    opts.onProgress?.(formatDoneLine(counts));
    return counts;
  };

  // upsertUnitVectors is a no-op without sqlite-vec (units-repository.ts), so
  // embedding the pending set here would just throw every vector away and
  // leave it "missing" again for the next call — pure wasted provider
  // traffic. `akmIndex`'s verification reports the missing extension as
  // blocked; this stays silent. `pending` is computed above so the done line and `akm
  // index status` stay truthful even though nothing was attempted.
  if (!isVecAvailable(db)) {
    return emitDone({ pending, embedded: 0, failed: 0, skipped: pending, identity });
  }

  if (pending === 0) {
    return emitDone({ pending: 0, embedded: 0, failed: 0, skipped: 0, identity });
  }

  const boundedHashes = opts.limit !== undefined ? missingHashes.slice(0, opts.limit) : missingHashes;
  const textByHash = fetchUnitTexts(db, boundedHashes);
  // A hash in `unit_texts` should always resolve to a row (it was just read
  // from that same table above), but a missing row is dropped rather than
  // sent to the provider as `undefined` text.
  const orderedHashes = boundedHashes.filter((hash) => textByHash.has(hash));
  const texts = orderedHashes.map((hash) => textByHash.get(hash) as string);

  if (texts.length === 0) {
    return emitDone({ pending, embedded: 0, failed: 0, skipped: 0, identity });
  }

  emitCredentialDiagnostic(config, opts.onProgress);

  const { embeddingConfig, packing } = await resolveEmbeddingPacking(config, opts.signal);

  let embedded = 0;
  let failed = 0;
  let batchNumber = 0;
  let consecutiveSingleDocFailures = 0;
  let consecutiveNetworkErrorFailures = 0;

  const onSkip: EmbeddingSkipHandler = (skip: EmbeddingBatchSkip) => {
    failed++;
    if (!skip.batchStart) return undefined;
    if (skip.reason === "context-window-exceeded") {
      // Proves the provider IS reachable; not evidence of a dead endpoint.
      consecutiveSingleDocFailures = 0;
      consecutiveNetworkErrorFailures = 0;
      return undefined;
    }
    consecutiveSingleDocFailures = skip.batchSize === 1 ? consecutiveSingleDocFailures + 1 : 0;
    consecutiveNetworkErrorFailures = skip.failureKind === "network-error" ? consecutiveNetworkErrorFailures + 1 : 0;
    if (
      consecutiveSingleDocFailures >= CIRCUIT_BREAKER_THRESHOLD ||
      consecutiveNetworkErrorFailures >= CIRCUIT_BREAKER_THRESHOLD
    ) {
      return false;
    }
    return undefined;
  };

  const onBatch: EmbeddingBatchCommit = (indices, embeddings, model, outcome) => {
    // "retrying"/"budget-lowered" are in-flight notices for a batch that has
    // not settled yet (see EmbeddingBatchOutcome) — nothing to commit or
    // count, and not a distinct "batch" for the one-line-per-batch contract.
    if (outcome?.outcome === "retrying" || outcome?.outcome === "budget-lowered") return;

    const rows: { hash: string; identity: string; vector: EmbeddingVector }[] = [];
    for (let k = 0; k < indices.length; k++) {
      const embedding = embeddings[k];
      if (!embedding) continue;
      // Re-derived on every committed batch (concurrent dispatch aside,
      // onBatch calls run one at a time — JS is single-threaded — so within
      // one drain call this only differs from `identity` on the very first
      // batch, or the batch where the provider's response actually changes),
      // not just when `identity` is still null: a model swap — config
      // `embedding.model` changed, or the gateway now serving a different
      // model — must be caught the moment the provider reports it, not
      // silently mixed into the old identity's rows. Adopting it drops
      // whatever was stored under the identity being left behind (at the
      // newly observed width); units embedded under that old identity that
      // are not part of THIS call simply become "missing" again under the
      // new one and drain on a later call.
      const learned = deriveObservedEmbeddingIdentity(config.embedding, model, embedding.length);
      if (learned && learned !== identity) {
        identity = learned;
        setMeta(db, "embeddingIdentity", identity);
        dropOtherIdentities(db, identity, embedding.length);
      }
      const currentIdentity = identity;
      if (currentIdentity === null) continue;
      const hash = orderedHashes[indices[k] as number];
      if (hash) rows.push({ hash, identity: currentIdentity, vector: embedding });
    }

    if (rows.length > 0) {
      // upsertUnitVectors commits each row in its own transaction — this IS
      // "each provider batch commits durably" (a wrapping db.transaction()
      // here would only nest as an unobservable SAVEPOINT inside it, per the
      // ambient-transaction hazard materialize-embeddings.ts's own drift
      // guard documents), now made even finer-grained so one malformed
      // vector in a batch (e.g. a width mismatch) can't roll back the rest
      // of an otherwise-good response.
      const result = upsertUnitVectors(db, rows);
      embedded += result.inserted;
      failed += result.failed;
    }
    if (embeddings.some((embedding) => embedding !== undefined)) {
      consecutiveSingleDocFailures = 0;
      consecutiveNetworkErrorFailures = 0;
    }

    batchNumber++;
    if (opts.onProgress) {
      const docCount = outcome?.docCount ?? indices.length;
      const label =
        outcome && outcome.outcome !== "stored" ? `failed: ${outcome.reason ?? "unknown"}` : `${rows.length} stored`;
      opts.onProgress(`${DRAIN_BATCH_PROGRESS_PREFIX}${batchNumber}: ${docCount} docs → ${label}`);
    }
  };

  await embedBatch(texts, embeddingConfig, opts.signal, onSkip, onBatch, packing);
  throwIfAborted(opts.signal);

  const attempted = texts.length;
  const skipped = Math.max(0, attempted - embedded - failed);

  return emitDone({ pending, embedded, failed, skipped, identity });
}
