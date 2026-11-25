// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The index operation for files akm did not write through the facade (§7.3): a person or a host edited them as files (the
 * Desktop Files view), or a writer that has not moved to the facade wrote them. Their rows are recorded by the bundle's own
 * adapter, as the rows of akm's own writes are.
 */

import path from "node:path";
import { openUsableIndex } from "../../indexer/index-readiness";
import { closeDatabase } from "../../storage/repositories/index-connection";
import { toPosix } from "../common";
import { isDataDirUnreadableError } from "../errors";
import { warn, warnVerbose } from "../warn";
import { readFrom } from "./asset";
import { type BundleAddress, bundleFor } from "./bundle";
import { embedPendingWrites, forgetIndexedAsset, refreshIndexedAsset } from "./index-rows";

// asset-io: files-view the path rules the Desktop workspace types and guards a place in a bundle by
export { isProtectedPlace, managedFolderOf, placeTypeOf, protectedTypeOf } from "../adapter/directory/place-rules";
// asset-io: files-view whether a path the Files view copies is a file
export { isFileOrFileSymlink } from "../adapter/directory/walker";
// asset-io: files-view the containment check of a plain-file write (`write-source.ts`)
export { assertLinksLeadInside } from "../adapter/directory-adapter";

/**
 * Refresh the existing index for `files` (absolute paths inside the directory bundle `bundle`) written as plain files:
 * the row of each asset they hold is recorded again, and the row of one that is gone is dropped. What a full walk would
 * not list is not an asset, so it is not indexed. Fail-open: `false` when the index could not be updated, never a throw
 * for an index that is absent or busy or a bundle that is unknown.
 */
export async function indexFiles(bundle: BundleAddress, files: string[]): Promise<boolean> {
  let held: ReturnType<typeof bundleFor>;
  try {
    held = bundleFor(bundle);
  } catch {
    // A bundle that is not configured has no index to refresh.
    return false;
  }
  const root = held.root;
  if (root === undefined) return false;
  try {
    // An index akm may not read is not "nothing to update": it is said where an operator can see it (#791), and is `false`.
    const usable = openUsableIndex(root, { readOnly: true });
    if (usable) closeDatabase(usable.db);
  } catch (error) {
    if (isDataDirUnreadableError(error)) {
      warn(`Index update skipped — ${error.message} The asset will not appear in search until that is fixed.`);
      return false;
    }
  }
  try {
    for (const file of files) {
      const key = toPosix(path.relative(root, file));
      const conceptId = key === "" || key.startsWith("..") ? null : held.identifyKey(key);
      if (conceptId === null) continue;
      const asset = readFrom(held, conceptId);
      if (asset) refreshIndexedAsset(asset);
      else forgetIndexedAsset(held, conceptId);
    }
    await embedPendingWrites();
    return true;
  } catch (error) {
    if (isDataDirUnreadableError(error)) {
      warn(`Index update skipped — ${error.message} The asset will not appear in search until that is fixed.`);
    } else {
      warnVerbose("Index update skipped (the asset appears after the next full index):", error);
    }
    return false;
  }
}
