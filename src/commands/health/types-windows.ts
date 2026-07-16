// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Window-compare shapes (chunk-9 WI-9.5d per-domain split of `./types`).
 * `--window-compare`/`--windows` resolve to a list of {@link WindowSpec}s, each
 * projected into a {@link WindowResult}; `health/windows.ts` diffs two of them
 * into {@link DeltaEntry} records.
 */

import type { ImproveHealthMetrics } from "./types-improve";
import type { HealthMetrics } from "./types-metrics";

export interface WindowSpec {
  name: string;
  since: string;
  until?: string;
}

export interface WindowResult {
  name: string;
  since: string;
  until: string;
  /** All non-dry-run rows in the window; decoder accounting is additive under improve.resultRows. */
  runs: number;
  improve: ImproveHealthMetrics;
  metrics: HealthMetrics;
}

export interface DeltaEntry {
  from: number;
  to: number;
  pctChange: number | string;
}
