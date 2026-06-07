// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Same-path re-export shim (#490 reorg, Phase 6). asset-spec.ts moved into
// core/asset/asset-spec.ts as part of the core/asset/ nest. This shim keeps the
// historical core/asset-spec import path byte-diff-free for its high fan-in
// external importers (23 sites). Explicit named re-exports only (never
// `export *`), one level; retire once aliases are universal.

export type { AssetSpec } from "./asset/asset-spec";
export {
  ASSET_SPECS,
  deregisterAssetType,
  deriveCanonicalAssetName,
  deriveCanonicalAssetNameFromStashRoot,
  getAssetTypes,
  isRelevantAssetFile,
  registerAssetType,
  resolveAssetPathFromName,
  SCRIPT_EXTENSIONS,
  TYPE_DIRS,
} from "./asset/asset-spec";
