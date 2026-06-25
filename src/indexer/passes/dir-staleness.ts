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
 *   2. The `index_dir_state` fingerprint row (`getIndexDirState`), which caches
 *      the file-set hash + max mtime for directories that legitimately produced
 *      zero rows, so they are not rescanned every run.
 *
 * `computeDirFingerprint` derives the fingerprint (basename set + max mtime)
 * that both the freshness check and the persisted `index_dir_state` row use.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "../../storage/database";
import { type DbIndexedEntry, getEntriesByDir, getIndexDirState } from "../db/db";
import type { StashFile } from "./metadata";

/**
 * Reasons a directory is considered stale (or freshly unchanged). A subset of
 * the indexer's broader `DirScanReason` — only the kinds the staleness engine
 * itself produces.
 */
export type DirStaleReason = {
  kind:
    | "unchanged"
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

export function getDirIndexState(db: Database, dirPath: string, files: string[], builtAtMs: number): DirIndexState {
  const prevEntries = getEntriesByDir(db, dirPath);
  const fingerprint = computeDirFingerprint(dirPath, files);
  if (prevEntries.length > 0) {
    const staleReason = getDirStaleReason(dirPath, files, prevEntries, builtAtMs);
    if (!staleReason) {
      return { stale: false, reason: { kind: "unchanged" }, persistedRowCount: prevEntries.length };
    }
    return { stale: true, reason: staleReason, persistedRowCount: prevEntries.length };
  }

  const cachedState = getIndexDirState(db, dirPath);
  if (
    cachedState &&
    cachedState.fileSetHash === fingerprint.fileSetHash &&
    cachedState.fileMtimeMaxMs === fingerprint.fileMtimeMaxMs
  ) {
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

export function getCachedZeroRowDirState(
  db: Database,
  dirPath: string,
  files: string[],
  builtAtMs: number,
  priorDirsChanged: boolean,
): DirIndexState | undefined {
  const state = getDirIndexState(db, dirPath, files, builtAtMs);
  if (state.stale || state.reason.kind !== "cached-zero-row-state") return undefined;
  if (!canUseIncrementalSkip(state, priorDirsChanged)) return undefined;
  return state;
}

export function canUseIncrementalSkip(state: DirIndexState, priorDirsChanged: boolean): boolean {
  return !(
    priorDirsChanged &&
    state.reason.kind === "cached-zero-row-state" &&
    state.reason.detail === "deduped-zero-row"
  );
}

export function computeDirFingerprint(
  _dirPath: string,
  files: string[],
): { fileSetHash: string; fileMtimeMaxMs: number } {
  const normalizedFiles = [...new Set(files.map((file) => path.basename(file)))].sort();
  let fileMtimeMaxMs = 0;
  for (const file of files) {
    try {
      fileMtimeMaxMs = Math.max(fileMtimeMaxMs, fs.statSync(file).mtimeMs);
    } catch {
      fileMtimeMaxMs = Number.POSITIVE_INFINITY;
      break;
    }
  }
  return {
    fileSetHash: normalizedFiles.join("\0"),
    fileMtimeMaxMs,
  };
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
  dedupedRows: number,
): string {
  if (dedupedRows > 0) return "deduped-zero-row";
  const workflowNoise = warnings.some(
    (warning) => warning.startsWith("Skipped workflow ") && warning.includes(dirPath),
  );
  if (workflowNoise) return "workflow-noise";
  if (!stash || stash.entries.length === 0) return "empty-generated-set";
  return `zero-row:${priorReason?.kind ?? "unknown"}`;
}
