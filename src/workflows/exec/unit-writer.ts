// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serialized writer queue for `workflow_run_units` (orchestration plan,
 * *Persistence changes*).
 *
 * ## What the chain actually protects
 *
 * SQLite allows exactly ONE writer per database FILE. Outside a
 * `withWorkflowRunsConnection` scope, `withWorkflowRunsRepo` opens a fresh
 * connection per call, so N units completing at once would be N separate
 * connections racing for the same file's write lock, burning the 30 s
 * `busy_timeout` on contention we created ourselves. Bun runs a single-threaded
 * event loop, so an in-process promise chain is a sufficient (and free)
 * admission control: every unit write executes strictly in enqueue order.
 *
 * That is the ONLY invariant the chain owns. In particular it does NOT own
 * per-unit insert→finish ordering: `dispatchJournaledAttempt` awaits its insert
 * before it dispatches and only finishes after the dispatch resolves, so a
 * unit's own writes are ordered by program order, not by queue position. The
 * queue could be reordered arbitrarily between units without breaking
 * `finishUnitFromDispatch`'s row-conditional logic.
 *
 * ## Scope of the serialization (issue B)
 *
 * The chain is keyed by DATABASE PATH, not global, because the resource being
 * protected is one SQLite file's write lock. Two runs against two different
 * data dirs (`AKM_DATA_DIR` isolation, a test sandbox, a second stash) share no
 * write lock and must not queue behind each other. Narrowing further — per run
 * — would be unsound: two runs in the SAME state.db still contend for that one
 * file's writer, which is precisely what the chain exists to avoid.
 *
 * Inside a `withWorkflowRunsConnection` scope the chain also becomes nearly
 * free: every write goes through the same handle, so each queued task is a
 * synchronous statement (or a synchronous `BEGIN IMMEDIATE … COMMIT`) that
 * settles in microseconds rather than a per-call open/migrate-preflight/close.
 * The queue depth stops gating unit completion in practice, without weakening
 * anything.
 *
 * Reads and gate evaluation stay OFF this queue — only writes serialize.
 *
 * A failed write rejects its own caller but never wedges its chain.
 */

import { getStateDbPath } from "../../core/state-db";

/** One promise chain per database path. Entries are pruned when their chain drains. */
const chains = new Map<string, Promise<unknown>>();

export interface EnqueueUnitWriteOptions {
  /**
   * Serialization key. Defaults to the current state.db path — the file whose
   * single write lock the chain is protecting. Callers should only override it
   * when they are writing to a DIFFERENT database file.
   */
  key?: string;
}

export function enqueueUnitWrite<T>(fn: () => Promise<T>, opts?: EnqueueUnitWriteOptions): Promise<T> {
  const key = opts?.key ?? getStateDbPath();
  const tail = chains.get(key) ?? Promise.resolve();
  const run = tail.then(() => fn());
  // Keep the chain alive regardless of individual outcomes.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  // Drop the entry once this task is the drained tail, so a long-lived process
  // that touches many data dirs (the test harness swaps `AKM_DATA_DIR` per
  // test) does not accumulate one resolved promise per path forever. If another
  // write was enqueued in the meantime the map now holds ITS tail, and this
  // check leaves it alone.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}
