// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index-sources` for `akm health`: the configured sources the last `akm index` could not scan completely, each with
 * the reason it reported. The index keeps those sources' last-known-good rows and search serves them; this says so.
 * Reads the record the indexer wrote to the index, read-only; it scans nothing itself.
 */

import { getDbPath } from "../../core/paths";
import { heldRebuildLock } from "../../indexer/index-rebuild-lock";
import { type IncompleteIndexSource, readIncompleteSources } from "../../indexer/walk/index-context";
import {
  closeDatabase,
  indexDbIsDamaged,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import type { HealthCheckResult } from "./types";

/** What the last index run recorded: the unscanned sources, `undefined` when it recorded no list, or why the index could not be read. */
type IndexSourcesRecord = { sources: IncompleteIndexSource[] | undefined } | { error: string } | { noIndex: true };

function readRecord(): IndexSourcesRecord {
  try {
    if (indexDbIsDamaged()) throw new Error("index.db is damaged");
    const db = openReadonlyExistingDatabase(getDbPath());
    if (!db) return { noIndex: true };
    try {
      return { sources: readIncompleteSources(db) };
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function collectIndexSourcesCheck(): HealthCheckResult {
  const base = { name: "index-sources", kind: "deterministic", confidence: "high" } as const;
  const record = readRecord();
  if ("error" in record) {
    if (heldRebuildLock()) {
      return {
        ...base,
        status: "unknown",
        reason: "idle",
        message: "The search index is being built; check again when the build finishes.",
      };
    }
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `Could not read the index to see which sources were scanned: ${record.error}. Run \`akm index\`.`,
    };
  }
  if ("noIndex" in record) {
    return { ...base, status: "unknown", reason: "idle", message: "No index has been built yet; run `akm index`." };
  }
  if (record.sources === undefined) {
    return {
      ...base,
      status: "unknown",
      reason: "idle",
      message: "The last index run recorded no list of scanned sources; run `akm index`.",
    };
  }
  if (record.sources.length === 0) {
    return {
      ...base,
      status: "pass",
      message: "Every configured source was scanned at the last index.",
      evidence: { sources: [] },
    };
  }
  const named = record.sources.map((source) => `${source.bundle} (${source.component}: ${source.reason})`).join("; ");
  return {
    ...base,
    status: "warn",
    message: `${record.sources.length} configured source(s) could not be scanned at the last index, so search serves their last-known-good entries: ${named}. Fix the source, then run \`akm index\`.`,
    evidence: { sources: record.sources },
  };
}
