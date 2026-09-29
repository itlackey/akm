// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { placementTypes } from "../../core/asset/asset-placement";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { DEFAULT_CONFIG, getSources, loadConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getCacheDir, getConfigDir, getDataDir, getDbPath, getDefaultStashDir, getStateDir } from "../../core/paths";
import { formatRegistryUrl } from "../../core/registry-url";
import { error } from "../../core/warn";
import type { InfoResponse } from "../../sources/types";
import type { Database } from "../../storage/database";
import {
  closeDatabase,
  isCorruptionError,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { getEntryCount, getEntryCountByType } from "../../storage/repositories/index-entries-repository";
import { countLinksByKind } from "../../storage/repositories/index-links-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { isSqliteContentionError } from "../../storage/sqlite-transaction";
import { pkgVersion } from "../../version";

/**
 * Bound for `akm info`'s diagnostic index.db read. `akm info` must behave
 * like a help command (owner ruling): it always reports within a couple of
 * seconds and never sits behind another akm process's write lock, unlike the
 * shared 30s `SQLITE_BUSY_TIMEOUT_MS` every write-capable opener uses.
 *
 * `openReadonlyExistingDatabase`'s own layout check (`checkIndexLayout`)
 * swallows a busy error on its one SELECT rather than surfacing it, so a
 * genuinely locked database costs this timeout TWICE before the first real
 * query here (`countLinksByKind`) throws for real — 750ms keeps that ~1.5s
 * worst case well clear of the 3s bound integration tests hold this to, on a
 * loaded CI box, while still being "about 1 second" per read.
 */
const INFO_INDEX_BUSY_TIMEOUT_MS = 750;

/**
 * Assemble system info describing the current capabilities, configuration,
 * and index state. Used by `akm info`.
 *
 * @param options.dbPath - Override the database path (useful for testing)
 */
export function assembleInfo(options?: { dbPath?: string }): InfoResponse {
  // `akm info` must behave like a help command (owner ruling): it always
  // prints a report and exits 0, whatever else is happening. Config and the
  // stash directory are read best-effort so an invalid/missing one degrades
  // to a reported reason instead of throwing and aborting the command.
  let config: AkmConfig;
  let configError: string | undefined;
  try {
    config = loadConfig();
  } catch (err) {
    config = DEFAULT_CONFIG;
    configError = err instanceof Error ? err.message : String(err);
  }

  // Primary stash directory + default bundle name — same resolution
  // `akm sources list` uses (R-057), so `akm info` and `akm sources list`
  // agree on which stash is primary. No bundle created yet (or the
  // configured one is unusable) reports where a fresh `akm setup`/`akm
  // bundle create` would put it — the same "report the defaults" treatment
  // a missing config gets, not a refusal.
  let stashDir: string;
  try {
    stashDir = resolveStashDir();
  } catch {
    stashDir = getDefaultStashDir();
  }
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
    config.semanticSearchMode === "off" ? "disabled" : indexStats.hasEmbeddings ? "ready-js" : "pending";
  const searchModes: string[] = ["fts"];
  if (semanticStatus === "ready-js") {
    searchModes.push("semantic", "hybrid");
  }

  return {
    schemaVersion: 1,
    version: pkgVersion,
    bundleDir: stashDir,
    defaultBundle,
    ...(configError ? { configError } : {}),
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
    // Strictly read-only — no schema/journal-mode writes — and bounded to
    // INFO_INDEX_BUSY_TIMEOUT_MS rather than the shared 30s busy_timeout
    // every write-capable opener uses: `akm info` must always report within
    // a couple of seconds, never wait behind another akm process's write
    // lock. A newer index layout is reported below rather than refused
    // (checkIndexLayout throws; an older layout just warns and is served
    // as-is, never migrated — both already true of this opener).
    db = openReadonlyExistingDatabase(resolvedPath, { busyTimeoutMs: INFO_INDEX_BUSY_TIMEOUT_MS });
    if (!db) return EMPTY; // raced away (deleted) between the access check above and here
    const links = countLinksByKind(db);
    return {
      entryCount: getEntryCount(db),
      byType: getEntryCountByType(db),
      ...(Object.keys(links).length > 0 ? { links } : {}),
      lastBuiltAt: getMeta(db, "builtAt") ?? null,
      hasEmbeddings: getMeta(db, "hasEmbeddings") === "1",
    };
  } catch (err) {
    // Surface the error so operators can diagnose mismatches between
    // `akm info` and `akm health` rather than silently returning zeros.
    // Routed through core/warn's `error()` (not a raw process.stderr.write)
    // so `--quiet`/`setQuiet()` actually gate this line (R-057).
    error(`[akm info] failed to read index stats from ${resolvedPath}: ${String(err)}`);
    return { ...EMPTY, unavailable: describeIndexReadFailure(err) };
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

/**
 * Turn a caught index-read failure into a short, stable reason for
 * `indexStats.unavailable`. Contention and a too-new layout get their own
 * clear wording (the layout error from `checkIndexLayout` is already
 * descriptive); on-disk corruption is named explicitly; anything else falls
 * back to the driver's own message.
 */
function describeIndexReadFailure(err: unknown): string {
  if (err instanceof ConfigError && err.code === "INDEX_SCHEMA_INCOMPATIBLE") return err.message;
  if (isSqliteContentionError(err)) return "index.db is locked by another akm process";
  if (isCorruptionError(err)) return `index.db is corrupt: ${err instanceof Error ? err.message : String(err)}`;
  return err instanceof Error ? err.message : String(err);
}
