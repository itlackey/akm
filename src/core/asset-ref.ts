// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Same-path re-export shim (#490 reorg, Phase 6). asset-ref.ts moved into
// core/asset/asset-ref.ts as part of the core/asset/ nest. This shim keeps the
// historical core/asset-ref import path byte-diff-free for its high fan-in
// external importers (29 sites). Explicit named re-exports only (never
// `export *`), one level; retire once aliases are universal.

export type { AssetRef } from "./asset/asset-ref";
export { makeAssetRef, parseAssetRef, refToString } from "./asset/asset-ref";
