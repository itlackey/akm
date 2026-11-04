// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { TransientError } from "../core/errors";
import { withAssetMutationLease } from "../indexer/index-writer-lock";

/** An interactive request waits only this long for another writer, then fails with `ASSET_MUTATION_LEASE_HELD`. */
const INTERACTIVE_LEASE_WAIT_MS = 3000;

/**
 * Run a write the owner is waiting on under the asset-mutation lease, failing fast when another akm process holds it
 * (the default wait is ten minutes: a hung button). The domain functions called inside take the same lease and
 * inherit this one, so the short wait applies to them too and there is no check-then-act probe.
 */
export function interactive<T>(purpose: string, run: () => Promise<T>): Promise<T> {
  return withAssetMutationLease(purpose, run, { maxWaitMs: INTERACTIVE_LEASE_WAIT_MS }).catch((error) => {
    if (error instanceof TransientError && error.code === "ASSET_MUTATION_LEASE_HELD")
      throw new TransientError(
        "Another akm process or request is writing to the bundle right now. Try again in a moment.",
        "ASSET_MUTATION_LEASE_HELD",
      );
    throw error;
  });
}
