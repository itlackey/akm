// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The refs whose rows index-on-miss wrote (`core/assets/type.ts`) and `akm index` has not scanned since. A file added or
 * moved outside akm gets its row on its first read; the next scan must still see it as new, or a renamed file's old
 * row, with its id, vector, links and scores, would never be paired with it (`ref-moves.ts`).
 */

import type { Database } from "../storage/database";
import { getMeta, setMeta } from "../storage/repositories/index-meta-repository";

const KEY = "onMissRefs";

export function readIndexOnMissRefs(db: Database): Set<string> {
  try {
    return new Set(JSON.parse(getMeta(db, KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function write(db: Database, refs: ReadonlySet<string>): void {
  setMeta(db, KEY, JSON.stringify([...refs]));
}

export function addIndexOnMissRefs(db: Database, refs: readonly string[]): void {
  if (refs.length === 0) return;
  write(db, new Set([...readIndexOnMissRefs(db), ...refs]));
}

/** A scan has seen these refs: they are no longer waiting for one. */
export function clearIndexOnMissRefs(db: Database, scanned: ReadonlySet<string>): void {
  const marked = readIndexOnMissRefs(db);
  if (marked.size === 0) return;
  const rest = new Set([...marked].filter((ref) => !scanned.has(ref)));
  if (rest.size !== marked.size) write(db, rest);
}
