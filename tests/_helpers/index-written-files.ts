// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What a test that wrote files by hand does to have them indexed: `indexFiles` for the bundle at the stash directory. */

import { indexFiles } from "../../src/core/assets/files";
import { materialiseBundleDir } from "../../src/core/bundle-at-dir";

export async function indexWrittenAssets(
  stashDir: string,
  files: string[],
  options: { bundleId?: string } = {},
): Promise<boolean> {
  return indexFiles(options.bundleId ?? materialiseBundleDir(stashDir), files);
}
