// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared materialization skeleton for mirror caches (git repos, website
 * snapshots). A marker file records that the mirror was materialized on this
 * host and its mtime records the last successful refresh. A usable
 * materialized mirror is served as-is: age never triggers a refresh. Only a
 * missing marker, an unusable mirror, or `force` (`akm bundle update`) does.
 * A failed refresh is reported, never masked: the refresh implementations
 * leave the previous copy on disk, so search keeps serving it, but the caller
 * sees the error.
 */

import fs from "node:fs";

export interface FreshnessCacheOptions {
  /** Marker file whose mtime records the last successful refresh. */
  markerPath: string;
  /** Refresh even when the mirror is already materialized. */
  force?: boolean;
  /**
   * Extra gate the cached copy must pass before it is served without a
   * refresh (e.g. "extracted content is present"). Defaults to always-usable.
   */
  isUsable?: () => boolean;
  /**
   * Perform the refresh (clone/pull/scrape) and rewrite the marker file on
   * success. A throw propagates to the caller.
   */
  refresh: () => Promise<void>;
}

/**
 * Run the materialized → refresh ladder around `refresh()`. Resolves when the
 * cached copy is usable as-is or has just been refreshed; a failed refresh
 * rethrows its error.
 */
export async function withFreshnessCache(options: FreshnessCacheOptions): Promise<void> {
  const usable = options.isUsable ?? (() => true);

  let materialized = false;
  try {
    fs.statSync(options.markerPath);
    materialized = true;
  } catch {
    /* no marker — never successfully refreshed */
  }

  if (!options.force && materialized && usable()) {
    return;
  }

  await options.refresh();
}
