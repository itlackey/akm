// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared index.db contention reclassification (field follow-up to #956).
 *
 * Extracted out of `indexer.ts` so both `akmIndex`'s outer catch AND
 * `generateEmbeddingsForDb`'s own catch (`materialize-embeddings.ts`) can
 * reuse the ONE classifier instead of each building a raw
 * `Semantic search verification failed: <driver message>` string. Living in
 * its own module (rather than one importing the other) avoids the import
 * cycle `indexer.ts` <-> `materialize-embeddings.ts` would otherwise form.
 */

import { AkmError, TransientError } from "../core/errors";
import { isSqliteContentionError } from "../core/state-db";
import { describeLockHolder, heldRebuildLock } from "./index-rebuild-lock";

/** Names the live rebuild-lock holder, when there is one (read-only: safe in an error path). */
function holderSentence(): string {
  const holder = heldRebuildLock();
  return holder ? ` The rebuild lock is currently held by ${describeLockHolder(holder)}.` : "";
}

/**
 * Reclassify a contention-shaped error escaping the walk, index, or
 * embedding phase into a retryable-shortly `TransientError` (field
 * follow-up to #956, dev-team field review 2026-09-10): a concurrent writer
 * (another `akm index`, or a source-update embedding pass) can make index.db busy, and the raw SQLite driver
 * error ("database is locked") used to escape as exit 70
 * (internal/unclassified) instead of the "retry shortly" contract exit 75
 * gives a scheduler to branch on — mirroring `STATE_DB_CONTENDED`'s
 * precedent for state.db (`core/state-db.ts`). Reuses the ONE shared
 * classifier, `isSqliteContentionError`, rather than a second one. An error
 * that is already a classified akm error (e.g. a `STATE_DB_CONTENDED`
 * TransientError from an inner state.db write) is never re-wrapped — only a
 * raw, unclassified error matching the shared contention shape is
 * reclassified. Every other error is rethrown unchanged.
 */
export function reclassifyIndexDbContention(error: unknown): unknown {
  if (error instanceof AkmError || !isSqliteContentionError(error)) return error;
  const contended = new TransientError(
    `akm's index database is busy (another akm process is writing it); retry shortly.${holderSentence()}`,
    "INDEX_DB_CONTENDED",
  );
  contended.cause = error;
  return contended;
}
