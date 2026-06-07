// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { getAssetTypes } from "../../core/asset-spec";
import { getSources, loadConfig } from "../../core/config";
import { getDbPath } from "../../core/paths";
import { closeDatabase, getEntryCount, getMeta, isVecAvailable, openExistingDatabase } from "../../indexer/db";
import { getEffectiveSemanticStatus, readSemanticStatus } from "../../indexer/semantic-status";
import type { InfoResponse } from "../../sources/types";
import { pkgVersion } from "../../version";

/**
 * Assemble system info describing the current capabilities, configuration,
 * and index state. Used by `akm info`.
 *
 * @param options.dbPath - Override the database path (useful for testing)
 */
export function assembleInfo(options?: { dbPath?: string }): InfoResponse {
  const config = loadConfig();

  // Asset types (copy into a mutable array — `getAssetTypes()` returns readonly)
  const assetTypes = [...getAssetTypes()];

  const semanticRuntime = readSemanticStatus();
  const semanticStatus = getEffectiveSemanticStatus(config, semanticRuntime);

  // Search modes
  const searchModes: string[] = ["fts"];
  if (semanticStatus === "ready-js" || semanticStatus === "ready-vec") {
    searchModes.push("semantic", "hybrid");
  }

  // Registries (strip sensitive fields like apiKey from options)
  const registries = (config.registries ?? []).map((r) => ({
    url: r.url,
    ...(r.name ? { name: r.name } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
  }));

  // Stash providers — prefer `sources[]`; fall back to `stashDir` when the
  // user has not yet migrated to the sources[] config shape so that info
  // always reflects at least one provider when a stash is configured.
  const configuredSources = getSources(config);
  const stashesList =
    configuredSources.length === 0 && config.stashDir
      ? [{ type: "filesystem", path: config.stashDir, name: "primary" }]
      : configuredSources;
  const sourceProviders = stashesList.map((s) => ({
    type: s.type,
    ...(s.name ? { name: s.name } : {}),
    ...(s.path ? { path: s.path } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
  }));

  // Index stats — resolve the DB path from config so info reads the same
  // database that health and search use, rather than a bare getDbPath() call
  // that ignores XDG_DATA_HOME or per-config overrides.
  const resolvedDbPath = options?.dbPath ?? getDbPath();
  const indexStats = readIndexStats(resolvedDbPath);

  return {
    schemaVersion: 1,
    version: pkgVersion,
    assetTypes,
    searchModes,
    semanticSearch: {
      mode: config.semanticSearchMode,
      status: semanticStatus,
      ...(semanticRuntime?.reason ? { reason: semanticRuntime.reason } : {}),
      ...(semanticRuntime?.message ? { message: semanticRuntime.message } : {}),
    },
    registries,
    sourceProviders,
    indexStats,
  };
}

function readIndexStats(resolvedPath: string): InfoResponse["indexStats"] {
  const EMPTY: InfoResponse["indexStats"] = {
    entryCount: 0,
    lastBuiltAt: null,
    hasEmbeddings: false,
    vecAvailable: false,
  };

  if (!fs.existsSync(resolvedPath)) return EMPTY;

  let db: Database | undefined;
  try {
    db = openExistingDatabase(resolvedPath);
    return {
      entryCount: getEntryCount(db),
      lastBuiltAt: getMeta(db, "builtAt") ?? null,
      hasEmbeddings: getMeta(db, "hasEmbeddings") === "1",
      vecAvailable: isVecAvailable(db),
    };
  } catch (err) {
    // Surface the error so operators can diagnose mismatches between
    // `akm info` and `akm health` rather than silently returning zeros.
    process.stderr.write(`[akm info] failed to read index stats from ${resolvedPath}: ${String(err)}\n`);
    return EMPTY;
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        /* ignore */
      }
    }
  }
}
