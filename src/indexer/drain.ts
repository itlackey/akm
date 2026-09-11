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
 * whichever provider response lands first and adopted from then on. Adoption
 * happens AT MOST ONCE per `drainEmbeddingQueue` call, decided by the FIRST
 * committed batch this call sees (docs/plans/index-redesign.md, rule 1:
 * identity is content-addressed on what the provider actually returned) — a
 * model swap (`embedding.model` changed, or the gateway now serving a
 * different model) is still caught, just not any faster than the NEXT call's
 * own first batch. A later batch THIS SAME call observes reporting a
 * DIFFERENT identity than the one already adopted is left missing rather
 * than switched to: a provider whose responses alternate between two models
 * across batches of one call (a load-balanced gateway, a blue/green rollout
 * behind one endpoint) must not thrash the store between them — embed, then
 * delete, then re-embed, never converging. Those rows simply become
 * "missing" again under whatever identity this call adopted, and a LATER
 * call, whose own first batch observes the alternate identity, adopts it
 * then and purges the one left behind (rule 4: embedding is a queue, always
 * resumable from the same set difference). A drain also does nothing when
 * sqlite-vec is unavailable: `upsertUnitVectors` cannot persist a vector
 * without it, so the whole pending set is reported `skipped` without ever
 * calling the provider.
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
 * Failure threshold, within the recent window below, that stops dispatching
 * further provider batches. Mirrors materialize-embeddings.ts's own
 * (unexported) `CIRCUIT_BREAKER_THRESHOLD`, #954 — reimplemented here at the
 * same value rather than imported, since that file is private and slated for
 * deletion by B5; the underlying stop-dispatch MECHANISM (`onSkip` returning
 * `false`) is still the real `RemoteEmbedder`'s, reused unmodified. Two
 * independent streaks share it: single-document failures (a multi-document
 * timeout is not yet evidence of a dead endpoint — `RemoteEmbedder` retries
 * and splits it smaller before ever reporting it this small), or network
 * errors at ANY size (never retried, trusted immediately). Storage-write
 * failures (E5b — `upsertUnitVectors`'s own per-row result) feed the SAME two
 * streaks: a sustained STORAGE failure (contention, permissions, a full
 * disk) must stop paying for provider requests just as surely as a
 * sustained PROVIDER failure, even while the provider itself keeps
 * succeeding.
 */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Recent-history window (in settled batch-starts) the two streaks above are
 * evaluated over, in place of a plain "reset to zero on any success" counter
 * (round-2 field finding): with concurrent dispatch (default 2, up to 16)
 * outcomes settle out of dispatch order, so a degraded endpoint failing MOST
 * requests never tripped the breaker as long as occasional successes
 * interleaved — reproduced with a 67% failure rate dispatching the entire
 * pending set. `CIRCUIT_BREAKER_THRESHOLD` failures within the last
 * `CIRCUIT_BREAKER_WINDOW` settled batch-starts of a streak's own kind (see
 * {@link pushBreakerOutcome}) trips it: a genuinely dead endpoint (no
 * successes at all) still trips in exactly `CIRCUIT_BREAKER_THRESHOLD`
 * batches, same as before; a single success now only AGES a failure out of
 * the window over time rather than erasing the whole run's evidence at once.
 */
const CIRCUIT_BREAKER_WINDOW = CIRCUIT_BREAKER_THRESHOLD * 2;

/** Record one settled batch-start's outcome into a breaker streak's window, capped at {@link CIRCUIT_BREAKER_WINDOW}. */
function pushBreakerOutcome(window: boolean[], isFailure: boolean): void {
  window.push(isFailure);
  if (window.length > CIRCUIT_BREAKER_WINDOW) window.shift();
}

/** Failures currently recorded in a breaker streak's window. */
function breakerFailureCount(window: boolean[]): number {
  return window.reduce((n, isFailure) => n + (isFailure ? 1 : 0), 0);
}

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
  // Two independent circuit-breaker streaks (single-document failures,
  // network errors at any size) — see CIRCUIT_BREAKER_WINDOW above.
  const singleDocFailureWindow: boolean[] = [];
  const networkErrorFailureWindow: boolean[] = [];
  // Whether this CALL has already decided the identity its first committed
  // row observed (E1) — adoption happens at most once per call; see the
  // module doc comment and the identity block in `onBatch` below.
  let identityDecidedThisCall = false;

  const onSkip: EmbeddingSkipHandler = (skip: EmbeddingBatchSkip) => {
    failed++;
    if (!skip.batchStart) return undefined;
    if (skip.reason === "context-window-exceeded") {
      // Proves the provider IS reachable; not evidence of a dead endpoint.
      singleDocFailureWindow.length = 0;
      networkErrorFailureWindow.length = 0;
      return undefined;
    }
    pushBreakerOutcome(singleDocFailureWindow, skip.batchSize === 1);
    pushBreakerOutcome(networkErrorFailureWindow, skip.failureKind === "network-error");
    if (
      breakerFailureCount(singleDocFailureWindow) >= CIRCUIT_BREAKER_THRESHOLD ||
      breakerFailureCount(networkErrorFailureWindow) >= CIRCUIT_BREAKER_THRESHOLD
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
      const learned = deriveObservedEmbeddingIdentity(config.embedding, model, embedding.length);
      if (!identityDecidedThisCall) {
        // This call's FIRST committed row decides the identity it adopts
        // (E1) — learned once, not re-derived per batch: a provider whose
        // responses alternate between models WITHIN one call (a
        // load-balanced gateway, a blue/green rollout behind one endpoint)
        // must not thrash the store between them (embed, delete, re-embed,
        // never converging). A genuine model change is still caught, just
        // not until the NEXT call's own first batch observes it and purges
        // whatever this call left behind.
        identityDecidedThisCall = true;
        if (learned && learned !== identity) {
          identity = learned;
          setMeta(db, "embeddingIdentity", identity);
          dropOtherIdentities(db, identity, embedding.length);
        }
      }
      const currentIdentity = identity;
      if (currentIdentity === null || learned !== currentIdentity) {
        // Either nothing has ever been learned, or a LATER batch this same
        // call reported an identity different from the one already adopted
        // — left missing rather than switched to; it becomes "missing"
        // again under whatever identity this call is using, and a later
        // call, whose own first batch observes it, picks it up. Counted in
        // `skipped` below (attempted minus embedded minus failed), not
        // `embedded`.
        continue;
      }
      const hash = orderedHashes[indices[k] as number];
      if (hash) rows.push({ hash, identity: currentIdentity, vector: embedding });
    }

    let storageBreakerTripped = false;
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
      if (result.failed > 0) {
        // E5b: a write failure is just as much evidence of a broken run as
        // a provider failure — a sustained STORAGE failure (contention,
        // permissions, a full disk) must not keep dispatching every
        // remaining batch to a perfectly healthy provider at full cost
        // while every write silently fails. One event per committed batch
        // (the "count batch starts, not documents" rule onSkip already
        // applies to provider failures), fed into the SAME two streaks.
        pushBreakerOutcome(singleDocFailureWindow, true);
        pushBreakerOutcome(networkErrorFailureWindow, true);
        if (
          breakerFailureCount(singleDocFailureWindow) >= CIRCUIT_BREAKER_THRESHOLD ||
          breakerFailureCount(networkErrorFailureWindow) >= CIRCUIT_BREAKER_THRESHOLD
        ) {
          storageBreakerTripped = true;
        }
      }
    }
    if (embeddings.some((embedding) => embedding !== undefined)) {
      pushBreakerOutcome(singleDocFailureWindow, false);
      pushBreakerOutcome(networkErrorFailureWindow, false);
    }

    batchNumber++;
    if (opts.onProgress) {
      const docCount = outcome?.docCount ?? indices.length;
      const label =
        outcome && outcome.outcome !== "stored" ? `failed: ${outcome.reason ?? "unknown"}` : `${rows.length} stored`;
      opts.onProgress(`${DRAIN_BATCH_PROGRESS_PREFIX}${batchNumber}: ${docCount} docs → ${label}`);
    }

    if (storageBreakerTripped) {
      // onBatch has no `false`-return stop-dispatch contract the way onSkip
      // does (a storage failure can trip this even when the provider itself
      // keeps succeeding, so onSkip is never called at all) — this reuses
      // RemoteEmbedder's own documented mechanism instead: a throw from
      // onBatch stops the pool from dispatching any further provider
      // request, and is rethrown once every in-flight batch has settled.
      throw new Error(
        `Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} storage write failures while embedding; stopping further provider requests this call.`,
      );
    }
  };

  await embedBatch(texts, embeddingConfig, opts.signal, onSkip, onBatch, packing);
  throwIfAborted(opts.signal);

  const attempted = texts.length;
  const skipped = Math.max(0, attempted - embedded - failed);

  return emitDone({ pending, embedded, failed, skipped, identity });
}
