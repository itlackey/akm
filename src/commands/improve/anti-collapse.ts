// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 8 — anti-collapse guard for consolidation: an occasional random
 * (non-similar) cluster member in the pool, so consolidation is not purely
 * similarity-driven.
 *
 * @module anti-collapse
 */

/** Default fraction of pool to fill with random (non-similar) clusters. */
export const DEFAULT_RANDOM_CLUSTER_FRACTION = 0.05;

export interface AntiCollapseConfig {
  /** DEFAULT ON: the random-cluster injection is deterministic and cheap. Set `false` to opt out. */
  enabled?: boolean;
  randomClusterFraction?: number;
}
