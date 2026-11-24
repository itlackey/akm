// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Incremental dir-staleness engine.
 *
 * Decides, per stash directory, whether the directory's indexed rows are still
 * fresh relative to what is on disk — so an incremental `akm index` run can
 * skip unchanged directories instead of regenerating their metadata.
 *
 * Two persisted signals back the decision:
 *   1. The `entries` rows already indexed for the directory (`getEntriesByDir`).
 *   2. The `index_dir_state` row (`getIndexDirState`): the fingerprint of the
 *      directory's walked file set (basename set + max mtime, `computeDirFingerprint`)
 *      as of its last drain, plus the row count that drain persisted.
 *
 * `getCachedDirState` is the pre-drain gate (#900): a directory whose walked
 * fingerprint still matches its row is skipped before any file is read.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareCodePoints } from "../../core/common";
import type { Database } from "../../storage/database";
import { getEntriesByDir } from "../../storage/repositories/index-entries-repository";
import type { DbIndexedEntry } from "../../storage/repositories/index-entry-types";
import { getIndexDirState } from "../../storage/repositories/index-meta-repository";
import type { StashFile } from "./metadata";

/**
 * Reasons a directory is considered stale (or freshly unchanged). A subset of
 * the indexer's broader `DirScanReason` — only the kinds the staleness engine
 * itself produces.
 */
export type DirStaleReason = {
  kind:
    | "unchanged"
    | "unchanged-precheck"
    | "index-context-changed"
    | "no-previous-rows"
    | "cached-zero-row-state"
    | "mtime-changed"
    | "file-set-changed"
    | "missing-file";
  detail?: string;
};

export interface DirIndexState {
  stale: boolean;
  reason: DirStaleReason;
  persistedRowCount: number;
}

export interface DirFingerprint {
  /**
   * sha256 over each file's `(basename, size, mtimeMs, ctimeMs)`, sorted. The
   * whole freshness decision; the column it persists to is still named
   * `file_set_hash` for schema stability.
   */
  fileSetHash: string;
  /** Newest mtime in the directory. Diagnostic only — the digest above decides. */
  fileMtimeMaxMs: number;
}

/**
 * Post-drain freshness verdict. `files` is the recognized file set the drain
 * produced (compared against the persisted entries); `fingerprint` is the
 * walked-set fingerprint compared against the persisted row and defaults to
 * one computed over `files`.
 */
export function getDirIndexState(
  db: Database,
  dirPath: string,
  files: string[],
  builtAtMs: number,
  indexVariant = "",
  fingerprint: DirFingerprint = computeDirFingerprint(dirPath, files, indexVariant),
): DirIndexState {
  const prevEntries = getEntriesByDir(db, dirPath);
  if (prevEntries.length > 0) {
    const staleReason = getDirStaleReason(dirPath, files, prevEntries, builtAtMs);
    if (staleReason) return { stale: true, reason: staleReason, persistedRowCount: prevEntries.length };
    const cachedState = getIndexDirState(db, dirPath);
    if (!cachedState || cachedState.fileSetHash !== fingerprint.fileSetHash) {
      return {
        stale: true,
        reason: { kind: "index-context-changed", detail: indexVariant },
        persistedRowCount: prevEntries.length,
      };
    }
    return { stale: false, reason: { kind: "unchanged" }, persistedRowCount: prevEntries.length };
  }

  const cachedState = getIndexDirState(db, dirPath);
  if (cachedState && cachedState.fileSetHash === fingerprint.fileSetHash) {
    return {
      stale: false,
      reason: { kind: "cached-zero-row-state", detail: cachedState.reason },
      persistedRowCount: 0,
    };
  }

  return {
    stale: true,
    reason: { kind: "no-previous-rows", detail: cachedState ? `cached=${cachedState.reason}` : undefined },
    persistedRowCount: 0,
  };
}

/**
 * Pre-drain gate (#900). A directory whose walked-set fingerprint matches its
 * persisted row cannot recognize differently than last time, so it is skipped
 * before `drainDirDocuments` reads a single file. A row that recorded a real
 * generation (`rowCount > 0`) is skipped outright; a zero-row or pre-#900 row
 * goes through the entries-aware check.
 */
export function getCachedDirState(
  db: Database,
  dirPath: string,
  files: string[],
  builtAtMs: number,
  indexVariant: string,
  fingerprint: DirFingerprint,
): DirIndexState | undefined {
  const cached = getIndexDirState(db, dirPath);
  if (!cached || cached.fileSetHash !== fingerprint.fileSetHash) return undefined;
  if (cached.rowCount !== undefined && cached.rowCount > 0) {
    return { stale: false, reason: { kind: "unchanged-precheck" }, persistedRowCount: cached.rowCount };
  }
  const state = getDirIndexState(db, dirPath, files, builtAtMs, indexVariant, fingerprint);
  if (state.stale || state.reason.kind !== "cached-zero-row-state") return undefined;
  return state;
}

export function computeDirFingerprint(_dirPath: string, files: string[], indexVariant = ""): DirFingerprint {
  // One `statSync` per file — the same call this function has always made — but
  // every field it returns that can witness a change is kept, per file, instead
  // of being collapsed into a single max.
  //
  // `Math.max` over mtimes discarded everything except the newest file, so an
  // edit to any other file landed below the max and was invisible; and mtime
  // alone is writable by ordinary tooling (`touch -r`, `rsync --times`,
  // `cp -p`, archive extraction), so a restored timestamp hid an edit outright.
  // Size catches any length-changing edit; ctime catches the rest, because
  // utimes(2) cannot hold the inode's change time back.
  //
  // This is still a heuristic: ctime also moves on metadata-only changes
  // (chmod/chown) and after copying a tree, which costs an unnecessary rescan.
  // That direction is safe — extra work, never stale content.
  const entries: string[] = [];
  let fileMtimeMaxMs = 0;
  for (const file of [...new Set(files)].sort(compareCodePoints)) {
    const name = path.basename(file);
    try {
      // `bigint: true` is the same syscall but reports nanoseconds. Millisecond
      // floats would let an edit made inside the same millisecond as the last
      // run's stat land on an identical digest.
      // asset-io: state the directory scan's incremental state (principled exception 6)
      const stat = fs.statSync(file, { bigint: true });
      fileMtimeMaxMs = Math.max(fileMtimeMaxMs, Number(stat.mtimeMs));
      entries.push(`${name}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`);
    } catch {
      // Unreadable or vanished: record it as such so the digest differs from
      // any run where the file could be read, forcing a rescan.
      entries.push(`${name}\0unreadable`);
    }
  }
  const digest = createHash("sha256")
    .update([indexVariant, ...entries].join("\n"), "utf8")
    .digest("hex");
  return { fileSetHash: digest, fileMtimeMaxMs };
}

function getDirStaleReason(
  _dirPath: string,
  currentFiles: string[],
  previousEntries: DbIndexedEntry[],
  builtAtMs: number,
):
  | {
      kind: "mtime-changed" | "file-set-changed" | "missing-file";
      detail?: string;
    }
  | undefined {
  const prevFileNames = new Set(
    previousEntries
      .map((ie) => {
        const fromPath = path.basename(ie.filePath);
        return fromPath || ie.entry.filename;
      })
      .filter((e): e is string => !!e),
  );
  const currFileNames = new Set(currentFiles.map((f) => path.basename(f)));
  if (prevFileNames.size !== currFileNames.size) {
    return { kind: "file-set-changed", detail: `${prevFileNames.size} -> ${currFileNames.size} files` };
  }
  for (const name of currFileNames) {
    if (!prevFileNames.has(name)) return { kind: "file-set-changed", detail: name };
  }

  for (const file of currentFiles) {
    try {
      // asset-io: state the directory scan's incremental state (principled exception 6)
      if (fs.statSync(file).mtimeMs > builtAtMs) return { kind: "mtime-changed", detail: path.basename(file) };
    } catch {
      return { kind: "missing-file", detail: path.basename(file) };
    }
  }

  return undefined;
}

export function inferZeroRowReason(
  stash: StashFile | null,
  priorReason: { kind: string; detail?: string } | undefined,
  warnings: string[],
  dirPath: string,
): string {
  const workflowNoise = warnings.some(
    (warning) => warning.startsWith("Skipped workflow ") && warning.includes(dirPath),
  );
  if (workflowNoise) return "workflow-noise";
  if (!stash || stash.entries.length === 0) return "empty-generated-set";
  return `zero-row:${priorReason?.kind ?? "unknown"}`;
}
