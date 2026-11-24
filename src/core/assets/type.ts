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
import { readUsableIndex } from "../../indexer/index-readiness";
import { brokenWorkflowWarning } from "../../indexer/scan/drain-dir";
import { bundleVariantKey, getMeta } from "../../storage/repositories/index-meta-repository";
import { hashContent } from "../adapter/adapters/shared";
import type { AssetEntry } from "../adapter/bundle-adapter";
import { fileContextOfEntry, type MatchResult } from "../adapter/directory/file-context";
import { recognizeMatch } from "../adapter/recognize-match";
import { adapterForId } from "../adapter/registry";
import type { IndexDocument } from "../adapter/types";
import { parseFrontmatter } from "../asset/frontmatter";
import { toPosix } from "../common";
import { presentationFor } from "../type-presentation";
import { type Asset, bundleHolding } from "./asset";
import { bundleFor } from "./bundle";
import { indexAsset, indexAssets } from "./index-rows";

export { embedPendingWrites, indexAsset, indexedPathOf } from "./index-rows";

/** The freshness-variant prefix (adapter id and version) of the adapter that holds `asset`. */
function variantPrefixOf(asset: Asset): string {
  return bundleHolding(asset).variantPrefix;
}

/** The types of `assets`: their index rows', read through one connection; an asset with no row is indexed first. */
export function assetTypes(assets: readonly Asset[]): Map<Asset, string> {
  const types = new Map<Asset, string>();
  if (assets.length === 0) return types;
  const indexed = readUsableIndex(
    (db) => {
      const find = db.prepare("SELECT type FROM entries WHERE item_ref = ?");
      return assets.map((asset) => {
        const row = find.get(asset.ref) as { type: string } | undefined;
        if (!row) return undefined;
        // A row an older adapter version described is a miss: that one ref is described again.
        const recorded = getMeta(db, bundleVariantKey(asset.bundle));
        return recorded && !recorded.startsWith(variantPrefixOf(asset)) ? undefined : row.type;
      });
    },
    assets.map(() => undefined),
  );
  const missing = assets.filter((_, position) => indexed[position] === undefined);
  const documents = indexAssets(missing, { persist: true, onMiss: true });
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
  return indexAsset(asset, { persist: true, onMiss: true }).type;
}

/**
 * What the adapter of `bundle` makes of `content` as the text stored under `key` (the path inside a directory bundle),
 * for a caller that holds text which is not saved (the workspace's check of an edit): the type it would be indexed
 * under, and, when the index would drop it (a workflow that does not compile), the warning the scan gives. Nothing is
 * read from the bundle or stored. Null: the adapter holds no asset there.
 */
export function recognizeContent(
  bundle: string,
  key: string,
  content: string,
): { type: string; dropped?: string } | null {
  const entry: AssetEntry = {
    key,
    content: () => content,
    bytes: () => Buffer.from(content),
    frontmatter: () => {
      const { data } = parseFrontmatter(content);
      return Object.keys(data).length > 0 ? data : null;
    },
  };
  let document: IndexDocument | null;
  try {
    document = bundleFor(bundle).recognize(entry);
  } catch {
    // A path the adapter places but whose content it cannot describe is no asset.
    return null;
  }
  if (!document?.conceptId) return null;
  const dropped = brokenWorkflowWarning(document, { content: entry.content, relPath: key, absPath: key });
  return { type: document.type, ...(dropped !== null ? { dropped } : {}) };
}

/** The type the adapter of `bundle` gives `content` stored under `key`, or null when it holds no asset there. */
export function typeOfContent(bundle: string, key: string, content: string): string | null {
  return recognizeContent(bundle, key, content)?.type ?? null;
}

/**
 * The type each of `assets` has by its bytes, when its adapter can say it, as the next `akm index` would give it, for a check that
 * holds the bytes it reads and must change nothing (`akm lint`): no index is read or written, and nothing is described
 * but the type, so the answer is {@link assetTypeFresh}'s whatever the index holds. An asset akm does not type has none.
 */
export function assetTypesByContent(assets: readonly Asset[]): Map<Asset, string | undefined> {
  return new Map(assets.map((asset) => [asset, bundleHolding(asset).contentType(asset.entry)]));
}

/**
 * How `akm show` presents an asset whose index row says `row`: `"projection"` when its adapter presents it itself,
 * else the renderer the row's adapter names for the type (`rendererFor`). An adapter that names none has the asset
 * matched live, on the bytes the file has now (so an edit made outside akm is shown as the next index would type it), as
 * is a row that records no adapter. `null`: nothing claims the asset.
 */
export function presentationOf(
  asset: Asset,
  row: { type: string; adapterId?: string; ownsPresentation?: boolean },
): MatchResult | "projection" | null {
  if (row.ownsPresentation === true) return "projection";
  const adapter = row.adapterId === undefined ? undefined : adapterForId(row.adapterId);
  // A row an adapter akm no longer has wrote is rendered as its type is.
  const renderer =
    row.adapterId === undefined
      ? undefined
      : adapter
        ? adapter.rendererFor(row.type)
        : presentationFor(row.type).renderer;
  if (renderer !== undefined) {
    return { type: row.type, specificity: Number.MAX_SAFE_INTEGER, renderer };
  }
  return recognizeMatch(fileContextOfEntry(bundleHolding(asset).root, asset.entry));
}

/**
 * The type the folder an indexed file sits in declares for it (`memories/` declares memory), from the folder rules alone:
 * no bytes are read and the row's type is not asked. Only an akm bundle's folders declare types; a file outside the bundle
 * root, or in a folder that declares none, has no declared type.
 */
export function typeDeclaredByLocation(file: { adapterId: string; root: string; path: string }): string | undefined {
  const adapter = adapterForId(file.adapterId);
  if (!adapter?.declaredType || !file.root) return undefined;
  const rel = path.relative(file.root, file.path);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return adapter.declaredType(toPosix(rel));
}
