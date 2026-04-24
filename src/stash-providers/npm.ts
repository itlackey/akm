/**
 * Npm-source stash provider.
 *
 * `sync()` resolves the npm package tarball, downloads it, verifies its
 * integrity, extracts it securely (via `extractTarGzSecure`), detects the
 * stash root inside the package, and applies any nested `.akm-include`
 * configuration. Cache hits short-circuit the fetch.
 *
 * Audit is intentionally NOT performed here — `akmAdd` calls
 * `auditInstallCandidate` after `sync()` so the policy decision lives at
 * the orchestrator layer where the `--trust` flag is known.
 */

import fs from "node:fs";
import path from "node:path";
import type { StashConfigEntry } from "../config";
import { ConfigError, UsageError } from "../errors";
import { getRegistryCacheDir } from "../paths";
import { parseRegistryRef, resolveRegistryArtifact } from "../registry-resolve";
import type { ParsedNpmRef } from "../registry-types";
import type {
  StashLockData,
  StashSearchOptions,
  StashSearchResult,
  SyncableStashProvider,
  SyncOptions,
} from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import type { KnowledgeView, ShowResponse } from "../stash-types";
import {
  applyAkmIncludeConfig,
  buildInstallCacheDir,
  computeFileHash,
  detectStashRoot,
  downloadArchive,
  isDirectory,
} from "./provider-utils";
import { extractTarGzSecure, verifyArchiveIntegrity } from "./tar-utils";

class NpmStashProvider implements SyncableStashProvider {
  readonly type = "npm";
  readonly kind = "syncable" as const;
  readonly name: string;

  constructor(config: StashConfigEntry) {
    this.name = config.name ?? config.url ?? "npm";
  }

  /** Content is indexed through the standard FTS5 pipeline. */
  async search(_options: StashSearchOptions): Promise<StashSearchResult> {
    return { hits: [] };
  }

  /** Content is local files, shown via showLocal. */
  async show(_ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    throw new Error("NPM provider content is shown via local index");
  }

  canShow(_ref: string): boolean {
    return false;
  }

  async sync(config: StashConfigEntry, options?: SyncOptions): Promise<StashLockData> {
    const ref = npmRefFromConfig(config);
    return syncNpmRef(ref, options);
  }

  getContentDir(config: StashConfigEntry): string {
    if (config.path) return config.path;
    throw new ConfigError("npm stash entry missing resolved content path");
  }

  async remove(config: StashConfigEntry): Promise<void> {
    if (config.path && isDirectory(config.path)) {
      // Remove the whole versioned cache dir if we know the parent layout.
      const parent = path.dirname(config.path);
      try {
        fs.rmSync(parent, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

registerStashProvider("npm", (config) => new NpmStashProvider(config));

function npmRefFromConfig(config: StashConfigEntry): string {
  // Prefer an explicit ref-bearing field (set by akmAdd when persisting), else fall back
  // to options or url so the provider stays usable from a hand-rolled config.
  const candidate = config.options?.ref ?? config.url ?? config.options?.package ?? config.name;
  if (typeof candidate !== "string" || !candidate) {
    throw new UsageError('npm stash entry must include an `options.ref` (e.g. "npm:my-pkg@1.2.3")');
  }
  return candidate.startsWith("npm:") ? candidate : `npm:${candidate}`;
}

/**
 * Fetch and extract an npm tarball, returning a populated `StashLockData`.
 *
 * Mirrors the historical `installRegistryRef()` path for npm sources:
 *   - resolve artifact URL + integrity from the npm registry
 *   - reuse cached extraction when present
 *   - download, verify, extract securely, then detect the stash root
 *   - honour `.akm-include` filters
 */
export async function syncNpmRef(ref: string, options?: SyncOptions): Promise<StashLockData> {
  const parsed = parseRegistryRef(ref);
  if (parsed.source !== "npm") {
    throw new UsageError(`syncNpmRef requires an npm: ref, got "${ref}"`);
  }
  return doSyncNpm(parsed, options);
}

async function doSyncNpm(parsed: ParsedNpmRef, options?: SyncOptions): Promise<StashLockData> {
  const resolved = await resolveRegistryArtifact(parsed);
  const syncedAt = (options?.now ?? new Date()).toISOString();
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheDir();
  const cacheDir = buildInstallCacheDir(
    cacheRootDir,
    resolved.source,
    resolved.id,
    resolved.resolvedVersion ?? resolved.resolvedRevision,
  );
  const archivePath = path.join(cacheDir, "artifact.tar.gz");
  const extractedDir = path.join(cacheDir, "extracted");

  // Cache hit: extracted dir already valid → reuse it
  if (!options?.force && isDirectory(extractedDir)) {
    try {
      const cachedStashRoot = detectStashRoot(extractedDir);
      if (cachedStashRoot) {
        const integrity = fs.existsSync(archivePath) ? await computeFileHash(archivePath) : undefined;
        return {
          id: resolved.id,
          source: resolved.source,
          ref: resolved.ref,
          artifactUrl: resolved.artifactUrl,
          resolvedVersion: resolved.resolvedVersion,
          resolvedRevision: resolved.resolvedRevision,
          contentDir: cachedStashRoot,
          cacheDir,
          extractedDir,
          integrity,
          writable: options?.writable,
          syncedAt,
        };
      }
    } catch {
      // Cache invalid, re-download
    }
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  let integrity: string;
  let provisionalKitRoot: string;
  let installRoot: string;
  let stashRoot: string;
  try {
    await downloadArchive(resolved.artifactUrl, archivePath);
    verifyArchiveIntegrity(archivePath, resolved.resolvedRevision, resolved.source);
    integrity = await computeFileHash(archivePath);
    extractTarGzSecure(archivePath, extractedDir);

    provisionalKitRoot = detectStashRoot(extractedDir);
    installRoot = applyAkmIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot;
    stashRoot = detectStashRoot(installRoot);
  } catch (err) {
    // Clean up so stale or partial extractions don't cause false cache hits.
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  return {
    id: resolved.id,
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    resolvedVersion: resolved.resolvedVersion,
    resolvedRevision: resolved.resolvedRevision,
    contentDir: stashRoot,
    cacheDir,
    extractedDir,
    integrity,
    writable: options?.writable,
    syncedAt,
  };
}

export { NpmStashProvider };
