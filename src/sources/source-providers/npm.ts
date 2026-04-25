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
import type { SourceConfigEntry } from "../../core/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryCacheDir } from "../../core/paths";
import { parseRegistryRef, resolveRegistryArtifact } from "../../registry/resolve";
import type { ParsedNpmRef } from "../../registry/types";
import type { ProviderContext, SourceProvider } from "../source-provider";
import { registerSourceProvider } from "../source-provider-factory";
import type { SourceLockData, SyncOptions } from "./install-types";
import {
  applyAkmIncludeConfig,
  buildInstallCacheDir,
  computeFileHash,
  detectStashRoot,
  downloadArchive,
  isDirectory,
} from "./provider-utils";
import { extractTarGzSecure, verifyArchiveIntegrity } from "./tar-utils";

/**
 * NPM source provider — fetches a tarball from the npm registry and extracts
 * it into a local cache. Implements the v1 {@link SourceProvider} interface
 * (spec §2.1): `{ name, kind, init, path, sync }`.
 *
 * The install-time pipeline (`syncNpmRef`) lives below as a standalone
 * function used by `akm add` / `akm update` — that path produces a
 * {@link SourceLockData} record for lockfile bookkeeping. The provider's own
 * `sync()` is a void refresh (delegates to the install pipeline but discards
 * the lock data, which is owned by `lockfile.ts`).
 */
class NpmSourceProvider implements SourceProvider {
  readonly kind = "npm" as const;
  readonly name: string;
  readonly #config: SourceConfigEntry;

  constructor(config: SourceConfigEntry) {
    this.#config = config;
    this.name = config.name ?? config.url ?? "npm";
  }

  async init(_ctx: ProviderContext): Promise<void> {
    // Resolution happens lazily in path(): until `sync()` runs there's no
    // reliable on-disk path. Init is the registration handshake.
  }

  path(): string {
    if (this.#config.path) return this.#config.path;
    throw new ConfigError(
      `npm source "${this.name}" has no resolved content path — run \`akm update\` to sync it before indexing.`,
    );
  }

  async sync(): Promise<void> {
    const ref = npmRefFromConfig(this.#config);
    await syncNpmRef(ref);
  }
}

registerSourceProvider("npm", (config) => new NpmSourceProvider(config));

function npmRefFromConfig(config: SourceConfigEntry): string {
  // Prefer an explicit ref-bearing field (set by akmAdd when persisting), else fall back
  // to options or url so the provider stays usable from a hand-rolled config.
  const candidate = config.options?.ref ?? config.url ?? config.options?.package ?? config.name;
  if (typeof candidate !== "string" || !candidate) {
    throw new UsageError('npm stash entry must include an `options.ref` (e.g. "npm:my-pkg@1.2.3")');
  }
  return candidate.startsWith("npm:") ? candidate : `npm:${candidate}`;
}

/**
 * Fetch and extract an npm tarball, returning a populated `SourceLockData`.
 *
 * Mirrors the historical `installRegistryRef()` path for npm sources:
 *   - resolve artifact URL + integrity from the npm registry
 *   - reuse cached extraction when present
 *   - download, verify, extract securely, then detect the stash root
 *   - honour `.akm-include` filters
 */
export async function syncNpmRef(ref: string, options?: SyncOptions): Promise<SourceLockData> {
  const parsed = parseRegistryRef(ref);
  if (parsed.source !== "npm") {
    throw new UsageError(`syncNpmRef requires an npm: ref, got "${ref}"`);
  }
  return doSyncNpm(parsed, options);
}

async function doSyncNpm(parsed: ParsedNpmRef, options?: SyncOptions): Promise<SourceLockData> {
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

export { NpmSourceProvider };
