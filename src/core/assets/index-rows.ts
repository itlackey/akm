// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The index rows of assets akm reads and writes: recognized by their adapters and recorded, refreshed or dropped under
 * the asset-mutation lease, their vectors made after it. The facade's own: `type.ts` re-exports what callers use.
 */

import path from "node:path";
import { addIndexOnMissRefs } from "../../indexer/index-on-miss";
import { openUsableIndex } from "../../indexer/index-readiness";
import { upsertIndexRows, WRITE_PATH_INDEX_BUSY_TIMEOUT_MS } from "../../indexer/index-rows";
import { holdsAssetMutationLease, withAssetMutationLeaseSync } from "../../indexer/index-writer-lock";
import {
  embeddingInputCap,
  generateEmbeddingsForDb,
  publishTargetedEmbeddingMeta,
} from "../../indexer/materialize-embeddings";
import { brokenWorkflowWarning, indexRowEntry } from "../../indexer/scan/drain-dir";
import { closeDatabase } from "../../storage/repositories/index-connection";
import { deleteEntriesByIds } from "../../storage/repositories/index-entries-repository";
import { isSqliteContentionError } from "../../storage/sqlite-transaction";
import { fileContextOfEntry } from "../adapter/directory/file-context";
import type { IndexDocument } from "../adapter/types";
import { loadConfig } from "../config/config";
import { assetNotFound, isDataDirUnreadableError, TransientError } from "../errors";
import { isPathAbsent } from "../path-access";
import { getDbPath } from "../paths";
import { warn, warnVerbose } from "../warn";
import { type Asset, bundleHolding } from "./asset";
import type { AssetBundle } from "./bundle";

function indexLibraryOf(bundle: AssetBundle) {
  return bundle.root ?? { bundleId: bundle.name };
}

/**
 * Recognize each of `assets` once and, when `persist` is set and a usable index serves their bundles, record the rows:
 * the rows `akm index` would write for them, without their embeddings (the next index adds those), through one
 * connection. A failure to record them is not a failure to say what the assets are.
 */
export function indexAssets(
  assets: readonly Asset[],
  options: { persist: boolean; onMiss?: boolean } = { persist: true },
): Map<Asset, IndexDocument> {
  const documents = new Map<Asset, IndexDocument>();
  for (const asset of assets) {
    const document = bundleHolding(asset).recognize(asset.entry);
    if (!document?.conceptId) throw assetNotFound(asset.ref);
    documents.set(asset, document);
  }
  if (options.persist && assets.length > 0) record(documents, options.onMiss ?? false);
  return documents;
}

/** {@link indexAssets} for one asset. */
export function indexAsset(
  asset: Asset,
  options: { persist: boolean; onMiss?: boolean } = { persist: true },
): IndexDocument {
  return indexAssets([asset], options).get(asset) as IndexDocument;
}

/**
 * Write the index rows of `documents`, when a usable index serves them, and say whether they were. `onMiss`: a read
 * found no row for them, so they are marked for the next `akm index`, which still sees each as new (a moved file);
 * akm's own writes are not.
 */
export function record(documents: ReadonlyMap<Asset, IndexDocument>, onMiss: boolean): boolean {
  // No index, nothing to write, and no lock file made either.
  if (isPathAbsent(getDbPath())) return false;
  try {
    // The index-writer lock the indexer takes; held by a running rebuild, nothing is written (no waiting).
    return withAssetMutationLeaseSync("index-asset", () => write(documents, onMiss), { maxWaitMs: 0 });
  } catch (error) {
    // A permission fault is the one failure the next `akm index` will not heal: the write stands, and it is said (#791).
    if (isDataDirUnreadableError(error)) {
      warn(
        `Write-path index update skipped — ${error.message} The asset will not appear in search until that is fixed.`,
      );
    } else {
      warnVerbose("Index update skipped (the assets are indexed by the next `akm index`):", error);
    }
    return false;
  }
}

/**
 * A file has one row. A row another ref holds for the file is replaced when akm wrote the asset through its bundle, and
 * stays when a read found no row for the ref (`onMiss`): bundles whose roots nest share files, and a read must not move
 * a file from one bundle's row to the other's. An asset no file holds (a keyring's) shares no file with any.
 */
function write(documents: ReadonlyMap<Asset, IndexDocument>, onMiss: boolean): boolean {
  {
    const first = documents.keys().next().value as Asset;
    const usable = openUsableIndex(indexLibraryOf(bundleHolding(first)), {
      busyTimeoutMs: WRITE_PATH_INDEX_BUSY_TIMEOUT_MS,
    });
    if (!usable) return false;
    try {
      const { db } = usable;
      const cap = embeddingInputCap(loadConfig());
      db.transaction(() => {
        const written: string[] = [];
        for (const [asset, document] of documents) {
          const held = bundleHolding(asset);
          // The scan drops a workflow that does not compile, so no ask of it records a row either.
          const dropped =
            held.root === undefined
              ? null
              : brokenWorkflowWarning(document, fileContextOfEntry(held.root, asset.entry));
          if (dropped !== null) {
            // An asset akm just wrote that no longer compiles is indexed as the scan would: not at all, so its old row
            // goes, with the scan's warning (F19).
            if (!onMiss) {
              warn(dropped);
              const stale = db.prepare("SELECT id FROM entries WHERE item_ref = ?").all(asset.ref) as Array<{
                id: number;
              }>;
              deleteEntriesByIds(
                db,
                stale.map((row) => row.id),
              );
            }
            continue;
          }
          const file = indexedPathOf(asset);
          if (
            onMiss &&
            file !== "" &&
            db.prepare("SELECT 1 FROM entries WHERE file_path = ? AND item_ref <> ?").get(file, asset.ref)
          ) {
            continue;
          }
          upsertIndexRows(
            db,
            { bundleId: asset.bundle, adapterId: held.adapterId },
            [
              {
                file,
                entry: indexRowEntry(document, path.basename(asset.entry.key)),
                conceptId: document.conceptId as string,
                contentHash: document.hash,
              },
            ],
            cap,
          );
          if (onMiss) written.push(asset.ref);
          // akm's own write: its vector is made after the lease is released (`embedPendingWrites`).
          else pendingEmbeddings.add(held, asset.ref);
        }
        addIndexOnMissRefs(db, written);
      })();
      return true;
    } finally {
      closeDatabase(usable.db);
    }
  }
}

/**
 * The refs whose rows akm's own writes recorded since the last {@link embedPendingWrites}, by the id of the bundle
 * that holds them. A write stays synchronous and holds the lease only for its rows; their vectors are made after.
 */
const pendingEmbeddings = {
  byBundle: new Map<string, { library: ReturnType<typeof indexLibraryOf>; refs: Set<string> }>(),
  add(bundle: AssetBundle, ref: string): void {
    const pending = this.byBundle.get(bundle.name) ?? { library: indexLibraryOf(bundle), refs: new Set<string>() };
    pending.refs.add(ref);
    this.byBundle.set(bundle.name, pending);
  },
  take() {
    const taken = [...this.byBundle.values()];
    this.byBundle.clear();
    return taken;
  },
};

/**
 * Make the vectors of the rows akm's writes have recorded, when semantic search is on. Called outside the lease: by every
 * caller that awaits its writes, and by the CLI dispatcher and the Desktop route wrapper before a command or request
 * ends, which covers every other write. Fail-open: a failure to embed is a verbose-only warning (the next `akm index`
 * makes the vector), a busy index is not a failure, no usable index is nothing to do. The input is the row's text,
 * never a secret's value.
 */
export async function embedPendingWrites(): Promise<void> {
  // A held lease never waits on an embedding call: the queue stays for the caller that releases it (the CLI dispatcher,
  // the Desktop route wrapper).
  if (holdsAssetMutationLease()) return;
  for (const { library, refs } of pendingEmbeddings.take()) {
    try {
      if (isPathAbsent(getDbPath())) continue;
      const config = loadConfig();
      if (config.semanticSearchMode === "off") continue;
      const usable = openUsableIndex(library, { busyTimeoutMs: WRITE_PATH_INDEX_BUSY_TIMEOUT_MS });
      if (!usable) continue;
      try {
        const { db } = usable;
        const find = db.prepare("SELECT id FROM entries WHERE item_ref = ?");
        const ids = [...refs].flatMap((ref) => {
          const row = find.get(ref) as { id: number } | undefined;
          return row ? [row.id] : [];
        });
        if (ids.length === 0) continue;
        await generateEmbeddingsForDb(db, config, () => {}, undefined, ids);
        publishTargetedEmbeddingMeta(db, config);
      } finally {
        closeDatabase(usable.db);
      }
    } catch (error) {
      if (isDataDirUnreadableError(error)) {
        warn(
          `Write-path index update skipped — ${error.message} The asset will not appear in search until that is fixed.`,
        );
      } else if (
        isSqliteContentionError(error) ||
        (error instanceof TransientError && error.code === "INDEX_DB_CONTENDED")
      ) {
        warnVerbose(
          `Write-path index update skipped, the index is busy (asset appears after the next build): ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        warnVerbose("Write-path index update skipped (asset appears after the next full index):", error);
      }
    }
  }
}

/**
 * Take the row of one ref out of the index (an asset deleted or retired), under the same lock and with the same
 * fail-open rule as a write of a row. Says whether the index was updated.
 */
export function forgetIndexedAsset(bundle: AssetBundle, conceptId: string): boolean {
  if (isPathAbsent(getDbPath())) return false;
  try {
    return withAssetMutationLeaseSync(
      "index-asset",
      () => {
        const usable = openUsableIndex(indexLibraryOf(bundle), { busyTimeoutMs: WRITE_PATH_INDEX_BUSY_TIMEOUT_MS });
        if (!usable) return false;
        try {
          const rows = usable.db
            .prepare("SELECT id FROM entries WHERE item_ref = ?")
            .all(`${bundle.name}//${conceptId}`);
          deleteEntriesByIds(
            usable.db,
            (rows as Array<{ id: number }>).map((row) => row.id),
          );
          return true;
        } finally {
          closeDatabase(usable.db);
        }
      },
      { maxWaitMs: 0 },
    );
  } catch (error) {
    warnVerbose("Index update skipped (the next `akm index` drops the row):", error);
    return false;
  }
}

/** Record the row of one asset that akm wrote: the same refresh a miss in {@link assetType} makes. Says whether it was recorded. */
export function refreshIndexedAsset(asset: Asset): boolean {
  try {
    return record(new Map([[asset, indexAsset(asset, { persist: false })]]), false);
  } catch (error) {
    warnVerbose(`Index update for ${asset.ref} skipped:`, error);
    return false;
  }
}

/** The file the index records an asset under; `""` for an asset no file holds (a keyring's or vault's). */
export function indexedPathOf(asset: Asset): string {
  return asset.entry.file ?? "";
}
