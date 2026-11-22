// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where a proposal's write goes, as a file. A proposal is a file envelope (`FileChange`): its change names the
 * file the asset is kept in, and a new asset's file is where its type is placed. The bundle's adapter says
 * whether the asset exists and where it is; a new asset's file is the type's placement, which a bundle whose
 * adapter does not write that type is still given, so the write is refused where it is made.
 */

import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, parsePlacementRef } from "../../core/asset/resolve-ref";
import { addressOf } from "../../core/assets/write";
import { slugForPath } from "../../core/bundle-id";

/** Where a write to a ref goes: its type and name, its ref, and its file. */
export interface WriteAddress extends AssetRef {
  conceptId: string;
  /** Undefined only for a new asset of a type that places nowhere. */
  path: string | undefined;
}

/**
 * The address a write to `raw` uses in the bundle at `root` (`source` names it and its adapter, else its path does). An asset that
 * exists is addressed by its ref, wherever its file sits, and takes its type from it; its ref in the outdated
 * type-folder spelling finds it too, with a warning. Only a new asset is placed: its ref's first folder names the
 * type whose folder it goes in.
 */
export function resolveProposalAddress(
  root: string,
  raw: string,
  source: { name: string; adapterId?: string } = { name: slugForPath(root) },
): WriteAddress {
  try {
    const address = addressOf({ ...source, path: root }, raw);
    const { exists, file, ...rest } = address;
    return { ...rest, path: exists ? file : placedFile(root, address.type, address.name) };
  } catch {
    // The adapter does not place this ref (a type it does not write, or a type that has no folder): an invalid ref
    // is still refused here, and any other asset is addressed by the type's placement.
    const placed = parsePlacementRef(raw);
    const { bundle: origin, conceptId } = parseBundleRef(raw);
    return {
      ...placed,
      conceptId,
      ...(origin !== undefined ? { origin } : {}),
      path: placedFile(root, placed.type, placed.name),
    };
  }
}

function placedFile(root: string, type: string, name: string): string | undefined {
  const typeDir = stashDirFor(type);
  return typeDir === undefined ? undefined : assetPathForName(type, path.join(root, typeDir), name);
}
