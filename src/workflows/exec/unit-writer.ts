// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serialized writer queue for `workflow_run_units`. SQLite allows one writer
 * per database file, so unit writes are chained per state.db path (an
 * in-process promise chain suffices on Bun's single thread) instead of N
 * connections racing for the lock. A unit's own reserve→finish order comes
 * from program order, not the queue. Reads stay off it; a failed write rejects
 * its caller without wedging the chain.
 */

import { serializeByKey } from "../../core/concurrent";
import { getStateDbPath } from "../../core/state-db";

/** One promise chain per database path, pruned when it drains ({@link serializeByKey}). */
const chains = new Map<string, Promise<unknown>>();

/** Enqueue a `workflow_run_units` write behind every write already queued for the current state.db. */
export function enqueueUnitWrite<T>(fn: () => Promise<T>): Promise<T> {
  return serializeByKey(chains, getStateDbPath(), fn);
}
