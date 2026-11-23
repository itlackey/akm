// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Create or delete one asset in a source through the asset facade, as a test would to set up a bundle. No commit runs. */

import path from "node:path";
import { assetPathForName, stashDirFor } from "../../src/core/asset/asset-placement";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import type { AssetRef } from "../../src/core/asset/resolve-ref";
import { conceptIdFromTypeName, displayRef } from "../../src/core/asset/resolve-ref";
import { readAsset } from "../../src/core/assets/read";
import { writeAssets } from "../../src/core/assets/write";
import type { SourceConfigEntry } from "../../src/core/config/config";
import type { WriteTargetSource } from "../../src/core/write-source";
import { configureBundles } from "./bundle-config";

export async function writeAssetToSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
  content: string,
): Promise<{ path: string; ref: string }> {
  const change = writeAssets({ source, config }, { purpose: "test-write" }, (w) =>
    w.create({ type: ref.type, name: ref.name, content }),
  );
  const { conceptId } = parseBundleRef(change.ref);
  return {
    path: readAssetIn(source, conceptId)?.entry.file ?? placedPath(source, ref),
    ref: displayRef({ conceptId, bundleId: ref.origin }),
  };
}

export async function deleteAssetFromSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
): Promise<{ path?: string; ref: string }> {
  const conceptId = conceptIdFromTypeName(ref.type, ref.name);
  const path = readAssetIn(source, conceptId)?.entry.file;
  writeAssets({ source, config }, { purpose: "test-delete" }, (w) => w.delete(conceptId));
  return {
    ...(path !== undefined ? { path } : {}),
    ref: displayRef({ conceptId, bundleId: ref.origin }),
  };
}

/** Where a new asset of `ref` is placed in a directory bundle, for one the walk does not reach (a git-ignored file, §0.2 A6): no read finds it, so the path comes from placement. */
function placedPath(source: WriteTargetSource, ref: AssetRef): string {
  const typeDir = stashDirFor(ref.type) as string;
  return assetPathForName(ref.type, path.join(source.path, typeDir), ref.name);
}

/** The asset in a write target's bundle, which a test has not configured: make it the config's bundle first. */
function readAssetIn(source: WriteTargetSource, conceptId: string) {
  const [id] = configureBundles([
    { path: source.path, registryId: source.name, ...(source.adapterId ? { adapterId: source.adapterId } : {}) },
  ]);
  return readAsset(id as string, conceptId);
}
