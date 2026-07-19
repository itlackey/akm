// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isSourceWriteActivated } from "../../core/activation-policy";
import { displayRef } from "../../core/asset/resolve-ref";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig, SourceConfigEntry } from "../../core/config/config";
import { getSources, loadConfig } from "../../core/config/config";
import { resolveGitContentRoot } from "../../core/write-source";
import { resolveSourceProviderFactory } from "../../sources/provider-factory";
// Eager side-effect imports so all built-in source providers self-register
// before resolveEntryContentDir() runs.
import "../../sources/providers/index";
import { warn } from "../../core/warn";

// Legacy "context-hub" / "github" type aliases are normalized to "git" at
// config-load time (see src/config.ts), so this set only contains the canonical
// type.
const GIT_STASH_TYPES = new Set(["git"]);

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchSource {
  path: string;
  /** For installed sources, the installed stash id */
  registryId?: string;
  /**
   * Whether this source accepts writes. The primary stash is always writable.
   * Filesystem/git sources with `writable: true` in config are also writable.
   * Registry-cached sources (installed without writable: true) are read-only.
   * The write-activation decision itself lives in the workspace activation
   * policy — see `isSourceWriteActivated` in `core/activation-policy.ts`.
   */
  writable?: boolean;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources, walking every configured stash
 * once. Iteration order:
 *
 *   1. The primary stash directory (the entry marked `primary: true`, or the
 *      legacy top-level `stashDir`). Always emitted, even when the directory
 *      does not yet exist on disk, so callers can use it as the clone target.
 *   2. Each entry in `config.sources[]` (in declared order), excluding the
 *      one already emitted as the primary.
 *   3. Each entry in `config.installed[]` (registry-managed stashes).
 *
 * Replaces the previous four-pass loop that walked `stashes[]` separately
 * for each provider kind. Disabled entries (`enabled: false`) and entries
 * whose disk path doesn't exist are filtered after deduplication.
 */
export function resolveSourceEntries(overrideStashDir?: string, existingConfig?: AkmConfig): SearchSource[] {
  const stashDir = overrideStashDir ?? resolveStashDir();
  const config = existingConfig ?? loadConfig();

  // Primary stash is always writable.
  const sources: SearchSource[] = [{ path: stashDir, writable: true }];
  const seen = new Set<string>([path.resolve(stashDir)]);

  const addSource = (dir: string, registryId?: string, writable?: boolean) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) {
      // Already in the source list — typically the primary stash injected at
      // sources[0] before this loop. Enrich that entry with whatever metadata
      // the matching config source carries so `--source <config-name>` can
      // find it via registryId. Without this, the primary stash entry stays
      // identity-less and a user-named primary source ("name": "my-stash")
      // would validate but match zero entries when filtering.
      const existing = sources.find((s) => s.path === resolved);
      if (existing) {
        if (registryId && !existing.registryId) existing.registryId = registryId;
        if (writable && !existing.writable) existing.writable = true;
      }
      return;
    }
    seen.add(resolved);
    if (isSuspiciousStashRoot(dir)) {
      warn(`Warning: stash root "${dir}" appears to be a system directory. This may be unintentional.`);
    }
    if (isValidDirectory(dir)) {
      sources.push({
        path: resolved,
        ...(registryId ? { registryId } : {}),
        ...(writable ? { writable: true } : {}),
      });
    }
  };

  // (1) + (2) Single pass over declared stashes — primary first if present,
  // then the rest in declared order. The primary's directory is already
  // injected as `sources[0]` above, so we only need to dedupe the source set.
  const stashes = getSources(config);
  const primaryIdx = stashes.findIndex((entry) => entry.primary === true);
  const ordered: SourceConfigEntry[] = [];
  if (primaryIdx >= 0) {
    ordered.push(stashes[primaryIdx]);
    stashes.forEach((entry, i) => {
      if (i !== primaryIdx) ordered.push(entry);
    });
  } else {
    ordered.push(...stashes);
  }

  for (const entry of ordered) {
    if (entry.enabled === false) continue;
    const dir = resolveEntryContentDir(entry);
    if (dir == null) continue;
    addSource(dir, entry.name, entry.writable === true);
  }

  // (3) Installed stashes (registry-managed). Always last.
  // Only installed entries explicitly marked writable: true are considered writable.
  for (const entry of config.installed ?? []) {
    addSource(entry.stashRoot, entry.id, entry.writable === true);
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
function resolveEntryContentDir(entry: SourceConfigEntry): string | undefined {
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
  if (GIT_STASH_TYPES.has(entry.type)) {
    return resolveGitContentRoot(dir);
  }
  return dir;
}

/**
 * Convenience: returns just the directory paths, preserving priority order.
 */
export function resolveAllStashDirs(overrideStashDir?: string): string[] {
  return resolveSourceEntries(overrideStashDir).map((s) => s.path);
}

/**
 * Return the resolved absolute paths of all writable stash sources.
 *
 * The primary stash is always writable. Filesystem/git sources that have
 * `writable: true` in config are also included. Registry-cached sources
 * (installed without `writable: true`) are excluded because they are
 * overwritten on `akm update` and must never be mutated.
 */
export function getWritableStashDirs(overrideStashDir?: string, existingConfig?: AkmConfig): string[] {
  return resolveSourceEntries(overrideStashDir, existingConfig)
    .filter((s) => isSourceWriteActivated(s))
    .map((s) => s.path);
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

/**
 * Return the primary stash source (first entry in the list).
 * This is the user's working stash and the default destination for clone.
 */
export function getPrimarySource(sources: SearchSource[]): SearchSource | undefined {
  return sources[0];
}

// ── Editability ─────────────────────────────────────────────────────────────

/**
 * Determine whether a file is safe to edit in place.
 *
 * The only files that are NOT editable are those inside a cache directory
 * managed by the package manager (`installed[].cacheDir`). These
 * will be overwritten by `akm update` without warning.
 *
 * Everything else — working stash, additional stashes, local project dirs — is
 * the user's domain to manage.
 */
export function isEditable(filePath: string, config?: AkmConfig): boolean {
  const cfg = config ?? loadConfig();
  const resolved = path.resolve(filePath);
  const cacheManaged = cfg.installed ?? [];
  const isWin = process.platform === "win32";

  for (const entry of cacheManaged) {
    // Local sources reference original paths — always editable
    if (entry.source === "local") continue;
    const cacheRoot = path.resolve(entry.cacheDir);
    if (isWin) {
      // Windows paths are case-insensitive — normalize both sides
      if (resolved.toLowerCase().startsWith(cacheRoot.toLowerCase() + path.sep)) return false;
    } else {
      if (resolved.startsWith(cacheRoot + path.sep)) return false;
    }
  }

  return true;
}

/**
 * Build an actionable hint for the agent when a file is not editable.
 * Callers must check `isEditable()` before calling — this function
 * unconditionally returns the hint string.
 */
export function buildEditHint(_filePath: string, assetType: string, assetName: string, origin?: string): string {
  // F4b output-spelling flip: emit the 0.9.0 conceptId grammar for the clone hint.
  const ref = displayRef({ type: assetType, name: assetName, bundleId: origin });
  return `This asset is managed by akm and may be overwritten on update. To edit, run: akm clone ${ref}`;
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ── Stash cache integration ─────────────────────────────────────────────────

/**
 * Ensure all cache-backed stash providers are refreshed so their cache
 * directories exist on disk. Must be called (async) before
 * `resolveSourceEntries()` so the content directories pass the
 * `isValidDirectory()` check.
 */
export async function ensureSourceCaches(config?: AkmConfig, options?: { force?: boolean }): Promise<void> {
  const cfg = config ?? loadConfig();
  const force = options?.force === true;
  // Polymorphic refresh: walk every enabled source through its registered
  // provider and call `sync()`. Every cache-backed kind (git, website, npm)
  // refreshes the same way — a bad source warns and is skipped without
  // aborting the others. The git content/-subdir layout convention stays in
  // resolveEntryContentDir.
  for (const entry of getSources(cfg)) {
    if (entry.enabled === false) continue;
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
    try {
      await provider.sync({ force });
    } catch (err) {
      warn(
        `Warning: failed to refresh ${provider.kind} source "${provider.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
