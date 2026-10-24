// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source operations: list, remove, update.
 *
 * Provides unified operations across all configured bundle source providers.
 * The CLI's `akm bundle list`, `akm bundle remove`, and `akm bundle update` commands are wired here.
 *
 * 0.9.0 (spec §10.1/§10.2): the retired `installed[]` array is gone — a
 * registry-managed source is now a `bundles.<slug>` entry (the desired locator)
 * paired with a lock entry (the resolved `localRoot`/version). A bundle that has
 * a lock entry is "managed" (installed from a registry and overwritten on
 * `akm bundle update`); a bundle with no lock is a plain filesystem/git/website source.
 */

import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { isWithin, resolveStashDir } from "../../core/common";
import type { AkmConfig, BundleConfigEntry } from "../../core/config/config";
import { bundleComponentConfig, getSources, loadConfig, resolveSecret } from "../../core/config/config";
import { AkmError, ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { isPathAbsent } from "../../core/path-access";
import { getDbPath, getRegistryCacheDir } from "../../core/paths";
import { warn } from "../../core/warn";
import { resolveGitContentRoot } from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { akmIndex } from "../../indexer/indexer";
import type { LockfileEntry } from "../../integrations/lockfile";
import { readLockfile, upsertLockEntry } from "../../integrations/lockfile";
import { parseRegistryRef } from "../../registry/resolve";
import type { InstalledBundle, InstallKind } from "../../registry/types";
import { getCachePaths, parseGitRepoUrl, runGit, syncMirroredRepo } from "../../sources/providers/git";
import { replaceDirectory } from "../../sources/providers/git-install";
import type { SourceLockData } from "../../sources/providers/install-types";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import { createWebsiteProvider } from "../../sources/providers/website";
import { storeSecretResolver } from "../../sources/snapshot-fetchers/secret-seam";
import { ensureWebsiteMirror } from "../../sources/snapshot-fetchers/website-ingest";
import type {
  RemoveResponse,
  SourceComponent,
  SourceDescriptor,
  SourceEntry,
  SourceKind,
  SourceListResponse,
  SourceLock,
  UpdatePlainSyncedItem,
  UpdateResponse,
  UpdateResultItem,
  UpdateSkippedItem,
} from "../../sources/types";
import type { Database } from "../../storage/database";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { auditStashForDangerousKeys } from "./dangerous-env-audit";
import { removeInstalledRegistryEntry } from "./source-add";
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
  componentRoot: string;
  requiredRoots: string[];
  credential?: string;
}

/** Enumerate the registry-managed installs (lock-backed bundles) in a config. */
function listManagedInstalls(config: AkmConfig): ManagedInstall[] {
  const bundles = config.bundles ?? {};
  const locks = new Map(readLockfile().map((entry) => [entry.id, entry]));
  const out: ManagedInstall[] = [];
  for (const [key, bundle] of Object.entries(bundles)) {
    const lock = locks.get(key);
    if (!lock) continue; // only lock-backed bundles are registry-managed
    const componentWritable = Object.values(bundle.components ?? {})[0]?.writable;
    const componentRoot = bundleComponentConfig(bundle)?.root ?? ".";
    out.push({
      bundleKey: key,
      installId: bundle.registryId ?? key,
      source: lock.source,
      ref: lock.ref,
      localRoot: lock.localRoot ?? "",
      resolvedVersion: lock.resolvedVersion,
      resolvedRevision: lock.resolvedRevision,
      writable: componentWritable ?? bundle.writable === true,
      componentRoot,
      requiredRoots: lock.localRoot ? [path.resolve(lock.localRoot, componentRoot)] : [],
      ...(bundle.credential !== undefined ? { credential: bundle.credential } : {}),
    });
  }
  return out;
}

/** Resolve an `akm bundle remove`/`akm bundle update` target to a managed install, if any. */
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

function describeBundleSource(entry: BundleConfigEntry): SourceDescriptor {
  if (entry.path) return { kind: "path", locator: entry.path };
  if (entry.git) return { kind: "git", locator: entry.git };
  if (entry.website) {
    return {
      kind: "website",
      locator: entry.website.url,
      ...(entry.website.maxPages !== undefined ? { maxPages: entry.website.maxPages } : {}),
    };
  }
  return { kind: "npm", locator: entry.npm ?? "" };
}

/**
 * Per-component `{ adapter, detected }` disclosure (#908/#909): `adapter` is
 * the EFFECTIVE adapter (explicit config, or auto-detected via the same
 * ordered probe `akm index` uses) and `detected` is `true` exactly when no
 * explicit `adapter` was configured. Before this, an auto-detected adapter
 * was invisible on `akm bundle list` — a mixed-layout bundle silently
 * shadowed by a narrower adapter (#908) gave no sign a choice had even been
 * made. `bundleRoot` is the bundle's resolved content root (lock `localRoot`
 * or its plain `path`), or `undefined` when neither is known yet (an
 * unresolved registry/website source) — detection is skipped in that case
 * rather than probing a path that may not exist.
 */
function describeComponents(entry: BundleConfigEntry, bundleRoot: string | undefined): SourceComponent[] {
  const configuredComponents = entry.components ?? {};
  const names = Object.keys(configuredComponents);
  if (names.length === 0) {
    // No explicit component at all — the implicit single component every
    // bundle gets (spec §1.2 rule 5; `deriveInstallations` applies the same
    // "main"-shaped default at index time).
    const adapter = bundleRoot !== undefined ? detectAdapterId(bundleRoot) : "akm";
    return [{ name: "main", adapter, detected: true }];
  }
  return names.map((name) => {
    const component = configuredComponents[name]!;
    const componentRoot = bundleRoot !== undefined ? path.resolve(bundleRoot, component.root ?? ".") : undefined;
    const adapter = component.adapter ?? (componentRoot !== undefined ? detectAdapterId(componentRoot) : "akm");
    return {
      name,
      ...(component.root !== undefined ? { root: component.root } : {}),
      adapter,
      detected: component.adapter === undefined,
      ...(component.writable !== undefined ? { writable: component.writable } : {}),
    };
  });
}

function describeLock(entry: LockfileEntry | undefined): SourceLock | null {
  if (!entry) return null;
  return {
    source: entry.source,
    ref: entry.ref,
    ...(entry.resolvedVersion !== undefined ? { resolvedVersion: entry.resolvedVersion } : {}),
    ...(entry.resolvedRevision !== undefined ? { resolvedRevision: entry.resolvedRevision } : {}),
    ...(entry.integrity !== undefined ? { integrity: entry.integrity } : {}),
    ...(entry.localRoot !== undefined ? { localRoot: entry.localRoot } : {}),
    ...(entry.manifestDigest !== undefined ? { manifestDigest: entry.manifestDigest } : {}),
    ...(entry.adapterIds !== undefined ? { adapterIds: entry.adapterIds } : {}),
    ...(entry.installedAt !== undefined ? { installedAt: entry.installedAt } : {}),
  };
}

interface BundleCounts {
  itemCount: number;
  byType: Record<string, number>;
}

function readBundleCounts(): Map<string, BundleCounts> {
  const counts = new Map<string, BundleCounts>();
  const dbPath = getDbPath();
  // An empty map renders as `itemCount: 0` for every bundle — indistinguishable
  // from "these bundles really are empty". Only a never-built index gets to say
  // that silently; an unreadable one falls through to the opener and is
  // reported by the `warn` in the catch below (#791).
  if (isPathAbsent(dbPath)) return counts;

  let db: Database | undefined;
  try {
    db = openReadonlyExistingDatabase(dbPath);
    if (!db) return counts;
    for (const row of getAllEntries(db)) {
      if (!row.bundleId) continue;
      const count = counts.get(row.bundleId) ?? { itemCount: 0, byType: {} };
      count.itemCount += 1;
      count.byType[row.entry.type] = (count.byType[row.entry.type] ?? 0) + 1;
      counts.set(row.bundleId, count);
    }
  } catch (error) {
    warn(`[akm bundle list] failed to read bundle counts from ${dbPath}: ${String(error)}`);
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        // The inventory read is already complete; a close failure is non-fatal.
      }
    }
  }
  return counts;
}

export async function akmListSources(input?: { stashDir?: string; kind?: SourceKind[] }): Promise<SourceListResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const config = loadConfig();
  const kindFilter = input?.kind;
  const locks = new Map(readLockfile().map((entry) => [entry.id, entry]));
  const counts = readBundleCounts();

  const sources: SourceEntry[] = [];

  for (const bundle of getSources(config)) {
    const key = bundle.name ?? bundle.path ?? bundle.url ?? "unknown";
    const configured = config.bundles?.[key];
    if (!configured) continue;
    const lock = locks.get(key);
    const kind = bundle.type as SourceKind;
    if (kindFilter && !kindFilter.includes(kind)) continue;
    const root = lock?.localRoot ?? bundle.path ?? "";
    const componentWritable = Object.values(configured.components ?? {})[0]?.writable;
    const bundleCounts = counts.get(key) ?? { itemCount: 0, byType: {} };
    sources.push({
      name: key,
      kind,
      default: key === config.defaultBundle,
      source: describeBundleSource(configured),
      ...(root ? { path: root } : {}),
      ...(lock ? { ref: lock.ref } : {}),
      provider: bundle.url != null ? bundle.type : undefined,
      ...(lock?.resolvedVersion !== undefined ? { version: lock.resolvedVersion } : {}),
      writable: componentWritable ?? bundle.writable ?? kind === "filesystem",
      ...(configured.registryId !== undefined ? { registryId: configured.registryId } : {}),
      components: describeComponents(configured, root || undefined),
      lock: describeLock(lock),
      itemCount: bundleCounts.itemCount,
      byType: bundleCounts.byType,
      status: { exists: root ? directoryExists(root) : true },
    });
  }

  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    defaultBundle: config.defaultBundle ?? null,
    sources,
    totalSources: sources.length,
  };
}

export async function akmRemove(input: { target: string; stashDir?: string }): Promise<RemoveResponse> {
  const target = input.target.trim();
  if (!target)
    throw new UsageError(
      "Target is required. Provide the source id, ref, path, URL, or name (e.g. `akm bundle remove npm:@scope/stash` or `akm bundle remove ~/my-stash`).",
    );

  const stashDir = input.stashDir ?? resolveStashDir();
  const config = loadConfig();

  // Registry-managed installs (lock-backed bundles) first.
  const managed = resolveManagedTarget(config, target);
  if (managed) {
    const updatedConfig = await removeInstalledRegistryEntry(managed.installId);
    if (managed.source !== "local" && managed.localRoot) {
      cleanupDirectoryBestEffort(managed.localRoot, "remove");
    }
    const index = await akmIndex({ stashDir });

    return {
      schemaVersion: 1,
      bundleDir: stashDir,
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
    bundleDir: stashDir,
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

type IndexResult = Awaited<ReturnType<typeof akmIndex>>;
type ConfiguredSource = ReturnType<typeof getSources>[number];

type UpdateIndexSummary = Pick<IndexResult, "mode" | "totalEntries" | "directoriesScanned" | "directoriesSkipped"> & {
  scanComplete?: boolean;
  verification?: IndexResult["verification"];
};

/**
 * Read the current index generation without creating or hydrating anything.
 * This path never ran an embedding pass (#954, field-report follow-up), so it has no
 * `verification` to report — {@link buildUpdateResponse} falls back to the
 * two facts it can actually know (whether semantic search is configured on
 * at all) rather than fabricating verification numbers (`entryCount: 0`,
 * `ok: true`) for a run that never verified anything.
 */
function readCurrentIndexSummary(): UpdateIndexSummary {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) {
    return { mode: "incremental", totalEntries: 0, directoriesScanned: 0, directoriesSkipped: 0 };
  }
  try {
    return {
      mode: "incremental",
      totalEntries: getAllEntries(db).length,
      directoriesScanned: 0,
      directoriesSkipped: 0,
    };
  } finally {
    closeDatabase(db);
  }
}

/** Build a standard UpdateResponse summary block from a committed or unchanged index generation. */
function buildUpdateResponse(
  stashDir: string,
  target: string | undefined,
  all: boolean,
  processed: UpdateResponse["processed"],
  opts: {
    plainSynced?: UpdatePlainSyncedItem[];
    skipped?: UpdateSkippedItem[];
    index: UpdateIndexSummary;
  },
): UpdateResponse {
  const index = opts.index;
  const finalConfig = loadConfig();
  return {
    schemaVersion: 1,
    bundleDir: stashDir,
    target,
    all,
    processed,
    ...(opts?.plainSynced?.length ? { plainSynced: opts.plainSynced } : {}),
    ...(opts?.skipped?.length ? { skipped: opts.skipped } : {}),
    config: {
      sourceCount: getSources(finalConfig).length,
    },
    index: {
      mode: index.mode,
      totalEntries: index.totalEntries,
      directoriesScanned: index.directoriesScanned,
      directoriesSkipped: index.directoriesSkipped,
      ...(index.scanComplete !== undefined ? { scanComplete: index.scanComplete } : {}),
      // A real embedding pass (`akmIndex`/`runEmbeddingPass`) reports its own
      // verified `semanticStatus`. When no pass ran this update (the
      // no-op/nothing-configured fallback) the only two facts known without
      // fabricating a verification are whether semantic search is off at all
      // or, if not, that its state is simply unverified this run.
      semanticStatus:
        index.verification?.semanticStatus ?? (finalConfig.semanticSearchMode === "off" ? "disabled" : "pending"),
    },
  };
}

function incompleteFilesystemOutcome(id: string): UpdateSkippedItem {
  return {
    id,
    kind: "filesystem",
    status: "skipped",
    code: "SOURCE_SCAN_INCOMPLETE",
    reason: `Filesystem source "${id}" was not scanned completely; preserving its last-known-good index rows.`,
  };
}

/**
 * A fetched update that is not live yet. Every remote update fetches into a
 * staging directory beside its cache, is audited there for dangerous env keys,
 * and only then is published: one rename for a read-only cache, a fast-forward
 * for a writable checkout. A blocked or failed update never touches the live
 * content, the lock, or the index.
 */
interface StagedUpdate {
  /** The component root inside the staged candidate that the audit scans. */
  auditRoot: string;
  publish(): void;
  cleanup(): void;
}

function createStagingParent(parent: string): string {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(parent, ".akm-update-stage-"));
}

/** A bundle's single component root and writability. */
function bundleComponent(config: AkmConfig, id: string): { root: string; writable: boolean } {
  const bundle = config.bundles?.[id];
  const component = bundleComponentConfig(bundle);
  return { root: component?.root ?? ".", writable: component?.writable ?? bundle?.writable === true };
}

async function auditStagedUpdate(auditRoot: string, ref: string, allowDangerousEnvKeys: boolean): Promise<void> {
  const decision = await auditStashForDangerousKeys({
    stashRoot: auditRoot,
    ref,
    allowDangerousKeys: allowDangerousEnvKeys,
    isTTY: process.stdin.isTTY === true,
    operation: "update",
    renderBlockedError: false,
  });
  if (decision.blocked) throw new NotFoundError(decision.error, decision.code);
}

function gitOrThrow(repoDir: string, args: string[]): string {
  const result = runGit(["-C", repoDir, ...args], { timeout: 120_000 });
  if (result.status !== 0) {
    throw new UsageError(
      `git ${args[0]} failed in ${repoDir}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Publish an audited writable checkout: fast-forward the live checkout to
 * exactly the staged commit. Git refuses a non-fast-forward or a merge that
 * would overwrite local work, and changes nothing in that case.
 */
function fastForwardCheckout(liveRepo: string, stagedRepo: string): void {
  const head = gitOrThrow(stagedRepo, ["rev-parse", "HEAD"]);
  gitOrThrow(liveRepo, ["fetch", "--no-tags", stagedRepo, head]);
  gitOrThrow(liveRepo, ["merge", "--ff-only", "--no-overwrite-ignore", head]);
}

/**
 * Reindex after an update. Sources are not re-fetched (the update just did
 * that) and detected adapters are not written to config.json — an update
 * leaves config alone; the next `akm index` records them.
 */
function reindexAfterUpdate(stashDir: string): Promise<IndexResult> {
  return akmIndex({ stashDir, full: true, hydrateSources: false, persistDetectedAdapters: false });
}

/** Publish, then reindex, holding the asset-mutation lease so no other writer interleaves. */
function publishAndIndex(stashDir: string, publish: () => Promise<void> | void): Promise<IndexResult> {
  return withAssetMutationLease("source-update", async () => {
    await publish();
    return reindexAfterUpdate(stashDir);
  });
}

/** Fetch a registry-managed install into staging without touching its live content. */
async function stageManagedUpdate(
  managed: ManagedInstall,
  force: boolean,
): Promise<{ synced: SourceLockData; staged: StagedUpdate }> {
  const credential = managed.credential
    ? resolveSecret(managed.credential, storeSecretResolver.resolveSecret)
    : undefined;

  if (managed.writable && managed.localRoot) {
    // A writable install is a checkout that may carry local commits: the
    // provider fast-forwards a copy, the copy is audited, and the live
    // checkout is then fast-forwarded to exactly the audited commit.
    const topLevel = runGit(["-C", managed.localRoot, "rev-parse", "--show-toplevel"]);
    if (topLevel.status !== 0 || !topLevel.stdout.trim()) {
      throw new UsageError(`Writable Git install at ${managed.localRoot} is not a checkout; refusing to update it.`);
    }
    const liveRepo = topLevel.stdout.trim();
    const stagingParent = createStagingParent(path.dirname(liveRepo));
    try {
      const stagedRepo = path.join(stagingParent, path.basename(liveRepo));
      fs.cpSync(liveRepo, stagedRepo, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      const stagedRoot = path.join(stagedRepo, path.relative(liveRepo, fs.realpathSync(managed.localRoot)));
      const fetched = await syncFromRef(managed.ref, {
        force,
        writable: true,
        writableRoot: stagedRoot,
        writableRequiredRoots: managed.requiredRoots.map((root) =>
          path.join(stagedRoot, path.relative(managed.localRoot, root)),
        ),
        ...(credential ? { credential } : {}),
      });
      return {
        synced: { ...fetched, contentDir: managed.localRoot, cacheDir: liveRepo, extractedDir: liveRepo },
        staged: {
          auditRoot: path.resolve(fetched.contentDir, managed.componentRoot),
          publish: () => fastForwardCheckout(liveRepo, stagedRepo),
          cleanup: () => cleanupDirectoryBestEffort(stagingParent, "bundle update"),
        },
      };
    } catch (error) {
      cleanupDirectoryBestEffort(stagingParent, "bundle update");
      throw error;
    }
  }

  if (managed.source === "local") {
    // The user's own directory: nothing to fetch or publish.
    const synced = await syncFromRef(managed.ref, { force, writable: managed.writable });
    return {
      synced,
      staged: { auditRoot: path.resolve(synced.contentDir, managed.componentRoot), publish() {}, cleanup() {} },
    };
  }

  const cacheRoot = getRegistryCacheDir();
  const stagingParent = createStagingParent(cacheRoot);
  try {
    const fetched = await syncFromRef(managed.ref, {
      force,
      writable: false,
      cacheRootDir: stagingParent,
      ...(credential ? { credential } : {}),
    });
    const liveCacheDir = path.join(cacheRoot, path.relative(stagingParent, fetched.cacheDir));
    const toLive = (candidate: string): string => path.join(liveCacheDir, path.relative(fetched.cacheDir, candidate));
    return {
      synced: {
        ...fetched,
        cacheDir: liveCacheDir,
        contentDir: toLive(fetched.contentDir),
        extractedDir: toLive(fetched.extractedDir),
      },
      staged: {
        auditRoot: path.resolve(fetched.contentDir, managed.componentRoot),
        publish: () => replaceDirectory(fetched.cacheDir, liveCacheDir),
        cleanup: () => cleanupDirectoryBestEffort(stagingParent, "bundle update"),
      },
    };
  } catch (error) {
    cleanupDirectoryBestEffort(stagingParent, "bundle update");
    throw error;
  }
}

/** Fetch a plain git source into staging, audit it, publish it, and reindex. */
async function syncGitPlainSource(
  config: AkmConfig,
  gitSource: ConfiguredSource,
  stashDir: string,
  allowDangerousEnvKeys: boolean,
): Promise<{ item: UpdatePlainSyncedItem; index: IndexResult }> {
  const id = gitSource.name ?? gitSource.url ?? "";
  const ref = gitSource.url ?? "";
  if (!gitSource.url) throw new ConfigError(`Git source "${id}" has no URL.`);
  const component = bundleComponent(config, id);
  const canonicalUrl = parseGitRepoUrl(gitSource.url).canonicalUrl;
  const livePaths = getCachePaths(canonicalUrl);
  const stagingParent = createStagingParent(path.dirname(livePaths.rootDir));
  try {
    const stagedPaths = getCachePaths(canonicalUrl, stagingParent);
    // A writable mirror may carry local commits: pull into a copy, then
    // fast-forward the live checkout once the copy passes the audit.
    const liveCheckout = component.writable && fs.existsSync(livePaths.repoDir);
    if (liveCheckout) fs.cpSync(livePaths.rootDir, stagedPaths.rootDir, { recursive: true, preserveTimestamps: true });
    await syncMirroredRepo(gitSource, {
      force: true,
      writable: component.writable,
      cacheRootDir: stagingParent,
      ...(gitSource.credential
        ? { credential: resolveSecret(gitSource.credential, storeSecretResolver.resolveSecret) }
        : {}),
    });
    await auditStagedUpdate(
      path.resolve(resolveGitContentRoot(stagedPaths.repoDir), component.root),
      ref,
      allowDangerousEnvKeys,
    );
    const index = await publishAndIndex(stashDir, () => {
      if (liveCheckout) fastForwardCheckout(livePaths.repoDir, stagedPaths.repoDir);
      else replaceDirectory(stagedPaths.rootDir, livePaths.rootDir);
    });
    return { item: { id, kind: "git", ref }, index };
  } finally {
    cleanupDirectoryBestEffort(stagingParent, "bundle update");
  }
}

/**
 * Re-crawl a website source and reindex. The website provider already builds
 * its snapshot in a staging directory and swaps it in, so a killed refresh
 * keeps the previous mirror; a snapshot holds only knowledge pages, so there
 * is no env file to audit.
 */
async function syncWebsitePlainSource(
  websiteSource: ConfiguredSource,
  stashDir: string,
): Promise<{ item: UpdatePlainSyncedItem; index: IndexResult }> {
  const id = websiteSource.name ?? websiteSource.url ?? "";
  await createWebsiteProvider(websiteSource).sync({
    force: true,
    secrets: storeSecretResolver,
    ensureWebsiteMirror,
  });
  const index = await reindexAfterUpdate(stashDir);
  return { item: { id, kind: "website", ref: websiteSource.url ?? "" }, index };
}

/** Sync a git-mirrored (plain) source and return an UpdateResponse (single-target path). */
async function updateGitSource(
  config: AkmConfig,
  stashDir: string,
  target: string,
  all: boolean,
  gitSource: ConfiguredSource,
  allowDangerousEnvKeys: boolean,
): Promise<UpdateResponse> {
  const synced = await syncGitPlainSource(config, gitSource, stashDir, allowDangerousEnvKeys);
  return buildUpdateResponse(stashDir, target, all, [], { plainSynced: [synced.item], index: synced.index });
}

/** Re-crawl a website (plain) source and return an UpdateResponse (single-target path). */
async function updateWebsiteSource(
  stashDir: string,
  target: string,
  all: boolean,
  websiteSource: ConfiguredSource,
): Promise<UpdateResponse> {
  const synced = await syncWebsitePlainSource(websiteSource, stashDir);
  return buildUpdateResponse(stashDir, target, all, [], { plainSynced: [synced.item], index: synced.index });
}

/** Reconcile a filesystem source's current bytes without provider hydration. */
async function updateFilesystemSource(
  stashDir: string,
  target: string,
  all: boolean,
  filesystemSource: ConfiguredSource,
): Promise<UpdateResponse> {
  const id = filesystemSource.name ?? filesystemSource.path ?? target;
  const ref = filesystemSource.path ?? target;
  const index = await akmIndex({ stashDir, hydrateSources: false });
  if (!index.scanComplete) {
    return buildUpdateResponse(stashDir, target, all, [], {
      skipped: [incompleteFilesystemOutcome(id)],
      index,
    });
  }
  return buildUpdateResponse(stashDir, target, all, [], {
    plainSynced: [{ id, kind: "filesystem", ref }],
    index,
  });
}

/**
 * A plain (lockless) npm bundle has no deterministic content path — unlike
 * git/website, resolving an npm package requires a registry round-trip to
 * pick a concrete version/tarball, which is exactly what the lock records.
 * So a plain npm source is synced via the same registry-install pipeline as
 * `akm bundle add <package>` and PROMOTED to a registry-managed (lock-backed)
 * install as a side effect of its first successful sync; it is reported via
 * `processed` like any other managed install from then on. Building a
 * {@link ManagedInstall} view onto the plain entry lets this reuse
 * {@link updateManagedInstall} verbatim rather than duplicating its lock/config
 * bookkeeping.
 */
function managedInstallViewOfPlainNpm(config: AkmConfig, npmSource: ConfiguredSource): ManagedInstall {
  const id = npmSource.name ?? npmSource.path ?? "";
  const spec = npmSource.path ?? "";
  return {
    bundleKey: id,
    installId: id,
    source: "npm",
    ref: spec.startsWith("npm:") ? spec : `npm:${spec}`,
    localRoot: "",
    writable: false,
    componentRoot: bundleComponent(config, id).root,
    requiredRoots: [],
  };
}

/**
 * Sync a single registry-managed install and return the processed record:
 * fetch into staging, audit, publish, write its lock entry, reindex.
 *
 * `yes` gates ONLY the destructive branch below (deleting a previous
 * `localRoot` whose content moved) — it has no effect on the sync itself. A
 * normal refresh that resolves the SAME content directory (the overwhelming
 * majority of updates) never reaches that branch, so it never prompts and
 * never requires `--yes` (F1/R-058: `update` must stay usable bare in
 * scripts; only the branch that can `rm -rf` needs a gate, not the whole
 * command).
 */
async function updateManagedInstall(
  managed: ManagedInstall,
  force: boolean,
  yes: boolean,
  stashDir: string,
  allowDangerousEnvKeys: boolean,
): Promise<{ item: UpdateResultItem; index: IndexResult }> {
  const { synced, staged } = await stageManagedUpdate(managed, force);
  try {
    await auditStagedUpdate(staged.auditRoot, managed.ref, allowDangerousEnvKeys);

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
    const movedRoot =
      managed.localRoot !== "" &&
      path.resolve(managed.localRoot) !== path.resolve(synced.contentDir) &&
      managed.source !== "local" &&
      !managed.writable;
    if (movedRoot) {
      const { confirmDestructive } = await import("../../cli/confirm.js");
      const confirmed = await confirmDestructive(
        `Update resolved a new content directory for "${managed.installId}" (${synced.contentDir}) and would delete the previous install directory at ${managed.localRoot}. This cannot be undone.`,
        { yes },
      );
      if (!confirmed)
        throw new UsageError(`Update cancelled for "${managed.installId}"; no configuration was changed.`);
    }

    const index = await publishAndIndex(stashDir, async () => {
      staged.publish();
      await upsertLockEntry({
        id: managed.bundleKey,
        // Preserve the STORED install kind: a `github:`-ref entry recorded as
        // source "git" must not be reclassified by the sync flow's re-derivation.
        source: managed.source,
        ref: synced.ref,
        resolvedVersion: synced.resolvedVersion,
        resolvedRevision: synced.resolvedRevision,
        integrity: synced.integrity ?? (synced.source === "local" ? "local" : undefined),
        localRoot: synced.contentDir,
        installedAt: synced.syncedAt,
      });
    });

    if (movedRoot) {
      if (referencesRoot(managed.localRoot, loadConfig(), readLockfile())) {
        warn(
          `[akm bundle update] kept previous install directory at ${managed.localRoot} because another configured or locked bundle still references it.`,
        );
      } else {
        cleanupDirectoryBestEffort(managed.localRoot, "update");
      }
    }

    const versionChanged = (managed.resolvedVersion ?? "") !== (synced.resolvedVersion ?? "");
    const revisionChanged = (managed.resolvedRevision ?? "") !== (synced.resolvedRevision ?? "");
    return {
      index,
      item: {
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
      },
    };
  } finally {
    staged.cleanup();
  }
}

function referencesRoot(target: string, config: AkmConfig, locks: LockfileEntry[]): boolean {
  const resolvedTarget = path.resolve(target);
  const locksById = new Map(locks.map((entry) => [entry.id, entry]));
  for (const [bundleId, bundle] of Object.entries(config.bundles ?? {})) {
    const root = bundle.path ?? locksById.get(bundleId)?.localRoot;
    if (!root) continue;
    if (isRootAtOrBelow(root, resolvedTarget)) return true;
    for (const component of Object.values(bundle.components ?? {})) {
      if (isRootAtOrBelow(path.resolve(root, component.root ?? "."), resolvedTarget)) return true;
    }
  }
  return locks.some((entry) => entry.localRoot && isRootAtOrBelow(entry.localRoot, resolvedTarget));
}

function isRootAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const lexicallyWithin =
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return lexicallyWithin || isWithin(candidate, root);
}

// ── akmUpdate dispatcher ─────────────────────────────────────────────────────

export async function akmUpdate(input?: {
  target?: string;
  all?: boolean;
  force?: boolean;
  stashDir?: string;
  /**
   * Skips the confirmation prompt for the destructive branch of
   * {@link updateManagedInstall} (deleting a previous `localRoot` whose
   * resolved content directory moved). Has no effect otherwise — most
   * updates never reach that branch (F1/R-058).
   */
  yes?: boolean;
  /** Explicitly permit staged dangerous environment keys after warning. */
  allowDangerousEnvKeys?: boolean;
}): Promise<UpdateResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const target = input?.target?.trim();
  const all = input?.all === true;
  const force = input?.force === true;
  const yes = input?.yes === true;
  const allowDangerousEnvKeys = input?.allowDangerousEnvKeys === true;
  const config = loadConfig();
  const managedInstalls = listManagedInstalls(config);

  if (target && !all) {
    // Registry-managed install (lock-backed) — re-download from its locator.
    const managed = resolveManagedTarget(config, target);
    if (managed) {
      const updated = await updateManagedInstall(managed, force, yes, stashDir, allowDangerousEnvKeys);
      return buildUpdateResponse(stashDir, target, all, [updated.item], { index: updated.index });
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
    if (gitMatch) return updateGitSource(config, stashDir, target, all, gitMatch, allowDangerousEnvKeys);

    const websiteMatch = stashes.find((s) => {
      if (s.type !== "website") return false;
      if (isUrl && s.url === target) return true;
      if (s.name === target) return true;
      if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
      return false;
    });
    if (websiteMatch) return updateWebsiteSource(stashDir, target, all, websiteMatch);

    // Plain npm source (bundle without a lock) — sync via the registry
    // pipeline and promote to a managed install (see
    // managedInstallViewOfPlainNpm's doc comment for why npm can't stay
    // plain the way git/website do).
    const npmMatch = stashes.find((s) => {
      if (s.type !== "npm") return false;
      if (s.name === target) return true;
      if (s.path === target) return true;
      return false;
    });
    if (npmMatch) {
      const updated = await updateManagedInstall(
        managedInstallViewOfPlainNpm(config, npmMatch),
        force,
        yes,
        stashDir,
        allowDangerousEnvKeys,
      );
      return buildUpdateResponse(stashDir, target, all, [updated.item], { index: updated.index });
    }

    const filesystemMatch = stashes.find((source) => {
      if (source.type !== "filesystem") return false;
      if (source.name === target) return true;
      return resolvedPath !== undefined && source.path !== undefined && path.resolve(source.path) === resolvedPath;
    });
    if (filesystemMatch) return updateFilesystemSource(stashDir, target, all, filesystemMatch);
  }

  const enabledManagedInstalls = all
    ? managedInstalls.filter((managed) => config.bundles?.[managed.bundleKey]?.enabled !== false)
    : managedInstalls;
  const selected = selectManagedTargets(config, enabledManagedInstalls, target, all);
  const processed: UpdateResponse["processed"] = [];
  const plainSynced: UpdatePlainSyncedItem[] = [];
  const skipped: UpdateSkippedItem[] = [];
  let latestIndex: IndexResult | undefined;
  for (const managed of selected) {
    try {
      const updated = await updateManagedInstall(managed, force, yes, stashDir, allowDangerousEnvKeys);
      processed.push(updated.item);
      latestIndex = updated.index;
    } catch (error) {
      if (!all) throw error;
      skipped.push(updateFailureOutcome(managed.installId, sourceKindForInstall(managed.source), error));
    }
  }

  // `--all` must account for EVERY configured source, not only the
  // registry-managed (lock-backed) ones (R-015) — `selectManagedTargets`
  // above returns only `installs` for `all`, so plain sources were
  // previously never even looked at. Git/website/npm plain sources are synced
  // here too (npm is promoted to managed, same as the single-target path
  // above). Filesystem sources reflect their files in place and are reported
  // as intentionally skipped.
  if (all) {
    const managedKeys = new Set(managedInstalls.map((m) => m.bundleKey));
    const plainSources = getSources(config).filter(
      (source) => source.enabled !== false && !managedKeys.has(source.name ?? ""),
    );
    const filesystemSources: typeof plainSources = [];
    for (const plain of plainSources) {
      const id = plain.name ?? plain.path ?? plain.url ?? "";
      try {
        if (plain.type === "git") {
          const updated = await syncGitPlainSource(config, plain, stashDir, allowDangerousEnvKeys);
          plainSynced.push(updated.item);
          latestIndex = updated.index;
        } else if (plain.type === "npm") {
          const updated = await updateManagedInstall(
            managedInstallViewOfPlainNpm(config, plain),
            force,
            yes,
            stashDir,
            allowDangerousEnvKeys,
          );
          processed.push(updated.item);
          latestIndex = updated.index;
        } else if (plain.type === "website") {
          const updated = await syncWebsitePlainSource(plain, stashDir);
          plainSynced.push(updated.item);
          latestIndex = updated.index;
        } else {
          filesystemSources.push(plain);
        }
      } catch (error) {
        skipped.push(updateFailureOutcome(id, plain.type as SourceKind, error));
      }
    }
    if (filesystemSources.length > 0) {
      try {
        // A remote source may have reconciled before a later source finished
        // hydrating, so an incomplete intermediate result is not authoritative
        // for the final `--all` outcome. Retry once after every source update;
        // a genuinely missing filesystem root remains incomplete and is
        // reported below without claiming reconciliation.
        if (!latestIndex?.scanComplete) latestIndex = await akmIndex({ stashDir, hydrateSources: false });
        if (latestIndex.scanComplete) {
          for (const source of filesystemSources) {
            plainSynced.push({
              id: source.name ?? source.path ?? "",
              kind: "filesystem",
              ref: source.path ?? source.name ?? "",
            });
          }
        } else {
          for (const source of filesystemSources) {
            skipped.push(incompleteFilesystemOutcome(source.name ?? source.path ?? ""));
          }
        }
      } catch (error) {
        for (const source of filesystemSources) {
          skipped.push(updateFailureOutcome(source.name ?? source.path ?? "", "filesystem", error));
        }
      }
    }
  }

  return buildUpdateResponse(stashDir, target, all, processed, {
    plainSynced,
    skipped,
    index: latestIndex ?? readCurrentIndexSummary(),
  });
}

function sourceKindForInstall(source: InstallKind): SourceKind {
  if (source === "local") return "filesystem";
  if (source === "github") return "git";
  return source;
}

function updateFailureOutcome(id: string, kind: SourceKind, error: unknown): UpdateSkippedItem {
  const code = error instanceof AkmError ? error.code : undefined;
  const status = code === "DANGEROUS_ENV_KEY" || code === "DANGEROUS_ENV_AUDIT_FAILED" ? "blocked" : "failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    kind,
    status,
    ...(code ? { code } : {}),
    reason: `${status}: ${message}`,
  };
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

  throw new NotFoundError(`No matching source for target: ${target}`, "SOURCE_NOT_FOUND");
}

/**
 * Best-effort removal of a directory that is no longer referenced by config
 * or the lockfile. `context` labels the call site (e.g. "remove", "update")
 * in the warning so an operator can tell which command left the directory
 * behind. Failure does not throw — callers already committed the config/lock
 * change that made `target` orphaned — but it must not be silent either
 * (F1/R-058): a swallowed `rmSync` error used to leave no trace anywhere the
 * caller could inspect, so a confirmed deletion that then failed (permission
 * error, file in use, …) looked identical to a successful one.
 */
function cleanupDirectoryBestEffort(target: string, context: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    warn(
      `[akm ${context}] failed to remove directory ${target}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Remove it manually if it is no longer needed.",
    );
  }
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
