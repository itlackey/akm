// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Write-path indexing: index exactly what a write just produced, inline, in
 * the same call as the write. `remember` / `writeMarkdownAsset`, extract's
 * session assets, `source clone`, and proposal acceptance all call this
 * right after committing their file write so the asset is searchable
 * immediately, without a background reindex.
 *
 * docs/plans/index-redesign-contract.md, module B2: a thin call to B1's
 * `reconcilePaths` (the per-file version of the stat-walk reconcile — parses,
 * upserts `entries`, derives units) followed by B4's `drainEmbeddingQueue`
 * scoped to exactly the units that reconcile just produced. No lock probe, no
 * rebuild detection, no background spawn — the redesign has no full-rebuild
 * pipeline for a write path to defer to; two writers reconciling the same
 * path converge on the same idempotent rows instead of contending for a lock.
 *
 * FAIL-OPEN at every step: any error (index.db absent, empty, unreadable,
 * unparseable file) is reduced to a verbose-only warning and the write
 * command succeeds untouched — the degraded outcome is the asset appearing
 * after the next reconcile (an explicit `akm index`, or the schedule) rather
 * than immediately.
 */

import path from "node:path";
import { loadConfig } from "../core/config/config";
import { isDataDirUnreadableError } from "../core/errors";
import { isPathAbsent } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { warn, warnVerbose } from "../core/warn";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import { getEntryCount } from "../storage/repositories/index-entries-repository";
// TODO(index-redesign B4): swap for the real `drainEmbeddingQueue` once B4 merges — see src/indexer/drain.ts's header.
import { drainEmbeddingQueue } from "./drain";
import { deriveInstallations } from "./installations";
// TODO(index-redesign B1): swap for the real `reconcilePaths` once B1 merges — see src/indexer/reconcile.ts's header.
import { reconcilePaths, registerStashRootForBundleId, unitHashesForPaths } from "./reconcile";

/**
 * Busy-timeout (ms) for write-path index upserts. Every index write in the
 * redesign is a short immediate transaction relying on SQLite's own busy
 * timeout to serialize concurrent writers (rule 5, docs/plans/index-redesign.md)
 * rather than an application-level lock — this bounds how long one interactive
 * write waits behind another process's short reconcile/drain transaction.
 */
export const WRITE_PATH_INDEX_BUSY_TIMEOUT_MS = 5_000;

/**
 * Index the given just-written asset files into the existing local index.
 *
 * Returns `true` when the index is left in the state the caller expects —
 * either genuinely updated, or one of the deliberate skips below — and
 * `false` only for a real failure, which callers that gate their own success
 * on this boolean (`acceptProposal`, `source clone`) must treat as "the
 * write stands, but tell the operator the index needs a manual `akm index`".
 *
 * Deliberate `true` skips:
 *  - An absent index: bootstrap belongs to the first read (`ensureIndex`) or
 *    an explicit `akm index`, not this fast path.
 *  - An index with zero entries: same reasoning — nothing has bootstrapped
 *    it yet.
 *  - Every given path living under a dot-segment directory (e.g. `.meta/`):
 *    the full reconcile never descends into those either.
 *
 * `false` on failure:
 *  - An index directory/file that exists but cannot be READ (not merely
 *    absent) is the one failure the next reconcile will not heal on its own
 *    (#791) — this warns audibly, not verbose-only.
 *  - Any other error during `reconcilePaths` (unparseable file, a locked
 *    database past the busy timeout, …) warns verbose-only; the write itself
 *    already succeeded and the asset appears after the next reconcile.
 *
 * The embedding drain that follows a successful reconcile is best-effort: a
 * failure there (a provider outage, a tripped circuit breaker) does NOT turn
 * this call into a `false` — the asset is already lexically searchable, and
 * the embedding queue is durable (module B4): any later drain, including the
 * next write, computes the same "no vector yet" query and picks it up.
 */
export async function indexWrittenAssets(
  stashDir: string,
  filePaths: string[],
  options: {
    /** Configured stable identity for a managed source. */
    bundleId?: string;
  } = {},
): Promise<boolean> {
  try {
    return await (async () => {
      const dbPath = getDbPath();
      // `true` here means "the index is in the state the caller expects" — and
      // `acceptProposal` advances its journal to `index-finalized` on the
      // strength of it. Only a genuinely ABSENT index earns that answer: an
      // index we cannot read has NOT been updated, so it falls through to
      // `openExistingDatabase` and surfaces as the honest `false` (#791).
      if (isPathAbsent(dbPath)) return true;

      // The full reconcile never descends into dot-directories (for example
      // `.meta/`) — mirror that dot-segment skip here so this fast path
      // indexes exactly what a full reconcile would.
      const files = filePaths.filter((f) => {
        const rel = path.relative(stashDir, f);
        return !rel.split(/[\\/]+/).some((segment) => segment.startsWith("."));
      });
      if (files.length === 0) return true;

      // Same derivation the full-index writer uses: an explicit bundleId wins
      // outright (it IS the resulting installation id); otherwise derive one
      // from the stash path the same way a fresh install would.
      const bundleId = options.bundleId ?? deriveInstallations([{ path: stashDir, writable: true }])[0]?.id;
      if (!bundleId) throw new Error(`Could not derive bundle provenance for ${stashDir}`);

      const db = openExistingDatabase(dbPath);
      try {
        db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
        // An absent or empty index is skipped on purpose — bootstrap belongs
        // to the first read (`ensureIndex`) or an explicit `akm index`.
        if (getEntryCount(db) === 0) return true;

        // Stage-2 stub glue only (see reconcile.ts's header) — B1's real
        // `reconcilePaths` is expected to resolve a bundle's root itself.
        registerStashRootForBundleId(bundleId, stashDir);
        await reconcilePaths(db, files, bundleId);

        try {
          const config = loadConfig();
          // Stage-2 stub glue only: the real query is "unit hashes reachable
          // from an entry at one of these paths via entry_units" once B1's
          // content-addressed tables exist; the stub records them directly.
          const onlyHashes = unitHashesForPaths(files);
          await drainEmbeddingQueue(db, config, { onlyHashes });
        } catch (drainError) {
          // Best-effort: the write is already lexically searchable via
          // reconcilePaths above. The embedding queue is durable, so a
          // failed drain here is not a failure of this call — see the
          // return-contract note above.
          warnVerbose(
            "Write-path embedding drain skipped (vectors appear after the next drain):",
            drainError instanceof Error ? drainError.message : String(drainError),
          );
        }
        return true;
      } finally {
        closeDatabase(db);
      }
    })();
  } catch (error) {
    // A permission fault is the one failure the next full index will NOT heal,
    // so it does not get the verbose-only treatment the other skips do: fail
    // open (the caller's write still stands) but say so where an operator can
    // see it (#791).
    if (isDataDirUnreadableError(error)) {
      warn(
        `Write-path index update skipped — ${error.message} The asset will not appear in search until that is fixed.`,
      );
      return false;
    }
    warnVerbose(
      "Write-path index update skipped (asset appears after the next full index):",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
