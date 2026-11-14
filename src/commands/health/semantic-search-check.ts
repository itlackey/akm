// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `semantic-search` for `akm health`: what the last `akm index` recorded about
 * semantic search (status, embedding runtime, the reason it failed), with the
 * index's own entry and vector counts read now. It loads no model and makes no
 * request, and nothing gates search on it (#873 removed the cached verdict
 * search used to obey); it reports what the index says.
 */

import { getDbPath } from "../../core/paths";
import { heldRebuildLock } from "../../indexer/index-rebuild-lock";
import { SEMANTIC_SEARCH_META_KEY, type SemanticSearchRecord } from "../../indexer/walk/index-context";
import { LOCAL_EMBEDDING_RUNTIME } from "../../llm/embedders/local";
import {
  closeDatabase,
  indexDbIsDamaged,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { getEmbeddableEntryCount } from "../../storage/repositories/index-entries-repository";
import { hasCurrentEntriesTable } from "../../storage/repositories/index-entry-schema";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { getEmbeddingCount } from "../../storage/repositories/index-vec-repository";
import type { HealthCheckResult } from "./types";

/** What the check reads: the config's mode and, when there is an index, its record and counts. */
export interface SemanticSearchState {
  /** `semanticSearchMode` in the current config; undefined when the config cannot load. */
  mode?: string;
  /** Undefined when there is no index. */
  index?: { record?: SemanticSearchRecord; builtAt?: string; entryCount: number; embeddingCount: number };
  /** Why the index could not be read. */
  error?: string;
  /** A first build holds the rebuild lock, so a partial index is expected. */
  building?: boolean;
}

/** Read the last index run's record and the index's counts, read-only. */
export function readSemanticSearchState(mode: string | undefined): SemanticSearchState {
  try {
    if (indexDbIsDamaged()) throw new Error("index.db is damaged");
    const db = openReadonlyExistingDatabase(getDbPath());
    if (!db) return { mode };
    try {
      if (!hasCurrentEntriesTable(db)) throw new Error("index.db has no searchable entries table");
      const raw = getMeta(db, SEMANTIC_SEARCH_META_KEY);
      return {
        mode,
        index: {
          ...(raw ? { record: JSON.parse(raw) as SemanticSearchRecord } : {}),
          builtAt: getMeta(db, "builtAt"),
          entryCount: getEmbeddableEntryCount(db),
          embeddingCount: getEmbeddingCount(db),
        },
      };
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    if (heldRebuildLock()) return { mode, building: true };
    return { mode, error: error instanceof Error ? error.message : String(error) };
  }
}

export function semanticSearchCheck(state: SemanticSearchState): HealthCheckResult {
  const result = (
    status: HealthCheckResult["status"],
    message: string,
    evidence?: Record<string, unknown>,
  ): HealthCheckResult => ({
    name: "semantic-search",
    kind: "deterministic",
    status,
    confidence: "high",
    message,
    ...(evidence ? { evidence } : {}),
  });

  // Keyword search needs a readable index too, even when embeddings are off.
  if (state.error)
    return result(
      "fail",
      `Could not read the index: ${state.error}. Run \`akm index\`; it rebuilds a damaged index.db.`,
    );
  if (state.building) return result("unknown", "The search index is being built; check again when the build finishes.");
  if (state.mode === "off") return result("pass", "Semantic search is off (semanticSearchMode: off).", { mode: "off" });
  const index = state.index;
  if (!index?.record) return result("unknown", "No semantic-search state recorded yet; run `akm index`.");

  const { record, builtAt, entryCount, embeddingCount } = index;
  const evidence = { ...record, ...(builtAt ? { builtAt } : {}), entryCount, embeddingCount };
  const asOf = builtAt ? ` at the last index (${builtAt})` : " at the last index";
  switch (record.status) {
    case "unavailable":
      // No local embeddings on this platform is not something to fix: keyword search or a remote endpoint is the default there.
      return record.unavailable === "platform"
        ? result(
            "warn",
            `Semantic search is unavailable on this platform: ${record.reason} ` +
              "For keyword search run `akm setup --embedding off`; for a remote endpoint, `akm setup --embedding <model> --embedding-endpoint <url>`.",
            evidence,
          )
        : result("fail", `Semantic search was unavailable on this machine${asOf}: ${record.reason}`, evidence);
    case "blocked":
      return result("fail", `Semantic search was blocked${asOf}: ${record.reason}`, evidence);
    case "ready-js":
      if (embeddingCount < entryCount) {
        return result(
          "warn",
          `Embeddings lag entries (${embeddingCount}/${entryCount}); run \`akm index\` to embed the rest.`,
          evidence,
        );
      }
      if (record.provider === "local" && record.runtime && record.runtime !== LOCAL_EMBEDDING_RUNTIME) {
        return result(
          "warn",
          `Local embeddings ran on ${record.runtime}, not the native ${LOCAL_EMBEDDING_RUNTIME}${asOf}.`,
          evidence,
        );
      }
      return result(
        "pass",
        `Semantic search ready (${embeddingCount}/${entryCount} embeddings${record.runtime ? ` on ${record.runtime}` : ""}).`,
        evidence,
      );
    case "disabled":
      return result("unknown", `Semantic search was off${asOf}; run \`akm index\` to build it.`, evidence);
    default:
      return result("unknown", `No entries were indexed${asOf}.`, evidence);
  }
}
