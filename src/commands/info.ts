import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { getAssetTypes } from "../core/asset-spec";
import { loadConfig } from "../core/config";
import { getDbPath } from "../core/paths";
import { closeDatabase, getEntryCount, getMeta, isVecAvailable, openDatabase } from "../indexer/db";
import { getEffectiveSemanticStatus, readSemanticStatus } from "../indexer/semantic-status";
import type { InfoResponse } from "../sources/source-types";
import { pkgVersion } from "../version";

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

  // Stash providers
  const sourceProviders = (config.sources ?? config.stashes ?? []).map((s) => ({
    type: s.type,
    ...(s.name ? { name: s.name } : {}),
    ...(s.path ? { path: s.path } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
  }));

  // Index stats
  const indexStats = readIndexStats(options?.dbPath);

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

function readIndexStats(dbPath?: string): InfoResponse["indexStats"] {
  const resolvedPath = dbPath ?? getDbPath();

  // If no index file exists, return zeros
  if (!fs.existsSync(resolvedPath)) {
    return {
      entryCount: 0,
      lastBuiltAt: null,
      hasEmbeddings: false,
      vecAvailable: false,
    };
  }

  let db: Database | undefined;
  try {
    db = openDatabase(resolvedPath);
    const entryCount = getEntryCount(db);
    const lastBuiltAt = getMeta(db, "builtAt") ?? null;
    const vecAvailable = isVecAvailable(db);
    const hasEmbeddings = getMeta(db, "hasEmbeddings") === "1";

    return {
      entryCount,
      lastBuiltAt,
      hasEmbeddings,
      vecAvailable,
    };
  } catch {
    return {
      entryCount: 0,
      lastBuiltAt: null,
      hasEmbeddings: false,
      vecAvailable: false,
    };
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
