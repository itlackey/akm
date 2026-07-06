// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serialized writer queue for `workflow_run_units` (orchestration plan,
 * *Persistence changes*).
 *
 * `withWorkflowRunsRepo` opens a fresh SQLite connection per call, so N
 * parallel units completing at once would contend on SQLite's single writer
 * and burn the 30 s busy_timeout. Bun is single-threaded, so a promise-chained
 * in-process queue is sufficient: every unit write is appended to one chain
 * and executes strictly in enqueue order. Reads and gate evaluation stay OFF
 * this queue — only writes serialize.
 *
 * A failed write rejects its own caller but never wedges the chain.
 */

let tail: Promise<unknown> = Promise.resolve();

export function enqueueUnitWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(() => fn());
  // Keep the chain alive regardless of individual outcomes.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
