// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Asset-type registration facade.
 *
 * The pure recognition/placement surface (`AssetSpec`, `ASSET_SPECS`,
 * `TYPE_DIRS`, and the derive/resolve helpers) now lives in the
 * `asset-placement.ts` leaf — extracted in chunk-3 so the `akm` bundle adapter
 * can consume placement without importing this module, which is a taxonomy
 * import-cycle (SCC) participant via `asset-registry`. This module re-exports
 * that surface unchanged and layers on the runtime type-registration API that
 * wires a custom type's renderer/action into the `asset-registry` singleton.
 */

import { type AssetSpec, deregisterAssetSpec, registerAssetSpec } from "./asset-placement";
import { registerActionBuilder, registerTypeRenderer } from "./asset-registry";

export type { AssetSpec } from "./asset-placement";
export {
  ASSET_SPECS,
  deriveCanonicalAssetName,
  deriveCanonicalAssetNameFromStashRoot,
  getAssetTypes,
  isRelevantAssetFile,
  resolveAssetPathFromName,
  TYPE_DIRS,
} from "./asset-placement";

/**
 * Register a custom asset type with the akm asset system.
 *
 * ## Full extension registration API
 *
 * Providing `rendererName` and/or `actionBuilder` in the spec automatically
 * registers the renderer and action builder so that search results and `show`
 * output work out of the box without additional calls.
 *
 * ### Minimal registration (filesystem layout only)
 * ```ts
 * registerAssetType("widget", {
 *   stashDir: "widgets",
 *   isRelevantFile: (f) => f.endsWith(".widget"),
 *   toCanonicalName: (root, fp) => path.basename(fp, ".widget"),
 *   toAssetPath: (root, name) => path.join(root, `${name}.widget`),
 * });
 * ```
 *
 * ### Full registration (filesystem + renderer + action)
 * ```ts
 * registerAssetType("widget", {
 *   stashDir: "widgets",
 *   isRelevantFile: (f) => f.endsWith(".widget"),
 *   toCanonicalName: (root, fp) => path.basename(fp, ".widget"),
 *   toAssetPath: (root, name) => path.join(root, `${name}.widget`),
 *   rendererName: "widget-md",
 *   actionBuilder: (ref) => `akm show ${ref} -> use widget`,
 * });
 * ```
 *
 * The filesystem layout lands in the `asset-placement` leaf; renderer and
 * action builder registration is handled directly via the `asset-registry`
 * singleton — no deferred hooks or import-order concerns.
 */
export function registerAssetType(type: string, spec: AssetSpec): void {
  registerAssetSpec(type, spec);

  // Auto-register renderer and action builder if provided in spec
  if (spec.rendererName) {
    registerTypeRenderer(type, spec.rendererName);
  }
  if (spec.actionBuilder) {
    registerActionBuilder(type, spec.actionBuilder);
  }
}

/**
 * Remove a previously-registered asset type.
 *
 * Primarily used by tests for cleanup after `registerAssetType` calls so
 * subsequent tests see a pristine type registry. Built-in types should not
 * normally be deregistered at runtime.
 */
export function deregisterAssetType(type: string): void {
  deregisterAssetSpec(type);
}
