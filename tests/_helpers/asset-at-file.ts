// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { stashDirNames } from "../../src/core/asset/asset-placement";
import { type Asset, assetAtKey } from "../../src/core/assets/read";
import { bundleAt } from "../../src/core/bundle-at-dir";

/** The asset the file `file` holds, in the stash directory above its type folder (`<stash>/memories/x.md`). */
export function assetAtFile(file: string): Asset | undefined {
  const parts = path.resolve(file).split(path.sep);
  let typeFolder = parts.length - 2;
  while (typeFolder > 0 && !stashDirNames().includes(parts[typeFolder] as string)) typeFolder -= 1;
  if (typeFolder < 1) return undefined;
  return assetAtKey(bundleAt(parts.slice(0, typeFolder).join(path.sep)), parts.slice(typeFolder).join("/"));
}

/** A ref-to-asset seam (distill's `lookupFn`) from one that names the asset's file; `null`: no asset. */
export function byFile(find: (ref: string) => Promise<string | null>): (ref: string) => Promise<Asset | undefined> {
  return async (ref) => {
    const file = await find(ref);
    return file === null ? undefined : assetAtFile(file);
  };
}
