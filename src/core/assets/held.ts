// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a bundle keeps at a stored key, for the checks that resolve a path they were handed (lint's reachability rules
 * for a ref). The facade does no file access and knows no layout: each call is the directory layer's, asked of the
 * bundle at `bundle.path` (`directory/held-files`). They answer from what the bundle keeps, not from what its adapter
 * recognizes: `missing-ref` has always counted a file no adapter lists as an asset.
 */

import * as held from "../adapter/directory/held-files";

export { MEMORY_ARCHIVE_REL } from "../adapter/directory/held-files";

/** The bundle a check asks about: its directory. */
interface HeldBundle {
  path: string;
}

/** Whether the bundle keeps a file at the bundle-relative `key`. */
export function holdsFile(bundle: HeldBundle, key: string): boolean {
  return held.holdsFile(bundle.path, key);
}

/** Whether the bundle retired the asset that was kept at `key`. */
export function isRetired(bundle: HeldBundle, key: string): boolean {
  return held.isRetired(bundle.path, key);
}

/** The names of the folders directly inside the bundle's folder `key`. */
export function heldFolders(bundle: HeldBundle, key: string): string[] {
  return held.heldFolders(bundle.path, key);
}

/** The files below the bundle's folder `key` that `accept` takes by name: absolute paths. */
export function heldFilesBelow(bundle: HeldBundle, key: string, accept: (name: string) => boolean): string[] {
  return held.heldFilesBelow(bundle.path, key, accept);
}

/** The text of a file of the bundle that no adapter lists as an asset (`heldFilesBelow` found it). */
export function heldText(file: string): string {
  return held.heldText(file);
}

/** Save the text of a file of the bundle that no adapter lists as an asset, as it lies. */
export function saveHeldText(file: string, text: string): void {
  held.saveHeldText(file, text);
}

/** Throws when this process may not write `file` (see `directory/held-files`). */
export function assertFileWritable(file: string): void {
  held.assertFileWritable(file);
}
