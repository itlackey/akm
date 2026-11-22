// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Create or delete one asset in a source through the asset facade, as a test would to set up a bundle. No commit runs. */

import type { AssetRef } from "../../src/core/asset/resolve-ref";
import { conceptIdFromTypeName, displayRef } from "../../src/core/asset/resolve-ref";
import { writeAssets } from "../../src/core/assets/write";
import type { SourceConfigEntry } from "../../src/core/config/config";
import { fileOfChange, type WriteTargetSource } from "../../src/core/write-source";

export async function writeAssetToSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
  content: string,
): Promise<{ path: string; ref: string }> {
  const change = writeAssets({ source, config }, { purpose: "test-write" }, (w) =>
    w.create({ type: ref.type, name: ref.name, content }),
  );
  return { path: fileOfChange(change, source), ref: displayRef({ conceptId: change.conceptId, bundleId: ref.origin }) };
}

export async function deleteAssetFromSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
): Promise<{ path?: string; ref: string }> {
  const conceptId = conceptIdFromTypeName(ref.type, ref.name);
  const change = writeAssets({ source, config }, { purpose: "test-delete" }, (w) => w.delete(conceptId));
  return {
    ...(change.file !== undefined ? { path: change.file } : {}),
    ref: displayRef({ conceptId, bundleId: ref.origin }),
  };
}
