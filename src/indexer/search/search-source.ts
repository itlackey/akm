// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isWithin, resolveStashDir } from "../../core/common";
import type { AkmConfig, SourceConfigEntry } from "../../core/config/config";
import { bundleComponentConfig, bundlesToSourceEntries, getSources, loadConfig } from "../../core/config/config";
import { getUnresolvedSourcesDir } from "../../core/paths";
import { resolveGitContentRoot, resolveWritable } from "../../core/write-source";
import { lockContentRootFor } from "../../integrations/lockfile";
import { resolveSourceProviderFactory } from "../../sources/provider-factory";
import { ensureWebsiteMirror } from "../../sources/snapshot-fetchers/website-ingest";
// Eager side-effect imports so all built-in source providers self-register
// before resolveEntryContentDir() runs.
import "../../sources/providers/index";
import { warn } from "../../core/warn";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchSource {
  path: string;
  /** For installed sources, the installed stash id */
  registryId?: string;
  /** Effective policy after applying `resolveWritable`. */
  writable?: boolean;
  /** Configured provider kind when this source has a config owner. */
  type?: SourceConfigEntry["type"];
  /** Adapter selected for this bundle component. Index preflight fills and persists missing ownership. */
  adapterId?: string;
  /** Configured source whose provider/path could not be resolved this run. */
  unresolved?: boolean;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources, walking every configured stash
 * once. Iteration order:
 *
 *   1. An explicit argument or `AKM_BUNDLE_DIR`, when present.
 *   2. The configured `defaultBundle`, after component-root validation.
 *   3. Remaining configured bundles in installation-priority order.
 *
 * Disabled entries (`enabled: false`) are filtered after deduplication.
 * Missing configured roots remain in the result so the
 * indexer can classify their scan as incomplete instead of mistaking them for
 * removed sources.
 */
export function resolveSourceEntries(overrideStashDir?: string, existingConfig?: AkmConfig): SearchSource[] {
  const config = existingConfig ?? loadConfig();
  const configuredEntries = bundlesToSourceEntries(config) ?? [];
  const envOverride = process.env.AKM_BUNDLE_DIR?.trim();
  const implicitStashDir =
    overrideStashDir !== undefined
      ? path.resolve(overrideStashDir)
      : envOverride
        ? resolveStashDir()
        : config.defaultBundle
          ? undefined
          : resolveStashDir();

  // Explicit and environment overrides stay first. Without either override,
  // the configured default enters through the validated loop below.
  const sources: SearchSource[] = implicitStashDir ? [{ path: implicitStashDir, writable: true }] : [];
  const seen = new Set<string>(implicitStashDir ? [implicitStashDir] : []);

  const addSource = (
    dir: string,
    registryId: string | undefined,
    writable: boolean,
    type: SourceConfigEntry["type"],
    adapterId?: string,
    unresolved = false,
  ) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) {
      // Already in the source list — typically the primary stash injected at
      // sources[0] before this loop. Enrich that entry with whatever metadata
      // the matching config source carries so `--from <config-name>` can
      // find it via registryId. Without this, the primary stash entry stays
      // identity-less and a user-named primary source ("name": "my-stash")
      // would validate but match zero entries when filtering.
      const existing = sources.find((s) => s.path === resolved);
      if (existing && existing.type === undefined) {
        if (registryId) existing.registryId = registryId;
        existing.type = type;
        existing.writable = writable;
        existing.adapterId = adapterId;
      }
      if (existing && unresolved) existing.unresolved = true;
      return;
    }
    seen.add(resolved);
    if (isSuspiciousStashRoot(dir)) {
      warn(`Warning: stash root "${dir}" appears to be a system directory. This may be unintentional.`);
    }
    sources.push({
      path: resolved,
      ...(registryId ? { registryId } : {}),
      writable,
      type,
      ...(adapterId ? { adapterId } : {}),
      ...(unresolved ? { unresolved: true } : {}),
    });
  };

  // 0.9.0 shape (spec §10.1 / D-R5): resolve from `bundles` + `defaultBundle`.
  // `bundlesToSourceEntries` returns the configured default first, then map
  // insertion order. Each entry is validated before insertion so a component
  // root can never escape its provider's materialized content root.
  for (const entry of configuredEntries) {
    if (entry.enabled === false) continue;
    const component = bundleComponentConfig(config.bundles?.[entry.name ?? ""]);
    const contentRoot = resolveEntryContentDir(entry);
    if (contentRoot == null) {
      const unresolvedPath = path.join(
        getUnresolvedSourcesDir(implicitStashDir ?? process.cwd()),
        entry.name ?? entry.type,
      );
      addSource(
        unresolvedPath,
        entry.name,
        component?.writable ?? resolveWritable(entry),
        entry.type,
        component?.adapter,
        true,
      );
      continue;
    }
    const dir = path.resolve(contentRoot, component?.root ?? ".");
    if (!isWithin(dir, contentRoot)) {
      warn(`Warning: component root "${component?.root}" escapes bundle "${entry.name}"; skipping source.`);
      const unresolvedPath = path.join(getUnresolvedSourcesDir(contentRoot), entry.name ?? entry.type);
      addSource(
        unresolvedPath,
        entry.name,
        component?.writable ?? resolveWritable(entry),
        entry.type,
        component?.adapter,
        true,
      );
      continue;
    }
    addSource(dir, entry.name, component?.writable ?? resolveWritable(entry), entry.type, component?.adapter);
  }

  return sources;
}

/**
 * Resolve the content directory the indexer should walk for a given config
 * entry. Returns `undefined` if the entry has no walkable content
 * so the caller can skip it.
 *
 * Single source of truth: each provider owns its own path. We instantiate the
 * registered {@link import("../../sources/provider").SourceProvider} for the entry
 * and call `provider.path()`. This replaces the old per-kind switch ladder
 * (filesystem path / git cache / website cache) that lived here in 0.6.0 —
 * see spec §10 step 4 and §7 "Removed from 0.6.0".
 *
 * The git case still does one extra step: the provider returns the cloned
 * repo dir, but the indexer walks the `content/` subdirectory inside it.
 * That convention is part of the akm content layout, not a provider concern,
 * so it stays here.
 */
export function resolveEntryContentDir(entry: SourceConfigEntry): string | undefined {
  // §10.2 (WI-8.5) desired/resolved split: a git/npm bundle's desired config
  // carries only the source LOCATOR, not the materialized cache root — the
  // resolved root lives in the lock (`localRoot`). Resolve from there first via
  // the SHARED lock-first resolver (the same one write-source consults, so reads
  // and writes agree on where content is); the localRoot is the already-walkable
  // content root (installed sources are extracted to their content dir), so no
  // content/-subdir step is applied. Fall back to the provider path logic when no
  // lock entry exists (for example while a configured source is being
  // materialized for the first time).
  const localRoot = lockContentRootFor(entry.name, entry.type);
  if (localRoot != null) return localRoot;

  const factory = resolveSourceProviderFactory(entry.type);
  if (!factory) return undefined;

  let provider: import("../../sources/provider").SourceProvider;
  try {
    provider = factory(entry);
  } catch (err) {
    warn(
      `Warning: failed to construct ${entry.type} source provider for "${entry.name ?? entry.url ?? entry.path}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }

  let dir: string;
  try {
    dir = provider.path();
  } catch (err) {
    warn(
      `Warning: failed to resolve ${entry.type} source path for "${entry.name ?? entry.url ?? entry.path}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }

  // Git providers expose the cloned repo root as their path. The akm content
  // layout puts indexable files under `<repo>/content/`, so the walker needs
  // that subdirectory. This is a content-layout convention, not a provider
  // capability — keep it here.
  if (entry.type === "git") {
    return resolveGitContentRoot(dir);
  }
  return dir;
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
  const resolved = path.resolve(filePath);
  let best: SearchSource | undefined;
  let bestLen = -1;
  for (const source of sources) {
    const base = path.resolve(source.path);
    if (resolved.startsWith(base + path.sep) && base.length > bestLen) {
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
  return `This asset is read-only under current AKM source policy. To make an editable copy, run: akm clone ${ref}`;
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
 * `materialize` (default `true`) is the query-time safety valve (spec §14.3 /
 * D11): the sanctioned materialization callers (`akm index`, source
 * add/update/sync, improve's blocking preflight) pass it truthy and clone/pull/
 * fetch as needed. A READ command's inline auto-index passes `materialize:
 * false` — network is FORBIDDEN at query time, so instead of `sync()` we only
 * check whether each cache-backed source is already materialized: a present
 * cache is served as-is (last-known-good; no TTL pull either), while an absent
 * or partially-staged cache makes that source UNAVAILABLE for the read and is
 * skipped with one warning naming the remedy. The rest of the command still
 * resolves.
 */
export async function ensureSourceCaches(
  config?: AkmConfig,
  options?: {
    force?: boolean;
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
  const force = options?.force === true;
  const materialize = options?.materialize !== false;
  const onProgress = options?.onProgress ?? (() => {});
  // Polymorphic refresh: walk every enabled source through its registered
  // provider and call `sync()`. Every cache-backed kind (git, website, npm)
  // refreshes the same way — a bad source warns and is skipped without
  // aborting the others. The git content/-subdir layout convention stays in
  // resolveEntryContentDir. Provider projection comes only from `bundles`.
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
      await provider.sync?.({ force, secrets: options?.secrets, ensureWebsiteMirror });
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
    if (!fs.statSync(dir).isDirectory()) return false;
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * On a read-path auto-index, warn (once per source) that a cache-backed source
 * is not materialized locally and is being skipped — naming the remedy. Uses
 * the SAME lock-first content-root resolution the walker uses, so an installed
 * source whose content lives at its lock `localRoot` counts as materialized.
 */
function warnIfSourceUnavailableForRead(entry: SourceConfigEntry, providerName: string): void {
  let dir: string | undefined;
  try {
    dir = resolveEntryContentDir(entry);
  } catch {
    dir = undefined;
  }
  if (dir && isMaterializedDir(dir)) return;
  warn(
    `Warning: source "${providerName}" is not materialized locally; skipping it for this read. ` +
      "Run `akm index` (or `akm bundle update`) to fetch it.",
  );
}
