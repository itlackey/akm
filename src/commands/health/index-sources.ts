// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index-sources` for `akm health`: the configured sources the last `akm index` could not scan completely, each with
 * the reason it reported. Entries from a source's last complete scan are kept; a source never scanned has none.
 * Reads the record the indexer wrote to the index, read-only; it scans nothing itself.
 */

import { readIncompleteSources } from "../../indexer/walk/index-context";
import { readHealthIndex } from "./read-index";
import type { HealthCheckResult } from "./types";

export function collectIndexSourcesCheck(): HealthCheckResult {
  const base = { name: "index-sources", kind: "deterministic", confidence: "high" } as const;
  const read = readHealthIndex(readIncompleteSources);
  if ("building" in read) {
    return {
      ...base,
      status: "unknown",
      reason: "idle",
      message: "The search index is being built; check again when the build finishes.",
    };
  }
  if ("error" in read) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `Could not read the index to see which sources were scanned: ${read.error}. Run \`akm index\`.`,
    };
  }
  if ("noIndex" in read) {
    return { ...base, status: "unknown", reason: "idle", message: "No index has been built yet; run `akm index`." };
  }
  const sources = read.value;
  if (sources === undefined) {
    return {
      ...base,
      status: "unknown",
      reason: "idle",
      message: "The last index run recorded no list of scanned sources; run `akm index`.",
    };
  }
  if (sources.length === 0) {
    return {
      ...base,
      status: "pass",
      message: "Every configured source was scanned at the last index.",
      evidence: { sources: [] },
    };
  }
  const named = sources.map((source) => `${source.bundle} (${source.component}: ${source.reason})`).join("; ");
  return {
    ...base,
    status: "warn",
    message: `${sources.length} configured source(s) could not be scanned at the last index, so any entries from their last complete scan are kept: ${named}. Fix the source, then run \`akm index\`.`,
    evidence: { sources: sources },
  };
}
