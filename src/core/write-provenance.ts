// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run-scoped write provenance.
 *
 * # Why this exists
 *
 * `akm improve`'s end-of-run auto-sync must know "what did this run write?".
 * It does not infer it by diffing two Git dirty-path snapshots (everything dirty at
 * end-of-run minus everything dirty when the run acquired its lock), which is
 * wrong in both directions:
 *
 *   - an unrelated managed-dir edit made by a human DURING a long run appears in
 *     the end-of-run diff and gets swept into akm's commit;
 *   - a path that was ALREADY dirty when the run started and is then rewritten by
 *     the run is subtracted out and never committed.
 *
 * The journal below replaces the inference with a record. Every akm write path
 * that mutates a file on disk calls {@link recordWrittenPath}; a run opens a
 * journal for its duration and reads back the exact set of paths it touched.
 *
 * # Contract
 *
 *   - A *write* and a *removal* are recorded identically — the journal records
 *     "this run mutated this path", not what the mutation was. The final on-disk
 *     state is what gets staged (`git add -A -- <path>` stages a deletion just as
 *     happily as a modification), so a path written and then reverted, purged, or
 *     rolled back needs no special handling: it is journaled once and the stager
 *     sees whatever survived.
 *   - Recording is a no-op when no journal is open, so non-improve command paths
 *     pay nothing but a `Set.size` check.
 *   - Journals nest: every open journal observes every recorded path. Concurrent
 *     in-process runs (tests) therefore over-report rather than cross-attribute
 *     writes to the wrong run, which is the safe direction — over-reporting stages
 *     a path that has no diff, under-reporting loses a write.
 *   - Nothing here throws. A provenance failure must never break a write.
 */

import path from "node:path";

interface JournalState {
  readonly touched: Set<string>;
}

const activeJournals = new Set<JournalState>();

/** Handle for one open run-scoped journal. Obtain via {@link beginWriteProvenance}. */
export interface WriteProvenanceJournal {
  /** Absolute paths mutated while this journal was open (deduped, sorted). */
  writtenPaths(): string[];
  /**
   * Close the journal and return its paths. Idempotent — a closed journal keeps
   * answering {@link writtenPaths} but stops observing new writes.
   */
  end(): string[];
}

/** Open a journal. The caller MUST close it (`end()`) in a `finally`. */
export function beginWriteProvenance(): WriteProvenanceJournal {
  const state: JournalState = { touched: new Set<string>() };
  activeJournals.add(state);
  const snapshot = (): string[] => [...state.touched].sort();
  return {
    writtenPaths: snapshot,
    end: () => {
      activeJournals.delete(state);
      return snapshot();
    },
  };
}

/** True while at least one journal is open. */
export function isWriteProvenanceActive(): boolean {
  return activeJournals.size > 0;
}

/**
 * Record that the current run mutated `filePath` (write, create, rename, or
 * delete). No-op when no journal is open. Never throws.
 */
export function recordWrittenPath(filePath: string | undefined | null): void {
  if (activeJournals.size === 0 || !filePath) return;
  let absolute: string;
  try {
    absolute = path.resolve(filePath);
  } catch {
    return;
  }
  for (const journal of activeJournals) journal.touched.add(absolute);
}

/**
 * Normalize an absolute journaled path against `root`: POSIX-relative when the
 * path is inside `root`, `undefined` otherwise (the caller decides whether an
 * out-of-root write is reportable or, for staging, simply out of scope).
 */
export function relativeWrittenPath(root: string, absolutePath: string): string | undefined {
  const relative = path.relative(root, absolutePath).replaceAll(path.sep, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
  return relative;
}
