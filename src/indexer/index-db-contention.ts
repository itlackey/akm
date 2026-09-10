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
import { probeLock } from "../core/file-lock";
import { formatLockHolderPid } from "../core/run-lock";
import { isSqliteContentionError } from "../core/state-db";
import { indexRebuildLockPath } from "./index-rebuild-lock";

/**
 * Read-only description of the rebuild lock's current holder, appended to a
 * reclassified index.db contention message when known (field follow-up to
 * #956). `probeLock` only inspects the sentinel — it never acquires or
 * mutates it — so this is safe to call from inside an error path.
 */
function describeIndexRebuildLockHolder(): string {
  const probe = probeLock(indexRebuildLockPath());
  if (probe.state !== "held") return "";
  return ` The rebuild lock is currently held by pid ${formatLockHolderPid({
    pid: probe.holderPid,
    launcherPid: probe.launcherPid ?? null,
  })}.`;
}

/**
 * Reclassify a contention-shaped error escaping the walk, index, or
 * embedding phase into a retryable-shortly `TransientError` (field
 * follow-up to #956, dev-team field review 2026-09-10): a concurrent writer
 * (another `akm index`, a source-update embedding pass, the per-command
 * background reindex) can make index.db busy, and the raw SQLite driver
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
    `akm's index database is busy (another akm process is writing it); retry shortly.${describeIndexRebuildLockHolder()}`,
    "INDEX_DB_CONTENDED",
  );
  contended.cause = error;
  return contended;
}
