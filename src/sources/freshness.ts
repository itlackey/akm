// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared freshness-window skeleton for mirror caches (git repos, website
 * snapshots). A marker file's mtime records the last successful refresh:
 * within `ttlMs` the cached copy is served without refreshing; on refresh
 * failure the cached copy is still served while the marker is younger than
 * `staleMs`, so search stays available through upstream outages.
 */

import fs from "node:fs";
import { isExpired } from "./providers/provider-utils";

export interface FreshnessCacheOptions {
  /** Marker file whose mtime records the last successful refresh. */
  markerPath: string;
  /** Fresh window: a marker younger than this skips the refresh entirely. */
  ttlMs: number;
  /**
   * Stale window: when the refresh fails, a marker younger than this serves
   * the cached copy instead of surfacing the error.
   */
  staleMs: number;
  /** Bypass the fresh check and always refresh (stale fallback still applies). */
  force?: boolean;
  /**
   * Extra gate the cached copy must pass — on both the fresh and the stale
   * path — before it can be served (e.g. "extracted content is present").
   * Defaults to always-usable.
   */
  isUsable?: () => boolean;
  /**
   * Perform the refresh (clone/pull/scrape) and rewrite the marker file on
   * success. A throw here falls back to the stale window.
   */
  refresh: () => Promise<void>;
}

/**
 * Run the fresh → refresh → stale-fallback ladder around `refresh()`.
 * Resolves when the cached copy is usable (fresh, refreshed, or stale-but-
 * within-window); rethrows the refresh error otherwise.
 */
export async function withFreshnessCache(options: FreshnessCacheOptions): Promise<void> {
  const usable = options.isUsable ?? (() => true);

  let mtime = 0;
  try {
    mtime = fs.statSync(options.markerPath).mtimeMs;
  } catch {
    /* no marker — never successfully refreshed */
  }

  if (!options.force && mtime && !isExpired(mtime, options.ttlMs) && usable()) {
    return;
  }

  try {
    await options.refresh();
  } catch (err) {
    if (mtime && !isExpired(mtime, options.staleMs) && usable()) {
      return;
    }
    throw err;
  }
}
