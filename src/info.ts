import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getAssetTypes } from "./asset-spec";
import { loadConfig } from "./config";
import { closeDatabase, getEntryCount, getMeta, isVecAvailable, openDatabase } from "./db";
import { getDbPath } from "./paths";
import type { InfoResponse } from "./stash-types";

// Version: prefer compile-time define, then package.json, then fallback
const infoVersion: string = (() => {
  if (typeof AKM_VERSION !== "undefined") return AKM_VERSION;
  try {
    const pkgPath = path.resolve(import.meta.dir ?? __dirname, "../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch {
    // swallow — running as compiled binary without package.json
  }
  return "0.0.0-dev";
})();

declare const AKM_VERSION: string;

/**
 * Assemble system info describing the current capabilities, configuration,
 * and index state. Used by `akm info`.
 *
 * @param options.dbPath - Override the database path (useful for testing)
 */
export function assembleInfo(options?: { dbPath?: string }): InfoResponse {
  const config = loadConfig();

  // Asset types
  const assetTypes = getAssetTypes();

  // Search modes
  const searchModes: string[] = ["fts"];
  if (config.semanticSearch) {
    searchModes.push("semantic");
    if (searchModes.includes("fts")) {
      searchModes.push("hybrid");
    }
  }

  // Registries (strip sensitive fields like apiKey from options)
  const registries = (config.registries ?? []).map((r) => ({
    url: r.url,
    ...(r.name ? { name: r.name } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
  }));

  // Stash providers
  const stashProviders = (config.stashes ?? []).map((s) => ({
    type: s.type,
    ...(s.name ? { name: s.name } : {}),
    ...(s.path ? { path: s.path } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
  }));

  // Index stats
  const indexStats = readIndexStats(options?.dbPath);

  return {
    version: infoVersion,
    assetTypes,
    searchModes,
    registries,
    stashProviders,
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

    // Check if any embeddings exist
    let hasEmbeddings = false;
    try {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number } | undefined;
      hasEmbeddings = (row?.cnt ?? 0) > 0;
    } catch {
      // embeddings table may not exist
    }

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
