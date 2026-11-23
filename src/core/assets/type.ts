// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The type of an asset. Finding and listing an asset says where it is, never what it is: a type is index metadata the
 * adapter gives (`recognize`) and the index records, so every read of a type comes from the index. An asset with no
 * index row yet (a file added outside akm) is indexed on that first ask: one `recognize`, one upsert. A row is
 * refreshed by `akm index` and by akm's own writes; only a gate that runs or renders the asset ({@link assetTypeFresh})
 * checks it against the file's bytes, which it reads anyway.
 */

import path from "node:path";
import { openUsableIndex, readUsableIndex } from "../../indexer/index-readiness";
import { withAssetMutationLeaseSync } from "../../indexer/index-writer-lock";
import { upsertIndexRows, WRITE_PATH_INDEX_BUSY_TIMEOUT_MS } from "../../indexer/index-written-assets";
import { embeddingInputCap } from "../../indexer/materialize-embeddings";
import { brokenWorkflowWarning, indexRowEntry } from "../../indexer/scan/drain-dir";
import type { SearchSource } from "../../indexer/search/search-source";
import { fileContextOfEntry } from "../../indexer/walk/file-context";
import { closeDatabase } from "../../storage/repositories/index-connection";
import { deleteEntriesByIds } from "../../storage/repositories/index-entries-repository";
import { hashContent } from "../adapter/adapters/shared";
import { adapterIdOf } from "../adapter/detect-adapter";
import type { IndexDocument } from "../adapter/types";
import { loadConfig } from "../config/config";
import { NotFoundError } from "../errors";
import { isPathAbsent } from "../path-access";
import { getDbPath } from "../paths";
import { warnVerbose } from "../warn";
import { type Asset, sourceOf } from "./asset";
import { assetBundleOf } from "./bundle";

/**
 * Recognize each of `assets` once and, when `persist` is set and a usable index serves their bundles, record the rows:
 * the rows `akm index` would write for them, without their embeddings (the next index adds those), through one
 * connection. A failure to record them is not a failure to say what the assets are.
 */
export function indexAssets(
  assets: readonly Asset[],
  options: { persist: boolean } = { persist: true },
): Map<Asset, IndexDocument> {
  const documents = new Map<Asset, IndexDocument>();
  for (const asset of assets) {
    const source = sourceOf(asset);
    const document = assetBundleOf({
      name: asset.bundle,
      path: source.path,
      ...(source.location !== undefined ? { location: source.location } : {}),
      adapterId: adapterIdOf(source),
    }).recognize(asset.entry);
    if (!document?.conceptId) throw new NotFoundError(`Asset not found: ${asset.ref}`, "ASSET_NOT_FOUND");
    // No file holds the asset (a keyring's or vault's): the row is keyed under a path that leads nowhere, and says so.
    if (document.path === undefined) document.fileless = true;
    documents.set(asset, document);
  }
  if (options.persist && assets.length > 0) record(documents);
  return documents;
}

/** {@link indexAssets} for one asset. */
export function indexAsset(asset: Asset, options: { persist: boolean } = { persist: true }): IndexDocument {
  return indexAssets([asset], options).get(asset) as IndexDocument;
}

/** Write the index rows of `documents`, when a usable index serves them. */
function record(documents: ReadonlyMap<Asset, IndexDocument>): void {
  // No index, nothing to write, and no lock file made either.
  if (isPathAbsent(getDbPath())) return;
  try {
    // The index-writer lock the indexer takes; held by a running rebuild, nothing is written (no waiting).
    withAssetMutationLeaseSync("index-asset", () => write(documents), { maxWaitMs: 0 });
  } catch (error) {
    warnVerbose("Index update skipped (the assets are indexed by the next `akm index`):", error);
  }
}

function write(documents: ReadonlyMap<Asset, IndexDocument>): void {
  {
    const first = documents.keys().next().value as Asset;
    const usable = openUsableIndex(sourceOf(first).path, { busyTimeoutMs: WRITE_PATH_INDEX_BUSY_TIMEOUT_MS });
    if (!usable) return;
    try {
      const { db } = usable;
      const cap = embeddingInputCap(loadConfig());
      db.transaction(() => {
        for (const [asset, document] of documents) {
          const source = sourceOf(asset);
          // The scan drops a workflow that does not compile, so no ask of it records a row either.
          if (brokenWorkflowWarning(document, fileContextOfEntry(source.path, asset.entry)) !== null) continue;
          upsertIndexRows(
            db,
            { bundleId: asset.bundle, adapterId: adapterIdOf(source) },
            [
              {
                // The path the index keys the asset under: its file, else (no file holds it) a path inside the bundle.
                file: asset.entry.file ?? path.join(source.path, asset.entry.relPath),
                entry: indexRowEntry(document, path.basename(asset.entry.relPath)),
                conceptId: document.conceptId as string,
                contentHash: document.hash,
                hasFile: asset.entry.file !== undefined,
              },
            ],
            cap,
          );
        }
      })();
    } finally {
      closeDatabase(usable.db);
    }
  }
}

/**
 * Take the row of one ref out of the index (an asset deleted or retired), under the same lock and with the same
 * fail-open rule as a write of a row.
 */
export function forgetIndexedAsset(source: SearchSource, bundle: string, conceptId: string): void {
  if (isPathAbsent(getDbPath())) return;
  try {
    withAssetMutationLeaseSync(
      "index-asset",
      () => {
        const usable = openUsableIndex(source.path, { busyTimeoutMs: WRITE_PATH_INDEX_BUSY_TIMEOUT_MS });
        if (!usable) return;
        try {
          const rows = usable.db.prepare("SELECT id FROM entries WHERE item_ref = ?").all(`${bundle}//${conceptId}`);
          deleteEntriesByIds(
            usable.db,
            (rows as Array<{ id: number }>).map((row) => row.id),
          );
        } finally {
          closeDatabase(usable.db);
        }
      },
      { maxWaitMs: 0 },
    );
  } catch (error) {
    warnVerbose("Index update skipped (the next `akm index` drops the row):", error);
  }
}

/** Record the row of one asset that akm wrote: the same refresh a miss in {@link assetType} makes. */
export function refreshIndexedAsset(asset: Asset): void {
  try {
    indexAsset(asset);
  } catch (error) {
    warnVerbose(`Index update for ${asset.ref} skipped:`, error);
  }
}

/** The freshness-variant prefix (adapter id and version) of the adapter that holds `asset`. */
function variantPrefixOf(asset: Asset): string {
  const source = sourceOf(asset);
  return assetBundleOf({
    name: asset.bundle,
    path: source.path,
    ...(source.location !== undefined ? { location: source.location } : {}),
    adapterId: adapterIdOf(source),
  }).variantPrefix;
}

/** The types of `assets`: their index rows', read through one connection; an asset with no row is indexed first. */
export function assetTypes(assets: readonly Asset[]): Map<Asset, string> {
  const types = new Map<Asset, string>();
  if (assets.length === 0) return types;
  const indexed = readUsableIndex(
    (db) => {
      const find = db.prepare("SELECT type, file_path FROM entries WHERE item_ref = ?");
      const variant = db.prepare("SELECT index_variant FROM index_dir_state WHERE dir_path = ?");
      return assets.map((asset) => {
        const row = find.get(asset.ref) as { type: string; file_path: string } | undefined;
        if (!row) return undefined;
        // A row an older adapter version described is a miss: that one ref is described again.
        const recorded = (variant.get(path.dirname(row.file_path)) as { index_variant: string | null } | undefined)
          ?.index_variant;
        return recorded && !recorded.startsWith(variantPrefixOf(asset)) ? undefined : row.type;
      });
    },
    assets.map(() => undefined),
  );
  const missing = assets.filter((_, position) => indexed[position] === undefined);
  const documents = indexAssets(missing);
  for (const [position, asset] of assets.entries()) {
    types.set(asset, indexed[position] ?? (documents.get(asset) as IndexDocument).type);
  }
  return types;
}

/**
 * The type of `asset`, from the index. Rule: a row is the type unless it is missing or an older adapter version
 * described it; then that one ref is indexed first (one `recognize`, one upsert). The write needs the index-writer lock
 * the indexer takes: with a rebuild holding it, or an index that cannot be written, nothing is refreshed and the type
 * is what `recognize` says for this call alone. No other read of the file's bytes is made.
 */
export function assetType(asset: Asset): string {
  return assetTypes([asset]).get(asset) as string;
}

/**
 * The type of `asset` for a gate that runs or renders it: those read its bytes anyway, so the type is checked against
 * them. A row whose content hash is not the asset's current one (an edit made outside akm, such as `agent:` added to a
 * loose `.md`) is described again first, as {@link assetType} does for a missing row, so the run sees the type the
 * next index would give. An asset no file holds is typed by its row alone: there are no bytes to check.
 */
export function assetTypeFresh(asset: Asset): string {
  if (asset.entry.file === undefined) return assetType(asset);
  const recorded = readUsableIndex(
    (db) =>
      db.prepare("SELECT content_hash FROM entries WHERE item_ref = ?").get(asset.ref) as
        | { content_hash: string | null }
        | undefined,
    undefined,
  );
  if (recorded?.content_hash === hashContent(asset.entry.content())) return assetType(asset);
  return indexAsset(asset).type;
}
