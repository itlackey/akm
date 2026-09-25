// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { placementTypes } from "../../core/asset/asset-placement";
import { resolveStashDir } from "../../core/common";
import { getSources, loadConfig } from "../../core/config/config";
import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getCacheDir, getConfigDir, getDataDir, getDbPath, getStateDir } from "../../core/paths";
import { formatRegistryUrl } from "../../core/registry-url";
import { error } from "../../core/warn";
import type { InfoResponse } from "../../sources/types";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryCount, getEntryCountByType } from "../../storage/repositories/index-entries-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { isVecAvailable } from "../../storage/repositories/index-vec-repository";
import { pkgVersion } from "../../version";

/**
 * Assemble system info describing the current capabilities, configuration,
 * and index state. Used by `akm info`.
 *
 * @param options.dbPath - Override the database path (useful for testing)
 */
export function assembleInfo(options?: { dbPath?: string }): InfoResponse {
  const config = loadConfig();

  // Primary stash directory + default bundle name — same resolution
  // `akm sources list` uses (R-057), so `akm info` and `akm sources list`
  // agree on which stash is primary.
  const stashDir = resolveStashDir();
  const defaultBundle = config.defaultBundle ?? null;

  // Asset types (copy into a mutable array — `placementTypes()` returns readonly)
  const assetTypes = [...placementTypes()];

  // Registries (strip sensitive fields like apiKey from options)
  const registries = (config.registries ?? []).map((r) => ({
    url: formatRegistryUrl(r.url),
    ...(r.name ? { name: r.name } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
  }));

  // Stash providers — the unified `bundles` source list (spec §10.1), which
  // already includes the primary (`defaultBundle`) stash first.
  const configuredSources = getSources(config);
  const sourceProviders = configuredSources.map((s) => ({
    type: s.type,
    ...(s.name ? { name: s.name } : {}),
    ...(s.path ? { path: s.path } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
  }));

  // Index stats — `options.dbPath` is a test-only override (see the param
  // doc above); real callers fall through to the same `getDbPath()` that
  // health and search use, so info reads the same database they do.
  const resolvedDbPath = options?.dbPath ?? getDbPath();
  const indexStats = readIndexStats(resolvedDbPath);

  // Semantic status is read live from the index's own state, not a cached
  // verdict — a failed embed attempt at search time falls back to FTS and
  // reports that in the search response, it never disables the mode here.
  const semanticStatus: InfoResponse["semanticSearch"]["status"] =
    config.semanticSearchMode === "off"
      ? "disabled"
      : !indexStats.hasEmbeddings
        ? "pending"
        : indexStats.vecAvailable
          ? "ready-vec"
          : "ready-js";
  const searchModes: string[] = ["fts"];
  if (semanticStatus === "ready-js" || semanticStatus === "ready-vec") {
    searchModes.push("semantic", "hybrid");
  }

  return {
    schemaVersion: 1,
    version: pkgVersion,
    bundleDir: stashDir,
    defaultBundle,
    dataDir: getDataDir(),
    configDir: getConfigDir(),
    cacheDir: getCacheDir(),
    stateDir: getStateDir(),
    assetTypes,
    searchModes,
    semanticSearch: {
      mode: config.semanticSearchMode,
      status: semanticStatus,
    },
    registries,
    sourceProviders,
    indexStats,
  };
}

function readIndexStats(resolvedPath: string): InfoResponse["indexStats"] {
  const EMPTY: InfoResponse["indexStats"] = {
    entryCount: 0,
    byType: {},
    lastBuiltAt: null,
    hasEmbeddings: false,
    vecAvailable: false,
  };

  // "Absent" is the ordinary first-run state; "inaccessible" is a fault that
  // must not present as an empty index (#791). `akm info` is the command an
  // operator reaches for to DIAGNOSE this, so it reports rather than throws —
  // but it says so explicitly instead of returning zeros that look healthy.
  const { access, code } = classifyPathAccess(resolvedPath);
  if (access === "absent") return EMPTY;
  if (access === "inaccessible") {
    const detail = describeInaccessiblePath(resolvedPath, code);
    error(`[akm info] index database is not readable: ${detail}`);
    return { ...EMPTY, unreadable: detail };
  }

  let db: Database | undefined;
  try {
    db = openExistingDatabase(resolvedPath);
    return {
      entryCount: getEntryCount(db),
      byType: getEntryCountByType(db),
      lastBuiltAt: getMeta(db, "builtAt") ?? null,
      hasEmbeddings: getMeta(db, "hasEmbeddings") === "1",
      vecAvailable: isVecAvailable(db),
    };
  } catch (err) {
    // Surface the error so operators can diagnose mismatches between
    // `akm info` and `akm health` rather than silently returning zeros.
    // Routed through core/warn's `error()` (not a raw process.stderr.write)
    // so `--quiet`/`setQuiet()` actually gate this line (R-057).
    error(`[akm info] failed to read index stats from ${resolvedPath}: ${String(err)}`);
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
