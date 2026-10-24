// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { placementTypes } from "../../core/asset/asset-placement";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { DEFAULT_CONFIG, getSources, loadConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getCacheDir, getConfigDir, getDataDir, getDefaultStashDir, getStateDir } from "../../core/paths";
import { formatRegistryUrl } from "../../core/registry-url";
import { error } from "../../core/warn";
import type { InfoResponse } from "../../sources/types";
import type { Database } from "../../storage/database";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryCount, getEntryCountByType } from "../../storage/repositories/index-entries-repository";
import { countLinksByKind } from "../../storage/repositories/index-links-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { isSqliteContentionError } from "../../storage/sqlite-transaction";
import { pkgVersion } from "../../version";

/**
 * Bound for `akm info`'s diagnostic index.db read — short enough that a
 * locked database never stalls the command, unlike the shared 30s
 * `SQLITE_BUSY_TIMEOUT_MS` every write-capable opener uses. The opener's own
 * layout check (`checkIndexLayout`) swallows a busy error on its one SELECT
 * rather than surfacing it, so a genuinely locked database costs this
 * timeout TWICE before the first real query here (`countLinksByKind`)
 * throws for real — 750ms keeps that ~1.5s worst case well clear of the 3s
 * bound integration tests hold this to, on a loaded CI box.
 */
const INFO_INDEX_BUSY_TIMEOUT_MS = 750;

/**
 * Assemble system info describing the current capabilities, configuration,
 * and index state. Used by `akm info`, which must behave like a help
 * command (owner ruling): always print a report and exit 0, whatever else
 * is happening. Every section below is read best-effort, so one failing
 * lookup degrades only its own field(s) instead of the whole report;
 * `infoCommand` itself (stash-cli.ts) wraps this whole call as the final
 * backstop for anything left over — e.g. a path resolver that needs an
 * environment variable nothing here sets, such as `HOME`.
 *
 * @param options.dbPath - Override the database path (useful for testing)
 */
export function assembleInfo(options?: { dbPath?: string }): InfoResponse {
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
  // agree on which stash is primary. No bundle created yet
  // (STASH_DIR_NOT_FOUND, the ordinary fresh-install state) reports where a
  // fresh `akm setup`/`akm bundle create` would put it, same as "report the
  // defaults" for a missing config — no error needed, nothing is actually
  // wrong. A bundle that WAS configured (an env override or `bundles.*` in
  // config) but doesn't resolve (STASH_DIR_UNREADABLE/STASH_DIR_NOT_A_DIRECTORY)
  // is different: the fallback path is a courtesy, not a way to hide a
  // genuine misconfiguration, so that reason is kept in `bundleDirError`.
  let stashDir: string;
  let bundleDirError: string | undefined;
  try {
    stashDir = resolveStashDir();
  } catch (err) {
    if (!(err instanceof ConfigError) || err.code !== "STASH_DIR_NOT_FOUND") {
      bundleDirError = err instanceof Error ? err.message : String(err);
    }
    // The fallback itself resolves purely from `HOME` (or its platform
    // equivalent) and can throw the exact same way `resolveStashDir()` can
    // (e.g. HOME entirely unset) — guarded so a blank `bundleDir` (never a
    // throw) still always carries a reason, reusing the one above when the
    // outer catch already set it (a configured-but-broken path takes
    // precedence over restating "and the default isn't resolvable either").
    try {
      stashDir = getDefaultStashDir();
    } catch (fallbackErr) {
      stashDir = "";
      bundleDirError ??= fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    }
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

  // Data directory. `getDataDir()` can itself throw (e.g. TEST_ISOLATION_MISSING
  // when NODE_ENV=test leaks into a real invocation — a JS test runner's
  // child process — with no XDG_DATA_HOME/AKM_DATA_DIR override), caught
  // here so that failure degrades only `dataDir`/`indexStats` rather than
  // the whole report. Always attempted, even when `options.dbPath` (a
  // test-only override, see the param doc above) means it is not needed to
  // resolve the index path below — `dataDir` is its own reported field.
  let dataDir = "";
  let dataDirError: string | undefined;
  try {
    dataDir = getDataDir();
  } catch (err) {
    dataDirError = err instanceof Error ? err.message : String(err);
  }

  // Index stats. `options.dbPath` overrides the resolved path outright;
  // otherwise it is derived from `dataDir` above, so a data dir that failed
  // to resolve degrades index stats the same way rather than retrying (and
  // re-throwing) `getDataDir()` a second time.
  const resolvedDbPath = options?.dbPath ?? (dataDir ? path.join(dataDir, "index.db") : undefined);
  const indexStats: InfoResponse["indexStats"] = resolvedDbPath
    ? readIndexStats(resolvedDbPath)
    : { entryCount: 0, byType: {}, lastBuiltAt: null, hasEmbeddings: false, unavailable: dataDirError };

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
    ...(bundleDirError ? { bundleDirError } : {}),
    dataDir,
    configDir: safePath(getConfigDir),
    cacheDir: safePath(getCacheDir),
    stateDir: safePath(getStateDir),
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

/** Best-effort path resolution for a section that must degrade, not throw: an empty string in place of an exception. */
function safePath(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "";
  }
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
    // Never writes the index — no schema or journal-mode change — and
    // bounded to INFO_INDEX_BUSY_TIMEOUT_MS rather than the shared 30s
    // busy_timeout every write-capable opener uses. A newer index layout is
    // reported below rather than refused (checkIndexLayout throws); an
    // older layout just warns and is served as-is, never migrated — both
    // already true of this opener.
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
 * Reason for `indexStats.unavailable`. Contention gets its own clear
 * wording; everything else (a too-new layout, on-disk corruption, ...) is
 * already descriptive as the driver/opener's own message.
 */
function describeIndexReadFailure(err: unknown): string {
  if (isSqliteContentionError(err)) return "index.db is locked by another akm process";
  return err instanceof Error ? err.message : String(err);
}
