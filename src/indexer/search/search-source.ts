// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isWithin, relativeToRoot, resolveStashDir, safeRealpath, toErrorMessage } from "../../core/common";
import type { AkmConfig, SourceConfigEntry } from "../../core/config/config";
import {
  bundleKeyForContentRoot,
  bundlesToSourceEntries,
  getSources,
  isBundleEnabled,
  loadConfig,
} from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { getLocationBundleRoot, getUnresolvedSourcesDir } from "../../core/paths";
import { warn } from "../../core/warn";
import { resolveGitContentRoot, resolveWritable } from "../../core/write-source";
import { lockContentRootFor } from "../../integrations/lockfile";
import { resolveSourceProviderFactory } from "../../sources/provider-factory";
import { ensureWebsiteMirror } from "../../sources/snapshot-fetchers/website-ingest";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchSource {
  path: string;
  /** Explicit working/default status; never inferred from array position. */
  isDefault?: boolean;
  /** For installed sources, the installed stash id */
  registryId?: string;
  /** Effective policy after applying `resolveWritable`. */
  writable?: boolean;
  /** Configured provider kind when this source has a config owner. */
  type?: SourceConfigEntry["type"];
  /** The adapter the bundle is configured with. Index preflight fills and persists missing ownership. */
  adapterId?: string;
  /** Set when the source's provider/path could not be resolved this run: why, and its real directory when it has one. */
  unresolved?: { reason: string; path?: string };
  /** A location bundle's configured `location`: where its adapter finds it. `path` is then the root its entries are indexed under. */
  location?: string;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * The working stash read besides the configured bundles: an explicit argument,
 * else `AKM_BUNDLE_DIR`, else the platform default stash when no `defaultBundle`
 * is configured. With a `defaultBundle` and no override there is none, because
 * the configured bundle is the working stash. Throws as `resolveStashDir` does
 * when the directory is missing.
 */
export function implicitStashDir(config: AkmConfig, overrideStashDir?: string): string | undefined {
  if (overrideStashDir !== undefined) return path.resolve(overrideStashDir);
  if (process.env.AKM_BUNDLE_DIR?.trim()) return resolveStashDir();
  return config.defaultBundle ? undefined : resolveStashDir();
}

/**
 * Build the ordered list of stash sources, walking every configured stash
 * once. Iteration order:
 *
 *   1. An explicit argument or `AKM_BUNDLE_DIR`, when present.
 *   2. The configured `defaultBundle`, after root validation.
 *   3. Remaining configured bundles in installation-priority order.
 *
 * Disabled entries (`enabled: false`) are excluded before materialization.
 * Missing configured roots remain in the result so the
 * indexer can classify their scan as incomplete instead of mistaking them for
 * removed sources.
 */
export function resolveSourceEntries(overrideStashDir?: string, existingConfig?: AkmConfig): SearchSource[] {
  const config = existingConfig ?? loadConfig();
  const configuredEntries = bundlesToSourceEntries(config) ?? [];
  const implicitStash = implicitStashDir(config, overrideStashDir);

  const implicitConfiguredBundle = implicitStash ? bundleKeyForContentRoot(config, implicitStash) : undefined;
  if (implicitConfiguredBundle && !isBundleEnabled(config, implicitConfiguredBundle)) {
    throw new ConfigError(
      `The requested working source is disabled as bundle ${JSON.stringify(implicitConfiguredBundle)}.`,
      "INVALID_CONFIG_FILE",
    );
  }

  // Explicit and environment overrides stay first. Without either override,
  // the configured default enters through the validated loop below.
  // A source's path is its real path, so one directory reached through two spellings
  // (a symlink, macOS `/tmp` and `/private/tmp`) keys the same index rows.
  const sources: SearchSource[] = implicitStash
    ? [{ path: safeRealpath(implicitStash), writable: true, isDefault: true, type: "filesystem" }]
    : [];
  const seen = new Set<string>(implicitStash ? [safeRealpath(implicitStash)] : []);

  const addSource = (
    dir: string,
    registryId: string | undefined,
    writable: boolean,
    type: SourceConfigEntry["type"],
    adapterId?: string,
    unresolved?: { reason: string; path?: string },
    isDefault = false,
    location?: string,
  ) => {
    const resolved = path.resolve(dir);
    const identity = safeRealpath(resolved);
    if (seen.has(identity)) {
      // Already in the source list — typically the primary stash injected at
      // sources[0] before this loop. Enrich that entry with whatever metadata
      // the matching config source carries so `--from <config-name>` can
      // find it via registryId. Without this, the primary stash entry stays
      // identity-less and a user-named primary source ("name": "my-stash")
      // would validate but match zero entries when filtering.
      const existing = sources.find((source) => safeRealpath(source.path) === identity);
      if (existing && existing.registryId === undefined) {
        if (registryId) existing.registryId = registryId;
        if (isDefault) existing.isDefault = true;
        existing.type = type;
        existing.writable = writable;
        existing.adapterId = adapterId;
      }
      if (existing && unresolved) existing.unresolved = unresolved;
      return;
    }
    seen.add(identity);
    if (isSuspiciousStashRoot(dir)) {
      warn(`Warning: stash root "${dir}" appears to be a system directory. This may be unintentional.`);
    }
    sources.push({
      path: identity,
      ...(registryId ? { registryId } : {}),
      ...(isDefault ? { isDefault: true } : {}),
      writable,
      type,
      ...(adapterId ? { adapterId } : {}),
      ...(unresolved ? { unresolved } : {}),
      ...(location ? { location } : {}),
    });
  };

  // Resolve from `bundles` + `defaultBundle`.
  // `bundlesToSourceEntries` returns the configured default first, then map
  // insertion order. Each entry is validated before insertion so a bundle
  // root can never escape its provider's materialized content root.
  for (const entry of configuredEntries) {
    if (entry.enabled === false) continue;
    const bundle = config.bundles?.[entry.name ?? ""];
    const resolvedContent = resolveEntryContent(entry);
    if ("error" in resolvedContent) {
      const unresolvedPath = path.join(
        getUnresolvedSourcesDir(implicitStash ?? process.cwd()),
        entry.name ?? entry.type,
      );
      addSource(
        unresolvedPath,
        entry.name,
        resolveWritable(entry),
        entry.type,
        bundle?.adapter,
        { reason: resolvedContent.error },
        entry.name === config.defaultBundle,
      );
      continue;
    }
    const contentRoot = resolvedContent.dir;
    const dir = path.resolve(contentRoot, bundle?.root ?? ".");
    if (!isWithin(dir, contentRoot)) {
      warn(`Warning: root "${bundle?.root}" escapes bundle "${entry.name}"; skipping source.`);
      const unresolvedPath = path.join(getUnresolvedSourcesDir(contentRoot), entry.name ?? entry.type);
      addSource(
        unresolvedPath,
        entry.name,
        resolveWritable(entry),
        entry.type,
        bundle?.adapter,
        { reason: `root "${bundle?.root}" escapes bundle "${entry.name}"`, path: dir },
        entry.name === config.defaultBundle,
      );
      continue;
    }
    addSource(
      dir,
      entry.name,
      resolveWritable(entry),
      entry.type,
      bundle?.adapter,
      undefined,
      entry.name === config.defaultBundle,
      entry.location,
    );
  }

  return sources;
}

/**
 * The content directory the indexer should walk for a config entry: `{ dir }`, or `{ error }` with the
 * provider's own reason there is none, so the caller can skip the entry and say why.
 *
 * Single source of truth: each provider owns its own path. We instantiate the
 * registered {@link import("../../sources/provider").SourceProvider} for the entry
 * and call `provider.path()`.
 *
 * The git case still does one extra step: the provider returns the cloned
 * repo dir, but the indexer walks the `content/` subdirectory inside it.
 * That convention is part of the akm content layout, not a provider concern,
 * so it stays here.
 */
export function resolveEntryContent(entry: SourceConfigEntry): { dir: string } | { error: string } {
  // §10.2 desired/resolved split: a git/npm bundle's desired config
  // carries only the source LOCATOR, not the materialized cache root — the
  // resolved root lives in the lock (`localRoot`). Resolve from there first via
  // the SHARED lock-first resolver (the same one write-source consults, so reads
  // and writes agree on where content is); the localRoot is the already-walkable
  // content root (installed sources are extracted to their content dir), so no
  // content/-subdir step is applied. Fall back to the provider path logic when no
  // lock entry exists (for example while a configured source is being
  // materialized for the first time).
  const localRoot = lockContentRootFor(entry.name, entry.type);
  if (localRoot != null) return { dir: localRoot };
  // A location bundle has no content directory: its adapter reads it, and its entries are indexed under this root.
  if (entry.type === "location") return { dir: getLocationBundleRoot(entry.name ?? entry.location ?? "") };

  const factory = resolveSourceProviderFactory(entry.type);
  if (!factory) return { error: `no source provider is registered for type "${entry.type}"` };

  let provider: import("../../sources/provider").SourceProvider;
  try {
    provider = factory(entry);
  } catch (err) {
    return { error: toErrorMessage(err) };
  }

  let dir: string;
  try {
    dir = provider.path();
  } catch (err) {
    return { error: toErrorMessage(err) };
  }

  // Git providers expose the cloned repo root as their path. The akm content
  // layout puts indexable files under `<repo>/content/`, so the walker needs
  // that subdirectory. This is a content-layout convention, not a provider
  // capability — keep it here.
  return { dir: entry.type === "git" ? resolveGitContentRoot(dir) : dir };
}

/**
 * Find which source a file path belongs to.
 *
 * Longest-matching-prefix wins: a source nested inside another (e.g. `akm add
 * ./sub` where `./sub` lives under the primary stash — which is always
 * `sources[0]`) is the more specific owner and must win over the enclosing
 * source regardless of array order. A first-match-in-order scan would
 * misattribute every asset under the nested source to the primary stash,
 * corrupting origin / editability / provenance decisions for the affected files.
 */
export function findSourceForPath(filePath: string, sources: SearchSource[]): SearchSource | undefined {
  // A caller's path may spell the library another way (a symlink); only then are real paths compared.
  return (
    findSourceForIndexedPath(filePath, sources) ??
    longestSource(sources, (base) => relativeToRoot(filePath, base) !== undefined)
  );
}

/**
 * {@link findSourceForPath} for a path read from the index. The index and the sources both store the library's real
 * path, so the spelling is compared and nothing is read from disk: filtering every index row stays fast.
 */
export function findSourceForIndexedPath(filePath: string, sources: SearchSource[]): SearchSource | undefined {
  const resolved = path.resolve(filePath);
  return longestSource(sources, (base) => resolved.startsWith(base + path.sep));
}

function longestSource(sources: SearchSource[], within: (base: string) => boolean): SearchSource | undefined {
  let best: SearchSource | undefined;
  let bestLen = -1;
  for (const source of sources) {
    const base = path.resolve(source.path);
    if (base.length > bestLen && within(base)) {
      best = source;
      bestLen = base.length;
    }
  }
  return best;
}

// ── Editability ─────────────────────────────────────────────────────────────

/**
 * Determine whether AKM policy allows modifying this exact file in place.
 * Ownership is resolved by longest source-root match and unknown ownership
 * fails closed. Resolved sources already carry canonical `resolveWritable()`
 * semantics; editability is never persisted in the index.
 */
export function isEditable(filePath: string, config?: AkmConfig, sources?: SearchSource[]): boolean {
  const resolvedSources = sources ?? resolveSourceEntries(undefined, config ?? loadConfig());
  return findSourceForPath(filePath, resolvedSources)?.writable === true;
}

/**
 * Build an actionable hint for the agent when a file is not editable.
 * Callers must check `isEditable()` before calling — this function
 * unconditionally returns the hint string.
 */
export function buildEditHint(ref: string): string {
  return `This asset is read-only under current AKM source policy. To make an editable copy, run: akm import ${ref} --asset-ref`;
}

// ── Validation ──────────────────────────────────────────────────────────────

const SUSPICIOUS_ROOTS = new Set(["/", "/etc", "/bin", "/sbin", "/usr", "/var", "/tmp", "/dev", "/proc", "/sys"]);

function isSuspiciousStashRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (SUSPICIOUS_ROOTS.has(normalized)) return true;
  if (process.platform === "win32") {
    // Check for Windows system directories
    const winDir = (process.env.SystemRoot || "C:\\Windows").toLowerCase();
    if (normalized === winDir || normalized.startsWith(winDir + path.sep)) return true;
  }
  return false;
}

// ── Stash cache integration ─────────────────────────────────────────────────

/**
 * Ensure all cache-backed stash providers are refreshed so their cache
 * directories exist on disk. Must be called (async) before
 * `resolveSourceEntries()` so the content directories pass the
 * `isValidDirectory()` check.
 *
 * Sources are never refreshed here: `sync()` is called without `force`, so a
 * source is fetched only when it has never been materialized on this host.
 * `akm bundle update` is what refreshes one.
 *
 * `materialize` (default `true`) says whether a build may clone/pull/fetch missing cache-backed sources.
 * `bundle update` passes `false` (it has just fetched): a present cache is used as it is, and an absent or
 * partially staged one makes that source unavailable, skipped with one warning naming the remedy.
 */
export async function ensureSourceCaches(
  config?: AkmConfig,
  options?: {
    materialize?: boolean;
    secrets?: import("../../sources/provider").SecretResolver;
    /**
     * One event per source about to sync (`Hydrating source i/n: <name>`),
     * plus a 15s heartbeat while that source's sync is in flight (#954)
     * — before this, a stalled clone/fetch here (this runs
     * BEFORE `index.db` is even opened) had no progress output at all and
     * looked identical to "no database open, nothing written".
     */
    onProgress?: (message: string) => void;
  },
): Promise<void> {
  const cfg = config ?? loadConfig();
  const materialize = options?.materialize !== false;
  const onProgress = options?.onProgress ?? (() => {});
  // Polymorphic refresh: walk every enabled source through its registered
  // provider and call `sync()`. Every cache-backed kind (git, website, npm)
  // refreshes the same way — a bad source warns and is skipped without
  // aborting the others. The git content/-subdir layout convention stays in
  // resolveEntryContent. Provider projection comes only from `bundles`.
  //
  // DISTINCTION (deliberately NOT lock-first): refresh derives the PROVIDER's
  // own cache path to git-pull/re-materialize INTO — that derived path is where
  // content ENDS UP; the lock's `localRoot` merely records the result. So this
  // path correctly uses the provider, not the shared `lockContentRootFor`
  // resolver that reads/writes use to agree on where content already IS.
  //
  // Two passes: first resolve which sources will actually sync (constructing
  // each provider once, exactly as before), so the progress count ("i/n")
  // reflects real syncs rather than every configured entry including managed/
  // unsyncable ones; then sync them in order, reporting progress per source.
  const toSync: import("../../sources/provider").SourceProvider[] = [];
  for (const entry of getSources(cfg)) {
    if (entry.enabled === false) continue;
    const lockedRoot = lockContentRootFor(entry.name, entry.type);
    if (lockedRoot) {
      if (!isMaterializedDir(lockedRoot)) {
        warn(
          `Warning: managed source "${entry.name}" is missing its locked materialization at ${lockedRoot}; ` +
            `run \`akm bundle update ${entry.name}\` to restore it.`,
        );
      }
      // Managed installs are refreshed only by add/update. Hydrating the URL-
      // derived provider cache here would create a second checkout while reads
      // and writes continue using the lock root.
      continue;
    }
    if (entry.type === "npm") {
      // A configured npm bundle with no lock entry has no walkable path (its
      // provider path is the package spec), and nothing marks it materialized,
      // so syncing it here would hit the npm registry on every index run and
      // still leave it unindexed. `akm bundle update` installs it and writes
      // the lock entry.
      warn(
        `Warning: npm source "${entry.name}" is not installed; skipping it. ` +
          `Run \`akm bundle update ${entry.name}\` to install it.`,
      );
      continue;
    }
    const factory = resolveSourceProviderFactory(entry.type);
    if (!factory) continue;

    let provider: import("../../sources/provider").SourceProvider;
    try {
      provider = factory(entry);
    } catch (err) {
      warn(
        `Warning: failed to construct ${entry.type} source provider for "${entry.name ?? entry.url ?? entry.path}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    if (!provider.sync) continue;

    if (!materialize) {
      // READ path: never clone/pull/fetch. Serve an already-materialized cache
      // as last-known-good; skip an absent/partial one with a single warning.
      warnIfSourceUnavailableForRead(entry, provider.name);
      continue;
    }

    toSync.push(provider);
  }

  for (const [i, provider] of toSync.entries()) {
    onProgress(`Hydrating source ${i + 1}/${toSync.length}: ${provider.name}`);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => {
        onProgress(`Still hydrating source ${i + 1}/${toSync.length}: ${provider.name}...`);
      }, 15000);
      // `toSync` only ever holds providers whose `.sync` passed the check
      // above; the optional-chain here is just to satisfy the type (the
      // narrowing does not survive the array round-trip).
      await provider.sync?.({ secrets: options?.secrets, ensureWebsiteMirror });
    } catch (err) {
      warn(
        `Warning: failed to refresh ${provider.kind} source "${provider.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

/**
 * True when `dir` holds already-materialized content: it exists, is a
 * directory, and is non-empty. A non-existent path or an empty leftover /
 * partial staging dir reads as NOT materialized so the read skips it rather
 * than walking a hollow cache.
 */
function isMaterializedDir(dir: string): boolean {
  try {
    // asset-io: install checkout probe
    if (!fs.statSync(dir).isDirectory()) return false;
    // asset-io: install checkout probe
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * When a build does not materialize sources, warn (once per source) that a cache-backed source
 * is not materialized locally and is being skipped — naming the remedy. Uses
 * the SAME lock-first content-root resolution the walker uses, so an installed
 * source whose content lives at its lock `localRoot` counts as materialized.
 */
function warnIfSourceUnavailableForRead(entry: SourceConfigEntry, providerName: string): void {
  const resolved = resolveEntryContent(entry);
  if ("dir" in resolved && isMaterializedDir(resolved.dir)) return;
  const why = "error" in resolved ? ` (${resolved.error})` : "";
  warn(
    `Warning: source "${providerName}" is not materialized locally${why}; skipping it for this read. ` +
      "Run `akm index` (or `akm bundle update`) to fetch it.",
  );
}
