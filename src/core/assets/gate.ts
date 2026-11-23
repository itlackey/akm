// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What a bundle's adapter writes, for callers that decide before they write. `bundle.ts` itself stays inside the facade. */

import type { UsageErrorCode } from "../errors";
import { assetBundleOf } from "./bundle";

type GateSource = { name: string; path: string; location?: string; adapterId?: string };

/**
 * Refuse an asset write the bundle's adapter does not make: an adapter that writes nothing, or (with `type`) one
 * that does not write assets of that type.
 */
export function assertAdapterWrites(source: GateSource, type?: string): void {
  assetBundleOf(source).assertWrites(type);
}

/** Whether the bundle's adapter writes assets of `type`: it holds them as its own, not as files it reads. */
export function adapterWrites(source: GateSource, type: string): boolean {
  return assetBundleOf(source).writes(type);
}

/** Refuse with a message naming the bundle and its adapter: `Bundle "x" uses adapter "y", which <what>.` */
export function refuseByAdapter(source: GateSource, what: string, code: UsageErrorCode): never {
  return assetBundleOf(source).refuse(what, code);
}
