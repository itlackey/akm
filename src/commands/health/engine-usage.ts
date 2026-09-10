// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `engine-last-used` support for `akm health` (#950).
 *
 * An engine bound to an enabled improve process that has not actually been
 * invoked in weeks looks identical to a healthy one on every existing check —
 * `default-llm-engine`/`configured-engines` only probe availability/reachability,
 * never USE. This module answers "when did this engine last run, and for
 * whom" by folding `llm_usage` events over a fixed lookback window,
 * independent of the report's `--since` (mirrors `session-extraction`'s
 * independent `SESSION_EXTRACTION_LEDGER_WINDOW_DAYS` window in `checks.ts`).
 */

import { daysToMs } from "../../core/common";
import { readEvents } from "../../core/events";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { decodeLlmUsageRecord } from "../../llm/usage-telemetry";

/** Rolling window `engine-last-used` reads over, independent of `--since`. */
export const ENGINE_LAST_USED_LOOKBACK_DAYS = 30;

/** The most recent recorded `llm_usage` call for one engine. */
export interface EngineLastUsed {
  lastUsedAt: string;
  process?: string;
}

/** ISO cutoff for the `ENGINE_LAST_USED_LOOKBACK_DAYS` window, ending at `now()`. */
export function engineLastUsedSince(now: () => number): string {
  return new Date(now() - daysToMs(ENGINE_LAST_USED_LOOKBACK_DAYS)).toISOString();
}

/**
 * Fold `llm_usage` events over the lookback window into the most recent call
 * per engine. Best-effort like every other health probe: an event with no
 * `engine` field (pre-#576 rows, or a call outside any resolved engine) is
 * skipped rather than bucketed under a synthetic key.
 */
export function readLastEngineUsage(stateDbPath: string, now: () => number): Map<string, EngineLastUsed> {
  const since = engineLastUsedSince(now);
  const events = readEvents({ since, type: LLM_USAGE_EVENT }, { dbPath: stateDbPath }).events;
  const lastUsed = new Map<string, EngineLastUsed>();
  for (const event of events) {
    const record = decodeLlmUsageRecord(event.metadata);
    if (!record?.engine) continue;
    const existing = lastUsed.get(record.engine);
    if (!existing || event.ts > existing.lastUsedAt) {
      lastUsed.set(record.engine, { lastUsedAt: event.ts, process: record.process });
    }
  }
  return lastUsed;
}
