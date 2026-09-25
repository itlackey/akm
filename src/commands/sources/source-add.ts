// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { isBundleSlug } from "../../core/asset/asset-ref";
import { slugForRegistryId, validateExplicitBundleName } from "../../core/bundle-id";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import type { AkmConfig, BundleConfigEntry, SourceConfigEntry } from "../../core/config/config";
import {
  bundleEntryToSourceEntry,
  getSources,
  installedSourceDescriptor,
  loadConfig,
  mutateConfig,
  resolveSecret,
} from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { akmIndex } from "../../indexer/indexer";
import { deriveBundleId } from "../../indexer/installations";
import { readLockfile, removeLockEntry, upsertLockEntry } from "../../integrations/lockfile";
import { parseRegistryRef } from "../../registry/resolve";
import type { InstalledBundle } from "../../registry/types";
import { detectStashRoot } from "../../sources/providers/provider-utils";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import { storeSecretResolver } from "../../sources/snapshot-fetchers/secret-seam";
import {
  ensureWebsiteMirror,
  shouldAllowPrivateWebsiteUrlForTests,
  validateWebsiteInputUrl,
} from "../../sources/snapshot-fetchers/website-ingest";
import type { AddResponse } from "../../sources/types";
import { revokeSchedulerActivationsForBundle } from "../../tasks/activation-config";
import {
  type BundleInsertPosition,
  bundleKeyForPath,
  bundleKeyForUrl,
  nextBundleKey,
  placeBundle,
} from "./bundle-config-ops";

export async function akmAdd(
  input: {
    ref: string;
    name?: string;
    options?: Record<string, unknown>;
    writable?: boolean;
    /** Symbolic Git credential reference; resolved only for Git subprocesses. */
    credential?: string;
    /** Override the auto-detected component adapter (#909). Local (filesystem) adds only. */
    adapter?: string;
  } & BundleInsertPosition,
): Promise<AddResponse> {
  const ref = input.ref.trim();
  if (!ref)
    throw new UsageError(
      "Install ref or local directory is required. " +
        "Examples: `akm bundle add @scope/stash`, `akm bundle add github:owner/repo`, `akm bundle add ./local/path`",
    );

  const stashDir = resolveStashDir();

  if (shouldAddAsWebsiteUrl(ref)) {
    return addWebsiteSource(ref, stashDir, input.name, input.options, input);
  }

  // Local directories become filesystem bundles; registry refs use the
  // registry-backed bundle installer below.
  try {
    const parsed = parseRegistryRef(ref);
    if (parsed.source === "local") {
      return addLocalSource(ref, parsed.sourcePath, stashDir, input.name, input.adapter, input);
    }
  } catch {
    // Not a local ref — fall through to registry install
  }

  return addRegistryStash(ref, stashDir, input.name, input.writable, input, input.credential);
}

/** Add a local directory as a filesystem bundle. */
async function addLocalSource(
  ref: string,
  sourcePath: string,
  stashDir: string,
  explicitName?: string,
  explicitAdapter?: string,
  position: BundleInsertPosition = {},
): Promise<AddResponse> {
  const stashRoot = detectStashRoot(sourcePath);
  const resolvedPath = path.resolve(stashRoot);
  const adapter = explicitAdapter ?? detectAdapterId(resolvedPath);
  let bundleKey = explicitName ?? toReadableId(resolvedPath);
  mutateConfig((config) => {
    const existing = bundleKeyForPath(config, resolvedPath);
    if (existing) {
      if (explicitName !== undefined && explicitName !== existing) {
        throw new UsageError(
          `This path is already configured as bundle "${existing}". Re-adding it under a different name is ` +
            `not supported — run \`akm bundle rename ${existing} ${explicitName}\` instead.`,
          "INVALID_FLAG_VALUE",
        );
      }
      bundleKey = existing;
      const current = config.bundles?.[existing];
      if (current?.components && explicitAdapter === undefined) return config;
      const bundles = { ...(config.bundles ?? {}) };
      bundles[existing] = {
        ...current,
        path: resolvedPath,
        components: { main: { root: ".", adapter } },
      };
      return { ...config, bundles };
    }
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    // D6: an explicit `--name` is a contract on this (local) add path — validated
    // strictly before nextBundleKey derives a key, since that shared helper is also
    // used by the out-of-scope `akm source add` (`addStash`) and stays forgiving.
    if (explicitName !== undefined) validateExplicitBundleName(bundles, explicitName);
    bundleKey = nextBundleKey(bundles, explicitName, resolvedPath);
    const entry: BundleConfigEntry = {
      path: resolvedPath,
      components: { main: { root: ".", adapter } },
    };
    return { ...config, bundles: placeBundle(bundles, bundleKey, entry, position) };
  });

  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    ref,
    bundleId: bundleKey,
    sourceAdded: {
      type: "filesystem",
      path: resolvedPath,
      name: bundleKey,
      stashRoot: resolvedPath,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

async function addWebsiteSource(
  ref: string,
  stashDir: string,
  name?: string,
  options?: Record<string, unknown>,
  position: BundleInsertPosition = {},
): Promise<AddResponse> {
  const allowPrivateHosts = shouldAllowPrivateWebsiteUrlForTests(ref);
  const normalizedUrl = validateWebsiteInputUrl(ref, { allowPrivateHosts });
  const numberOption = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  const maxPages = numberOption(options?.maxPages);
  const maxDepth = numberOption(options?.maxDepth);
  let entry: SourceConfigEntry | undefined;
  let bundleId = "";
  mutateConfig((config) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(config.bundles ?? {}) };
    const existingKey = bundleKeyForUrl(config, normalizedUrl);
    if (existingKey && name !== undefined && name !== existingKey) {
      throw new UsageError(
        `This URL is already configured as bundle "${existingKey}". Re-adding it under a different name is ` +
          `not supported — run \`akm bundle rename ${existingKey} ${name}\` instead.`,
        "INVALID_FLAG_VALUE",
      );
    }
    // An explicit `--name` is a contract (D6) — validated strictly and used
    // as-is, never silently substituted. A DERIVED default (no --name) keeps
    // the forgiving `deriveBundleId` fallback, so a dotted hostname or a
    // URL collision still mints a usable id instead of erroring.
    let key: string;
    if (existingKey) {
      key = existingKey;
    } else if (name !== undefined) {
      validateExplicitBundleName(bundles, name);
      key = name;
    } else {
      key = deriveBundleId(toWebsiteName(normalizedUrl), normalizedUrl, new Set(Object.keys(bundles)));
    }
    bundleId = key;
    // Merge onto the existing descriptor rather than replacing it: re-running
    // `bundle add` for a URL that already has a bundle would otherwise drop
    // respectRobots / refresh, silently restoring default robots enforcement
    // and changing what the next update fetches. Explicitly-passed maxPages /
    // maxDepth still win over the stored values.
    const existingWebsite = existingKey ? ((bundles[key]?.website ?? {}) as Record<string, unknown>) : {};
    const website = {
      ...existingWebsite,
      url: normalizedUrl,
      ...(maxPages !== undefined ? { maxPages } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    };
    const nextBundle: BundleConfigEntry = {
      ...(existingKey ? bundles[key] : {}),
      website,
      components: { main: { root: ".", adapter: "website-snapshot", writable: false } },
    };
    if (JSON.stringify(bundles[key]) === JSON.stringify(nextBundle)) {
      entry = bundleEntryToSourceEntry(key, bundles[key]!) as SourceConfigEntry;
      return config;
    }
    const nextBundles = placeBundle(bundles, key, nextBundle, position);
    entry = bundleEntryToSourceEntry(key, nextBundle) as SourceConfigEntry;
    return { ...config, bundles: nextBundles };
  });

  const cachePaths = await ensureWebsiteMirror(entry as SourceConfigEntry, {
    requireStashDir: true,
    resolveSecret: storeSecretResolver.resolveSecret,
    ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  });
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    ref,
    bundleId,
    sourceAdded: {
      type: "website",
      url: normalizedUrl,
      name: entry?.name,
      stashRoot: cachePaths.stashDir,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

/**
 * Install a stash from a registry (npm, github, git) by dispatching to the
 * matching syncable provider and persisting the lock entry.
 */
async function addRegistryStash(
  ref: string,
  stashDir: string,
  explicitName?: string,
  writable?: boolean,
  position: BundleInsertPosition = {},
  credentialRef?: string,
): Promise<AddResponse> {
  const parsedRef = parseRegistryRef(ref);
  if (writable === true && parsedRef.source !== "git" && parsedRef.source !== "github") {
    throw new ConfigError("writable: true is only supported on filesystem and git sources", "INVALID_CONFIG_FILE");
  }
  if (credentialRef && parsedRef.source !== "git" && parsedRef.source !== "github") {
    throw new ConfigError("credential is only supported on git sources", "INVALID_CONFIG_FILE");
  }

  const currentConfig = loadConfig();
  const existingBundleKey = findInstalledBundleKey(currentConfig.bundles ?? {}, parsedRef.id);
  // D6: validate an explicit `--name` before any network sync or write — an
  // illegal name, a name already taken by a different bundle, or re-adding
  // this same install under a different name than it already carries must
  // fail loudly here, not mint a `-<hash>` fallback deep inside the config
  // mutation below.
  if (explicitName !== undefined) {
    validateExplicitBundleName(currentConfig.bundles ?? {}, explicitName, existingBundleKey);
  }
  const existingBundle = existingBundleKey ? currentConfig.bundles?.[existingBundleKey] : undefined;
  const priorLock = existingBundleKey ? readLockfile().find((entry) => entry.id === existingBundleKey) : undefined;
  const existingWritable =
    Object.values(existingBundle?.components ?? {})[0]?.writable ?? existingBundle?.writable === true;
  const effectiveWritable = writable === true || existingWritable;
  const requiredRoots = priorLock?.localRoot
    ? Object.values(existingBundle?.components ?? {}).map((component) =>
        path.resolve(priorLock.localRoot as string, component.root ?? "."),
      )
    : [];
  const synced = await syncFromRef(ref, {
    writable: effectiveWritable,
    ...(effectiveWritable && priorLock?.localRoot ? { writableRoot: priorLock.localRoot } : {}),
    ...(requiredRoots.length > 0 ? { writableRequiredRoots: requiredRoots } : {}),
    ...(credentialRef
      ? { credential: resolveSecret(credentialRef, storeSecretResolver.resolveSecret) }
      : existingBundle?.credential
        ? { credential: resolveSecret(existingBundle.credential, storeSecretResolver.resolveSecret) }
        : {}),
  });

  const { config: updatedConfig, bundleId } = upsertInstalledRegistryEntry(
    {
      id: synced.id,
      source: synced.source,
      ref: synced.ref,
      artifactUrl: synced.artifactUrl,
      resolvedVersion: synced.resolvedVersion,
      resolvedRevision: synced.resolvedRevision,
      stashRoot: synced.contentDir,
      cacheDir: synced.cacheDir,
      installedAt: synced.syncedAt,
      writable: synced.writable,
    },
    position,
    credentialRef,
    explicitName,
  );

  // The prior materialized root (if this is a re-install) — read BEFORE the lock
  // upsert overwrites it, so a moved cache root can be cleaned afterwards.
  const priorLocalRoot = priorLock?.localRoot;

  await upsertLockEntry({
    id: bundleId,
    source: synced.source,
    ref: synced.ref,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    integrity: synced.integrity,
    // §10.2 resolved lock state the install flow has on hand.
    localRoot: synced.contentDir,
    installedAt: synced.syncedAt,
  });

  // Clean up the old materialized root on re-install (moved cache).
  if (!effectiveWritable && priorLocalRoot && path.resolve(priorLocalRoot) !== path.resolve(synced.contentDir)) {
    try {
      fs.rmSync(priorLocalRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  const index = await akmIndex({ stashDir });

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    ref,
    bundleId,
    ...(synced.id !== bundleId ? { registryId: synced.id } : {}),
    installed: {
      id: synced.id,
      source: synced.source,
      ref: synced.ref,
      artifactUrl: synced.artifactUrl,
      resolvedVersion: synced.resolvedVersion,
      resolvedRevision: synced.resolvedRevision,
      stashRoot: synced.contentDir,
      cacheDir: synced.cacheDir,
      extractedDir: synced.extractedDir,
      installedAt: synced.syncedAt,
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.warnings?.length ? { warnings: index.warnings } : {}),
    },
  };
}

/**
 * Persist or replace a registry-installed source as a 0.9.0 `bundles` entry
 * (spec §10.1 / §10.2 desired/resolved split). The bundle carries ONLY the
 * desired descriptor (git/npm locator + preserved `registryId` + `writable`);
 * the resolved cache root belongs exclusively in the lock (written by callers
 * via {@link upsertLockEntry} with the returned `bundleId`). A new install is
 * keyed by `explicitName` (the CLI's `--name`) when given. Returns the config
 * plus the derived bundle id so the caller keys its lock entry identically.
 */
export function upsertInstalledRegistryEntry(
  entry: InstalledBundle,
  position: BundleInsertPosition = {},
  credential?: string,
  explicitName?: string,
): { config: AkmConfig; bundleId: string } {
  let bundleId = entry.id;
  const config = mutateConfig((current) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(current.bundles ?? {}) };
    bundleId = resolveInstalledBundleKey(bundles, entry.id, entry.stashRoot, explicitName);
    const existingComponents = bundles[bundleId]?.components;
    const components = existingComponents
      ? Object.fromEntries(
          Object.entries(existingComponents).map(([id, component]) => [
            id,
            { ...component, writable: entry.writable === true },
          ]),
        )
      : {
          main: {
            root: ".",
            adapter: detectAdapterId(path.resolve(entry.stashRoot)),
            writable: entry.writable === true,
          },
        };
    const descriptor = installedSourceDescriptor(entry.source, entry.ref, path.resolve(entry.stashRoot));
    const effectiveCredential = credential ?? bundles[bundleId]?.credential;
    const nextEntry: BundleConfigEntry = {
      ...descriptor,
      ...(effectiveCredential ? { credential: effectiveCredential } : {}),
      ...(entry.writable === true ? { writable: true } : {}),
      ...(entry.id !== bundleId ? { registryId: entry.id } : {}),
      components: components satisfies NonNullable<BundleConfigEntry["components"]>,
    };
    return { ...current, bundles: placeBundle(bundles, bundleId, nextEntry, position) };
  }).config;
  return { config, bundleId };
}

/**
 * Remove a registry-installed source: delete its `bundles` entry and its lock
 * entry (spec §10.2). Matches the bundle by preserved `registryId` or by a
 * slug-legal install id used verbatim as the key. Idempotent.
 */
export async function removeInstalledRegistryEntry(id: string): Promise<AkmConfig> {
  let removedKey: string | undefined;
  const config = mutateConfig((current) => {
    const bundles: Record<string, BundleConfigEntry> = { ...(current.bundles ?? {}) };
    const key = findInstalledBundleKey(bundles, id);
    if (!key) return current;
    removedKey = key;
    delete bundles[key];
    return revokeSchedulerActivationsForBundle(
      {
        ...current,
        bundles: Object.keys(bundles).length > 0 ? bundles : undefined,
        ...(current.defaultBundle === key ? { defaultBundle: undefined } : {}),
        ...(current.defaultWriteTarget === key ? { defaultWriteTarget: undefined } : {}),
      },
      key,
    );
  }).config;
  if (removedKey) await removeLockEntry(removedKey);
  return config;
}

/**
 * The bundle key that maps to a registry install id, or `undefined` when no
 * bundle currently represents it. A non-slug-legal install id (e.g.
 * `github:owner/repo`) is preserved verbatim on the bundle's `registryId`; a
 * slug-legal id is used directly as the key.
 */
function findInstalledBundleKey(bundles: Record<string, BundleConfigEntry>, installId: string): string | undefined {
  for (const [key, bundle] of Object.entries(bundles)) {
    if (bundle.registryId === installId) return key;
  }
  if (isBundleSlug(installId) && installId in bundles) return installId;
  return undefined;
}

/**
 * The stable bundle key for a registry install: reuse the existing bundle for
 * this install id (so re-installs keep the same key — a caller-visible name
 * mismatch was already rejected upstream, by {@link validateExplicitBundleName}
 * in `addRegistryStash`, before any write). Otherwise an explicit `--name`
 * (D6) is a contract — validated strictly and used as-is, never silently
 * substituted. Without one, a batch-unique key is derived via the shared
 * {@link deriveBundleId} (D-R5) from the package/repo name the install id
 * names rather than the basename of the materialized cache directory
 * (`extracted`) — unique against the currently-configured bundle keys.
 */
function resolveInstalledBundleKey(
  bundles: Record<string, BundleConfigEntry>,
  installId: string,
  stashRoot: string,
  explicitName?: string,
): string {
  const existing = findInstalledBundleKey(bundles, installId);
  if (existing) return existing;
  if (explicitName !== undefined) {
    validateExplicitBundleName(bundles, explicitName);
    return explicitName;
  }
  return deriveBundleId(slugForRegistryId(installId), path.resolve(stashRoot), new Set(Object.keys(bundles)));
}

function toReadableId(resolvedPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && resolvedPath.startsWith(home + path.sep)) {
    return `~${resolvedPath.slice(home.length)}`;
  }
  return resolvedPath;
}

// Keep this list limited to widely-used git hosts for the non-breaking
// "repo-like URL" fast-path; everything else continues to default to website snapshots.
const KNOWN_GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht"]);

export function shouldAddAsWebsiteUrl(ref: string): boolean {
  return isHttpUrl(ref) && !isLikelyGitRepositoryUrl(ref);
}

function isLikelyGitRepositoryUrl(ref: string): boolean {
  try {
    const parsed = new URL(ref);
    return KNOWN_GIT_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.pathname.endsWith(".git");
  } catch {
    return false;
  }
}

function toWebsiteName(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}
