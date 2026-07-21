// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source operations: list, remove, update.
 *
 * Provides unified operations across all source kinds (local, managed, remote).
 * The CLI's `akm list`, `akm remove`, and `akm update` commands are wired here.
 *
 * 0.9.0 (spec §10.1/§10.2): the retired `installed[]` array is gone — a
 * registry-managed source is now a `bundles.<slug>` entry (the desired locator)
 * paired with a lock entry (the resolved `localRoot`/version). A bundle that has
 * a lock entry is "managed" (installed from a registry and overwritten on
 * `akm update`); a bundle with no lock is a plain filesystem/git/website source.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { getSources, loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { akmIndex } from "../../indexer/indexer";
import { readLockfile, upsertLockEntry } from "../../integrations/lockfile";
import { parseRegistryRef } from "../../registry/resolve";
import type { InstalledBundle, InstallKind } from "../../registry/types";
import { parseGitRepoUrl, syncMirroredRepo } from "../../sources/providers/git";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import {
  ensureWebsiteMirror,
  shouldAllowPrivateWebsiteUrlForTests,
} from "../../sources/snapshot-fetchers/website-ingest";
import type {
  RemoveResponse,
  SourceEntry,
  SourceKind,
  SourceListResponse,
  UpdateResponse,
  UpdateResultItem,
} from "../../sources/types";
import { removeInstalledRegistryEntry, upsertInstalledRegistryEntry } from "./source-add";
import { removeStash } from "./source-manage";

/**
 * A registry-managed source: its `bundles` entry (desired locator) joined with
 * its lock entry (resolved cache state). `installId` is the original registry id
 * — the bundle's preserved `registryId`, else the slug-legal bundle key used
 * verbatim.
 */
interface ManagedInstall {
  bundleKey: string;
  installId: string;
  source: InstallKind;
  ref: string;
  localRoot: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  writable: boolean;
}

/** Enumerate the registry-managed installs (lock-backed bundles) in a config. */
function listManagedInstalls(config: AkmConfig): ManagedInstall[] {
  const bundles = config.bundles ?? {};
  const locks = new Map(readLockfile().map((entry) => [entry.id, entry]));
  const out: ManagedInstall[] = [];
  for (const [key, bundle] of Object.entries(bundles)) {
    const lock = locks.get(key);
    if (!lock) continue; // only lock-backed bundles are registry-managed
    out.push({
      bundleKey: key,
      installId: bundle.registryId ?? key,
      source: lock.source,
      ref: lock.ref,
      localRoot: lock.localRoot ?? "",
      resolvedVersion: lock.resolvedVersion,
      resolvedRevision: lock.resolvedRevision,
      writable: bundle.writable === true,
    });
  }
  return out;
}

/** Resolve an `akm remove`/`akm update` target to a managed install, if any. */
function resolveManagedTarget(config: AkmConfig, target: string): ManagedInstall | undefined {
  const installs = listManagedInstalls(config);
  const byId = installs.find((m) => m.installId === target || m.bundleKey === target);
  if (byId) return byId;
  const byRef = installs.find((m) => m.ref === target);
  if (byRef) return byRef;
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
  if (!isUrl) {
    const resolved = path.resolve(target);
    const byPath = installs.find((m) => m.localRoot && path.resolve(m.localRoot) === resolved);
    if (byPath) return byPath;
  }
  let parsedId: string | undefined;
  try {
    parsedId = parseRegistryRef(target).id;
  } catch {
    parsedId = undefined;
  }
  if (parsedId) return installs.find((m) => m.installId === parsedId);
  return undefined;
}

export async function akmListSources(input?: { stashDir?: string; kind?: SourceKind[] }): Promise<SourceListResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const config = loadConfig();
  const kindFilter = input?.kind;
  const locks = new Map(readLockfile().map((entry) => [entry.id, entry]));

  const sources: SourceEntry[] = [];

  // Every source is a bundle. A bundle with a lock entry is registry-managed;
  // otherwise it is a plain filesystem/git/website source.
  for (const bundle of getSources(config)) {
    const key = bundle.name ?? bundle.path ?? bundle.url ?? "unknown";
    const lock = bundle.name ? locks.get(bundle.name) : undefined;

    if (lock) {
      const kind: SourceKind = "managed";
      if (kindFilter && !kindFilter.includes(kind)) continue;
      const root = lock.localRoot ?? bundle.path ?? "";
      sources.push({
        name: key,
        kind,
        ...(root ? { path: root } : {}),
        ref: lock.ref,
        version: lock.resolvedVersion,
        writable: bundle.writable === true,
        status: { exists: root ? directoryExists(root) : false },
      });
      continue;
    }

    const kind: SourceKind = (bundle.type as SourceKind) ?? "filesystem";
    if (kindFilter && !kindFilter.includes(kind)) continue;
    const isFilesystem = kind === "filesystem";
    sources.push({
      name: key,
      kind,
      path: bundle.path,
      provider: bundle.url != null ? bundle.type : undefined,
      writable: bundle.writable !== undefined ? bundle.writable : isFilesystem,
      status: { exists: bundle.path ? directoryExists(bundle.path) : true },
    });
  }

  return {
    schemaVersion: 1,
    stashDir,
    sources,
    totalSources: sources.length,
  };
}

export async function akmRemove(input: { target: string; stashDir?: string }): Promise<RemoveResponse> {
  const target = input.target.trim();
  if (!target)
    throw new UsageError(
      "Target is required. Provide the source id, ref, path, URL, or name (e.g. `akm remove npm:@scope/stash` or `akm remove ~/my-stash`).",
    );

  const stashDir = input.stashDir ?? resolveStashDir();
  const config = loadConfig();

  // Registry-managed installs (lock-backed bundles) first.
  const managed = resolveManagedTarget(config, target);
  if (managed) {
    const updatedConfig = await removeInstalledRegistryEntry(managed.installId);
    if (managed.source !== "local" && managed.localRoot) {
      cleanupDirectoryBestEffort(managed.localRoot);
    }
    const index = await akmIndex({ stashDir });

    return {
      schemaVersion: 1,
      stashDir,
      target,
      removed: {
        id: managed.installId,
        source: managed.source,
        ref: managed.ref,
        cacheDir: managed.localRoot,
        stashRoot: managed.localRoot,
      },
      config: {
        sourceCount: getSources(updatedConfig).length,
        installedKitCount: readLockfile().length,
      },
      index: {
        mode: index.mode,
        totalEntries: index.totalEntries,
        directoriesScanned: index.directoriesScanned,
        directoriesSkipped: index.directoriesSkipped,
      },
    };
  }

  // Plain sources (filesystem/git/website bundles) via the bundle-map remover.
  const stashResult = removeStash(target);
  if (!stashResult.removed || !stashResult.entry) {
    throw new NotFoundError(`No matching source for target: ${target}`, "SOURCE_NOT_FOUND");
  }

  const removedEntry = stashResult.entry;
  const index = await akmIndex({ stashDir });
  const updatedConfig = loadConfig();

  return {
    schemaVersion: 1,
    stashDir,
    target,
    removed: {
      id: removedEntry.name ?? removedEntry.path ?? removedEntry.url ?? target,
      source: removedEntry.type,
      ref: removedEntry.path ?? removedEntry.url ?? target,
      cacheDir: "",
      stashRoot: removedEntry.path ?? "",
    },
    config: {
      sourceCount: getSources(updatedConfig).length,
      installedKitCount: readLockfile().length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  };
}

// ── akmUpdate helpers ────────────────────────────────────────────────────────

/** Build a standard UpdateResponse summary block from the current config and index run. */
async function buildUpdateResponse(
  stashDir: string,
  target: string | undefined,
  all: boolean,
  processed: UpdateResponse["processed"],
  full = false,
): Promise<UpdateResponse> {
  const index = await akmIndex({ stashDir, ...(full ? { full: true } : {}) });
  const finalConfig = loadConfig();
  return {
    schemaVersion: 1,
    stashDir,
    target,
    all,
    processed,
    config: {
      sourceCount: getSources(finalConfig).length,
      installedKitCount: readLockfile().length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
    },
  };
}

/** Sync a git-mirrored (plain) source and return an UpdateResponse. */
async function updateGitSource(
  stashDir: string,
  target: string,
  all: boolean,
  gitSource: ReturnType<typeof getSources>[number],
): Promise<UpdateResponse> {
  await syncMirroredRepo(gitSource, { force: true, writable: gitSource.writable === true });
  return buildUpdateResponse(stashDir, target, all, [], true);
}

/** Re-crawl a website (plain) source and return an UpdateResponse. */
async function updateWebsiteSource(
  stashDir: string,
  target: string,
  all: boolean,
  websiteSource: ReturnType<typeof getSources>[number],
): Promise<UpdateResponse> {
  // TODO: full incremental re-crawl with delta tracking (#19)
  await ensureWebsiteMirror(websiteSource, {
    requireStashDir: true,
    force: true,
    ...(shouldAllowPrivateWebsiteUrlForTests(websiteSource.url ?? "") ? { allowPrivateHosts: true } : {}),
  });
  return buildUpdateResponse(stashDir, target, all, []);
}

/** Sync a single registry-managed install and return the processed record. */
async function updateManagedInstall(managed: ManagedInstall, force: boolean): Promise<UpdateResultItem> {
  if (force && managed.source !== "local" && managed.localRoot) {
    cleanupDirectoryBestEffort(managed.localRoot);
  }
  const synced = await syncFromRef(managed.ref, { force });

  const installedEntry: InstalledBundle = {
    id: managed.installId,
    // Preserve the original source classification. syncFromRef() re-derives the
    // source type from the ref scheme (e.g. "github:" → source: "github"), but
    // an update should not reclassify an existing entry.
    source: managed.source,
    ref: synced.ref,
    artifactUrl: synced.artifactUrl,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    stashRoot: synced.contentDir,
    cacheDir: synced.cacheDir,
    installedAt: synced.syncedAt,
    writable: synced.writable ?? managed.writable,
  };
  const { bundleId } = upsertInstalledRegistryEntry(installedEntry);
  await upsertLockEntry({
    id: bundleId,
    // Preserve the STORED install kind: a `github:`-ref entry recorded as
    // source "git" must not be reclassified by the sync flow's re-derivation
    // (the issue this file's update pin exists for).
    source: managed.source,
    ref: synced.ref,
    resolvedVersion: synced.resolvedVersion,
    resolvedRevision: synced.resolvedRevision,
    integrity: synced.integrity ?? (synced.source === "local" ? "local" : undefined),
    // §10.2 resolved lock state the sync flow has on hand.
    localRoot: synced.contentDir,
    installedAt: synced.syncedAt,
  });
  if (
    managed.localRoot &&
    path.resolve(managed.localRoot) !== path.resolve(synced.contentDir) &&
    managed.source !== "local"
  ) {
    cleanupDirectoryBestEffort(managed.localRoot);
  }

  const versionChanged = (managed.resolvedVersion ?? "") !== (synced.resolvedVersion ?? "");
  const revisionChanged = (managed.resolvedRevision ?? "") !== (synced.resolvedRevision ?? "");

  return {
    id: managed.installId,
    source: managed.source,
    ref: managed.ref,
    previous: {
      resolvedVersion: managed.resolvedVersion,
      resolvedRevision: managed.resolvedRevision,
      cacheDir: managed.localRoot,
    },
    installed: { ...installedEntry, extractedDir: synced.extractedDir },
    changed: {
      version: versionChanged,
      revision: revisionChanged,
      any: versionChanged || revisionChanged,
    },
  };
}

// ── akmUpdate dispatcher ─────────────────────────────────────────────────────

export async function akmUpdate(input?: {
  target?: string;
  all?: boolean;
  force?: boolean;
  stashDir?: string;
}): Promise<UpdateResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const target = input?.target?.trim();
  const all = input?.all === true;
  const force = input?.force === true;
  const config = loadConfig();
  const managedInstalls = listManagedInstalls(config);

  if (target && !all) {
    // Registry-managed install (lock-backed) — re-download from its locator.
    const managed = resolveManagedTarget(config, target);
    if (managed) {
      return buildUpdateResponse(stashDir, target, all, [await updateManagedInstall(managed, force)]);
    }

    // Plain git / website source (bundles without a lock) — provider re-sync.
    const stashes = getSources(config);
    const isUrl = target.startsWith("http://") || target.startsWith("https://");
    const resolvedPath = !isUrl ? path.resolve(target) : undefined;
    const gitMatch = stashes.find((s) => {
      if (s.type !== "git") return false;
      if (isUrl && s.url === target) return true;
      if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
      if (s.name === target) return true;
      if (s.url) {
        try {
          const repo = parseGitRepoUrl(s.url);
          if (repo.canonicalUrl === target) return true;
        } catch {
          // Ignore malformed config here; later provider sync will surface it.
        }
      }
      return false;
    });
    if (gitMatch) return updateGitSource(stashDir, target, all, gitMatch);

    const websiteMatch = stashes.find((s) => {
      if (s.type !== "website") return false;
      if (isUrl && s.url === target) return true;
      if (s.name === target) return true;
      if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
      return false;
    });
    if (websiteMatch) return updateWebsiteSource(stashDir, target, all, websiteMatch);
  }

  const selected = selectManagedTargets(config, managedInstalls, target, all);
  const processed: UpdateResponse["processed"] = [];
  for (const managed of selected) {
    processed.push(await updateManagedInstall(managed, force));
  }

  return buildUpdateResponse(stashDir, target, all, processed);
}

function selectManagedTargets(
  config: AkmConfig,
  installs: ManagedInstall[],
  target: string | undefined,
  all: boolean,
): ManagedInstall[] {
  if (all && target) {
    throw new UsageError("Specify either <target> or --all, not both.", "MISSING_OR_AMBIGUOUS_TARGET");
  }
  if (all) return installs;
  if (!target) {
    throw new UsageError("Either <target> or --all is required.", "MISSING_OR_AMBIGUOUS_TARGET");
  }

  const found = resolveManagedTarget(config, target);
  if (found) return [found];

  // Give a helpful message when the target names a plain (non-managed) source.
  const stashes = getSources(config);
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
  const resolvedPath = !isUrl ? path.resolve(target) : undefined;
  const stashMatch = stashes.find((s) => {
    if (isUrl && s.url === target) return true;
    if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
    if (s.name === target) return true;
    return false;
  });

  if (stashMatch) {
    if (stashMatch.type === "website") {
      throw new UsageError(
        `"${target}" is a website source — website caching not yet implemented for --all. ` +
          `Run \`akm update ${target}\` to re-mirror this source individually.`,
        "TARGET_NOT_UPDATABLE",
      );
    }
    throw new UsageError(
      `"${target}" is a local directory — it reflects your files in place. To refresh the search index, run: akm index`,
      "TARGET_NOT_UPDATABLE",
    );
  }

  throw new NotFoundError(`No matching source for target: ${target}`, "SOURCE_NOT_FOUND");
}

function cleanupDirectoryBestEffort(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
