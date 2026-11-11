// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export type Refresh<T> =
  | { ok: true; data: T; stale: boolean; recovered: boolean }
  | { ok: false; error: string; stale: boolean };

/**
 * Snapshot requests overlap (the two-second poll, an action's own refresh), so each carries a number: an answer older
 * than one already shown is `stale` and must not replace it. `recovered` marks the first success after a failure.
 */
export function snapshotFeed<T>(load: () => Promise<T>) {
  let requested = 0;
  let shown = 0;
  let lost = false;
  return async (): Promise<Refresh<T>> => {
    const order = ++requested;
    try {
      const data = await load();
      const stale = order < shown;
      if (stale) return { ok: true, data, stale, recovered: false };
      shown = order;
      const recovered = lost;
      lost = false;
      return { ok: true, data, stale, recovered };
    } catch (cause) {
      const stale = order < shown;
      if (!stale) lost = true;
      return { ok: false, error: (cause as Error).message, stale };
    }
  };
}

/**
 * Poll until `busy` is false. Gives up, with false, after `limit` failed refreshes in a row: the status connection is
 * gone, which says nothing about whether the operation it was watching is still running.
 */
export async function waitUntilIdle(
  refresh: () => Promise<boolean>,
  busy: () => boolean,
  pause: () => Promise<void>,
  limit = 5,
): Promise<boolean> {
  let missed = 0;
  while (busy()) {
    await pause();
    missed = (await refresh()) ? 0 : missed + 1;
    if (missed >= limit) return false;
  }
  return true;
}
