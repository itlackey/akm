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
import { SEMANTIC_SEARCH_META_KEY, type SemanticSearchRecord } from "../../indexer/walk/index-context";
import { LOCAL_EMBEDDING_RUNTIME } from "../../llm/embedders/local";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getEmbeddableEntryCount } from "../../storage/repositories/index-entries-repository";
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
}

/** Read the last index run's record and the index's counts, read-only. */
export function readSemanticSearchState(mode: string | undefined): SemanticSearchState {
  try {
    const db = openReadonlyExistingDatabase(getDbPath());
    if (!db) return { mode };
    try {
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

  if (state.mode === "off") return result("pass", "Semantic search is off (semanticSearchMode: off).", { mode: "off" });
  if (state.error) return result("unknown", `Could not read the index: ${state.error}`);
  const index = state.index;
  if (!index?.record) return result("unknown", "No semantic-search state recorded yet; run `akm index`.");

  const { record, builtAt, entryCount, embeddingCount } = index;
  const evidence = { ...record, ...(builtAt ? { builtAt } : {}), entryCount, embeddingCount };
  const asOf = builtAt ? ` at the last index (${builtAt})` : " at the last index";
  switch (record.status) {
    case "unavailable":
      return result("fail", `Semantic search was unavailable on this machine${asOf}: ${record.reason}`, evidence);
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
