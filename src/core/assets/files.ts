// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The Desktop Files view's one index operation (§7.3): files of a directory bundle that a person or a host edited
 * as files are recorded in the index by the bundle's own adapter.
 */

import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { bundleFor } from "./bundle";

/**
 * Refresh the existing index for `files` (absolute paths inside the directory bundle `bundle`) just written as plain
 * files. Fail-open: `false` when the index could not be updated, never a throw for an index that is absent or busy.
 */
export function indexFiles(bundle: string, files: string[]): Promise<boolean> {
  return indexWrittenAssets(bundleFor(bundle).root, files, { bundleId: bundle });
}
