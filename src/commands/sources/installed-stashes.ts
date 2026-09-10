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

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { isWithin, resolveStashDir } from "../../core/common";
import type { AkmConfig, BundleConfigEntry } from "../../core/config/config";
import { acquireConfigReadFence, bundleComponentConfig, getSources, loadConfig } from "../../core/config/config";
import { AkmError, ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { isPathAbsent } from "../../core/path-access";
import { getDbPath, getRegistryCacheDir } from "../../core/paths";
import { beginImmediateTransaction, getStateDbPath, openStateDatabase } from "../../core/state-db";
import { warn } from "../../core/warn";
import { resolveGitContentRoot } from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { akmIndex, runEmbeddingPass } from "../../indexer/indexer";
import type { LockfileEntry } from "../../integrations/lockfile";
import {
  compareAndSwapLockfileSnapshot,
  publishLockfileUpdate,
  readLockfile,
  readLockfileForUpdate,
} from "../../integrations/lockfile";
import { parseRegistryRef } from "../../registry/resolve";
import type { InstalledBundle, InstallKind } from "../../registry/types";
import { sha256Hex } from "../../runtime";
import { getCachePaths, parseGitRepoUrl, runGit, syncMirroredRepo } from "../../sources/providers/git";
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
import { getWebsiteCachePaths } from "../../sources/website-url";
import type { Database } from "../../storage/database";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { auditStashForDangerousKeys, type DangerousKeyFinding, scanStashForDangerousKeys } from "./dangerous-env-audit";
import { removeInstalledRegistryEntry } from "./source-add";
import { removeStash } from "./source-manage";
import {
  cleanupStagingParent,
  createStagingParent,
  type DirectoryPublication,
  prepareDirectoryPublication,
  prepareWritableGitPublication,
} from "./update-transaction";

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
  auditConfigGeneration: string;
}

interface BundleAuditFence {
  componentRoot: string;
  generation: string;
  writable: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      // Codepoint order, NOT localeCompare: this string feeds sha256Hex for the
      // bundle-audit generation, and localeCompare is ICU/locale-dependent — the
      // same object could hash differently on two machines. Matches the other
      // canonicalJson implementations (workflows/ir/plan-hash.ts).
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bundleAuditGeneration(entry: BundleConfigEntry | undefined): string {
  return sha256Hex(canonicalJson(entry ?? null));
}

function bundleAuditFence(config: AkmConfig, id: string): BundleAuditFence {
  const bundle = config.bundles?.[id];
  if (!bundle) throw new ConfigError(`Source "${id}" disappeared before update staging.`);
  return {
    componentRoot: bundleComponentConfig(bundle)?.root ?? ".",
    generation: bundleAuditGeneration(bundle),
    writable: bundleComponentConfig(bundle)?.writable ?? bundle.writable === true,
  };
}

function assertBundleAuditFence(config: AkmConfig, id: string, expectedGeneration: string): void {
  const current = config.bundles?.[id];
  if (bundleAuditGeneration(current) !== expectedGeneration) {
    throw new ConfigError(
      `Source "${id}" config changed after its staged bytes were audited; refusing to publish without re-staging and re-auditing.`,
    );
  }
}

function currentPlainSource(
  config: AkmConfig,
  id: string,
  type: "git" | "website" | "npm",
): ReturnType<typeof getSources>[number] {
  const source = getSources(config).find((candidate) => candidate.name === id && candidate.type === type);
  if (!source) {
    throw new ConfigError(`Source "${id}" changed or disappeared before update staging; retry to re-resolve it.`);
  }
  return source;
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
      auditConfigGeneration: bundleAuditGeneration(bundle),
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
    // bundle gets (spec §1.2 rule 5; `deriveInstallations`/`componentForSource`
    // apply the same "main"-shaped default at index time).
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

type UpdateIndexSummary = Pick<
  Awaited<ReturnType<typeof akmIndex>>,
  "mode" | "totalEntries" | "directoriesScanned" | "directoriesSkipped"
> & { scanComplete?: boolean; verification?: Awaited<ReturnType<typeof akmIndex>>["verification"] };

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

export type UpdateTransactionPoint =
  | "staged"
  | "audited"
  | "fenced"
  | "published"
  | "before-index"
  | "indexed"
  | "before-commit";

export interface UpdateTransactionHookContext {
  db?: Database;
}

let updateTransactionHookForTests:
  | ((point: UpdateTransactionPoint, id: string, context?: UpdateTransactionHookContext) => void)
  | undefined;

/** TEST-ONLY. Inject faults at source-update transaction boundaries. */
export function _setUpdateTransactionHookForTests(
  hook?: (point: UpdateTransactionPoint, id: string, context?: UpdateTransactionHookContext) => void,
): void {
  updateTransactionHookForTests = hook;
}

function updateTransactionHook(
  point: UpdateTransactionPoint,
  id: string,
  context?: UpdateTransactionHookContext,
): void {
  updateTransactionHookForTests?.(point, id, context);
}

interface PreparedUpdate {
  auditRoot: string;
  publishedAuditRoot?: string;
  publishedAuditContainmentRoot?: string;
  publishedAuditExpectedPhysicalRoot?: string;
  auditedContentGeneration?: string;
  approvedDangerousFindings?: string;
  publication?: DirectoryPublication;
  cleanup(): void;
}

interface PreparedManagedUpdate extends PreparedUpdate {
  synced: SourceLockData;
}

function gitHead(repoDir: string): string | undefined {
  const result = runGit(["-C", repoDir, "rev-parse", "HEAD"]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function invalidWritableGitPublication(repoDir: string): DirectoryPublication {
  return {
    publish() {
      throw new ConfigError(
        `Writable Git source at ${repoDir} is not a valid checkout; refusing to replace its live directory.`,
      );
    },
    rollback() {},
    commit() {},
  };
}

function writableGitPublication(opts: {
  stagedRepo: string;
  liveRepo: string;
  expectedOldHead?: string;
  auditedTargetHead?: string;
}): DirectoryPublication {
  const auditedTargetHead = opts.auditedTargetHead ?? gitHead(opts.stagedRepo);
  if (!opts.expectedOldHead || !auditedTargetHead) return invalidWritableGitPublication(opts.liveRepo);
  return prepareWritableGitPublication({
    stagedRepo: opts.stagedRepo,
    liveRepo: opts.liveRepo,
    expectedOldHead: opts.expectedOldHead,
    auditedTargetHead,
  });
}

const UPDATE_STATE_SCHEMA = "akm_update_state";

interface UnifiedUpdateTransaction {
  db: Database;
  stateActivity: Database;
  deferred: {
    db: Database;
    stateSchema: string;
  };
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function openUnifiedUpdateTransaction(): UnifiedUpdateTransaction {
  // Keep canonical state activity registered for the entire attached
  // transaction so maintenance/migration cannot replace state.db underneath
  // the borrowed index connection.
  const stateActivity = openStateDatabase();
  try {
    const statePath = getStateDbPath();
    const db = openIndexDatabase(undefined, {
      beforeSchema: (candidate) => {
        candidate.exec(`ATTACH DATABASE ${sqliteStringLiteral(statePath)} AS "${UPDATE_STATE_SCHEMA}"`);
        // openIndexDatabase invokes this before ensureSchema, so the outer
        // transaction begins before the first update-owned index mutation.
        beginImmediateTransaction(candidate);
      },
    });
    return {
      db,
      stateActivity,
      deferred: { db, stateSchema: UPDATE_STATE_SCHEMA },
    };
  } catch (error) {
    stateActivity.close();
    throw error;
  }
}

function rollbackUnifiedUpdateTransaction(transaction: UnifiedUpdateTransaction): unknown {
  if (!transaction.db.inTransaction) return undefined;
  try {
    transaction.db.exec("ROLLBACK");
    return undefined;
  } catch (error) {
    return error;
  }
}

function commitUnifiedUpdateTransaction(transaction: UnifiedUpdateTransaction): void {
  if (!transaction.db.inTransaction) {
    throw new Error("Source update index returned without its active unified index/state transaction.");
  }
  transaction.db.exec("COMMIT");
}

function closeUnifiedUpdateTransaction(transaction: UnifiedUpdateTransaction, committed: boolean): void {
  let closeError = rollbackUnifiedUpdateTransaction(transaction);
  try {
    transaction.db.close();
  } catch (error) {
    closeError ??= error;
  }
  try {
    transaction.stateActivity.close();
  } catch (error) {
    closeError ??= error;
  }
  if (closeError) {
    warn(
      committed
        ? `[akm bundle update] committed, but closing its database handles failed: ${String(closeError)}`
        : `[akm bundle update] rolled back, but closing its database handles failed: ${String(closeError)}`,
    );
  }
}

/**
 * Run the embedding phase AFTER the coordinator's atomic commit, on its own
 * fresh connection (#954). Before this, `akmUpdate` called
 * `akmIndex()` for its embedding phase too, INSIDE this same unified
 * `BEGIN IMMEDIATE` — so every per-batch commit the materializer opened
 * nested as an unobservable SAVEPOINT, and a SIGKILL mid-run lost every
 * embedding of the run rather than just the one in flight. The
 * ambient-transaction drift guard (#954) now rejects that outright, so
 * `akmIndex`'s own embedding phase is skipped for a deferred update
 * transaction and this runs instead, once content/lock/index/state are
 * already durably committed.
 *
 * A failing pass (provider down, timeout) does NOT fail the update: the
 * bundle content and index are already committed successfully, exactly like
 * a plain `akm index` whose embedding phase fails — only the reported
 * `verification` reflects the shortfall (`semanticStatus: "blocked"`).
 */
async function runPostCommitEmbeddingPass(
  index: Awaited<ReturnType<typeof akmIndex>>,
): Promise<Awaited<ReturnType<typeof akmIndex>>> {
  const config = loadConfig();
  let db: Database | undefined;
  try {
    const embeddingDim = config.embedding?.dimension;
    db = openIndexDatabase(getDbPath(), embeddingDim ? { embeddingDim } : undefined);
    const { verification } = await runEmbeddingPass({ db, config, onProgress: () => {} });
    return { ...index, verification };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`[akm bundle update] post-commit embedding pass failed: ${message}`);
    return {
      ...index,
      verification: { ...index.verification, ok: false, semanticStatus: "blocked", message },
    };
  } finally {
    if (db) closeDatabase(db);
  }
}

function pathAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function remapStagedPath(candidate: string, stagedRoot: string, liveRoot: string): string {
  if (!pathAtOrBelow(candidate, stagedRoot)) return candidate;
  return path.join(liveRoot, path.relative(stagedRoot, candidate));
}

function dangerousFindingGeneration(findings: readonly DangerousKeyFinding[]): string {
  return JSON.stringify(
    findings
      .map(({ envRef, keyName, relPath }) => ({ envRef, keyName, relPath }))
      .sort((left, right) =>
        `${left.relPath}\0${left.envRef}\0${left.keyName}`.localeCompare(
          `${right.relPath}\0${right.envRef}\0${right.keyName}`,
        ),
      ),
  );
}

async function contentGeneration(root: string): Promise<string> {
  const hash = createHash("sha256");
  const resolvedRoot = path.resolve(root);
  const walk = async (directory: string): Promise<void> => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(resolvedRoot, absolute).replaceAll(path.sep, "/");
      const before = fs.lstatSync(absolute);
      if (before.isDirectory()) {
        hash.update(`D\0${relative}\0${before.mode & 0o777}\0`);
        await walk(absolute);
      } else if (before.isSymbolicLink()) {
        hash.update(`L\0${relative}\0${fs.readlinkSync(absolute)}\0`);
      } else if (before.isFile()) {
        hash.update(`F\0${relative}\0${before.mode & 0o777}\0${before.size}\0`);
        for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk as Buffer);
        const after = fs.lstatSync(absolute);
        if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new ConfigError(`Source content changed while ${relative} was being audited; retry the update.`);
        }
        hash.update("\0");
      } else {
        throw new ConfigError(`Unsupported filesystem entry ${absolute}; refusing to audit an unstable source tree.`);
      }
    }
  };
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new ConfigError(`Expected ${resolvedRoot} to be a directory.`);
  await walk(resolvedRoot);
  return hash.digest("hex");
}

async function verifyPublishedAudit(prepared: PreparedUpdate, id: string): Promise<void> {
  const liveRoot = prepared.publishedAuditRoot;
  if (!liveRoot) return;
  const resolveLiveAuditRoot = (): string => {
    const physicalRoot = canonicalWritablePath(liveRoot, `published component root for "${id}"`);
    const containmentRoot = prepared.publishedAuditContainmentRoot;
    if (containmentRoot && !pathAtOrBelow(physicalRoot, containmentRoot)) {
      throw new ConfigError(
        `Published component root ${liveRoot} resolves outside its physical checkout at ${containmentRoot}.`,
        "DANGEROUS_ENV_AUDIT_FAILED",
      );
    }
    const expected = prepared.publishedAuditExpectedPhysicalRoot;
    if (expected && path.resolve(physicalRoot) !== path.resolve(expected)) {
      throw new ConfigError(
        `Published component root ${liveRoot} resolves to ${physicalRoot}, not its audited staged target ${expected}.`,
        "DANGEROUS_ENV_AUDIT_FAILED",
      );
    }
    return physicalRoot;
  };
  const beforeRoot = resolveLiveAuditRoot();
  const beforeAudit = await contentGeneration(beforeRoot);
  let findings: DangerousKeyFinding[];
  try {
    const scanRoot = resolveLiveAuditRoot();
    if (scanRoot !== beforeRoot) throw new Error("configured component symlink changed during re-audit");
    findings = scanStashForDangerousKeys(scanRoot);
  } catch (error) {
    throw new ConfigError(
      `Dangerous environment-key re-audit failed after materializing "${id}"; rolling the update back. ${error instanceof Error ? error.message : String(error)}`,
      "DANGEROUS_ENV_AUDIT_FAILED",
    );
  }
  const afterRoot = resolveLiveAuditRoot();
  const afterAudit = await contentGeneration(afterRoot);
  if (
    afterRoot !== beforeRoot ||
    beforeAudit !== prepared.auditedContentGeneration ||
    afterAudit !== prepared.auditedContentGeneration ||
    dangerousFindingGeneration(findings) !== prepared.approvedDangerousFindings
  ) {
    throw new ConfigError(
      `Writable source "${id}" changed while its audited Git target was materialized; refusing to activate unaudited bytes.`,
      "DANGEROUS_ENV_AUDIT_FAILED",
    );
  }
}

async function auditPreparedUpdate(
  prepared: PreparedUpdate,
  id: string,
  ref: string,
  allowInsecure: boolean,
): Promise<void> {
  updateTransactionHook("staged", id);
  const decision = await auditStashForDangerousKeys({
    stashRoot: prepared.auditRoot,
    ref,
    allowDangerousKeys: allowInsecure,
    isTTY: process.stdin.isTTY === true,
    operation: "update",
    renderBlockedError: false,
  });
  if (decision.blocked) throw new NotFoundError(decision.error, decision.code);
  prepared.approvedDangerousFindings = dangerousFindingGeneration(decision.findings);
  prepared.auditedContentGeneration = await contentGeneration(prepared.auditRoot);
  updateTransactionHook("audited", id);
}

function canonicalWritablePath(candidate: string, description: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    throw new ConfigError(
      `Cannot resolve ${description} at ${candidate}; refusing writable Git update. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function containedWritablePath(candidate: string, physicalRepo: string, description: string): string {
  const physicalCandidate = canonicalWritablePath(candidate, description);
  if (!pathAtOrBelow(physicalCandidate, physicalRepo)) {
    throw new ConfigError(`${description} ${candidate} resolves outside its physical checkout at ${physicalRepo}.`);
  }
  return physicalCandidate;
}

function prepareWritableManagedUpdate(managed: ManagedInstall, force: boolean): Promise<PreparedManagedUpdate> {
  const physicalLocalRoot = canonicalWritablePath(managed.localRoot, "managed content root");
  const topLevel = runGit(["-C", physicalLocalRoot, "rev-parse", "--show-toplevel"]);
  // Production writable installs are Git checkouts. Falling back to the
  // locked root keeps the provider seam testable; the real Git provider still
  // refuses a copied non-checkout before publication.
  const liveRepo =
    topLevel.status === 0 && topLevel.stdout.trim()
      ? canonicalWritablePath(topLevel.stdout.trim(), "managed Git top-level")
      : physicalLocalRoot;
  if (!pathAtOrBelow(physicalLocalRoot, liveRepo)) {
    throw new ConfigError(
      `Writable Git content root ${managed.localRoot} resolves outside its physical checkout at ${liveRepo}.`,
    );
  }
  // Keep the configured component path as a lexical identity relative to the
  // content root. Resolving it to today's symlink target here would pin the old
  // target and miss an upstream commit that retargets the symlink.
  const lexicalLocalRoot = path.resolve(managed.localRoot);
  const configuredLiveRoots = managed.requiredRoots.map((root) => {
    const lexicalRoot = path.resolve(root);
    if (!pathAtOrBelow(lexicalRoot, lexicalLocalRoot)) {
      throw new ConfigError(
        `Configured writable Git component root ${lexicalRoot} escapes content root ${lexicalLocalRoot}.`,
      );
    }
    return path.resolve(physicalLocalRoot, path.relative(lexicalLocalRoot, lexicalRoot));
  });
  const physicalRequiredRoots = configuredLiveRoots.map((root) =>
    containedWritablePath(root, liveRepo, `Configured component root for "${managed.installId}"`),
  );
  // The Git provider must preserve ordinary component directories, but not a
  // symlink's current physical target. The configured lexical path is audited
  // again after sync, so retaining the old target here would reject a valid
  // upstream retarget before the new target can reach that audit.
  const preservedPhysicalRequiredRoots = physicalRequiredRoots.filter(
    (root, index) => configuredLiveRoots[index] === root,
  );
  const expectedOldHead = gitHead(liveRepo);
  const stagingParent = createStagingParent(path.dirname(liveRepo));
  const stagedRepo = path.join(stagingParent, path.basename(liveRepo));
  fs.cpSync(liveRepo, stagedRepo, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const stagedContentRoot = remapStagedPath(physicalLocalRoot, liveRepo, stagedRepo);
  const stagedPhysicalRequiredRoots = preservedPhysicalRequiredRoots.map((root) =>
    remapStagedPath(root, liveRepo, stagedRepo),
  );
  const stagedConfiguredRoots = configuredLiveRoots.map((root) => remapStagedPath(root, liveRepo, stagedRepo));

  return syncFromRef(managed.ref, {
    force,
    writable: true,
    writableRoot: stagedContentRoot,
    ...(stagedPhysicalRequiredRoots.length > 0 ? { writableRequiredRoots: stagedPhysicalRequiredRoots } : {}),
  })
    .then((staged) => {
      const auditedTargetHead = gitHead(stagedRepo);
      const physicalStagedRepo = canonicalWritablePath(stagedRepo, "staged managed Git checkout");
      const auditedConfiguredRoots = stagedConfiguredRoots.map((root) =>
        containedWritablePath(root, physicalStagedRepo, `Post-sync component root for "${managed.installId}"`),
      );
      const expectedPublishedRoots = auditedConfiguredRoots.map((root) =>
        path.join(liveRepo, path.relative(physicalStagedRepo, root)),
      );
      const synced: SourceLockData = {
        ...staged,
        resolvedRevision: auditedTargetHead ?? staged.resolvedRevision,
        contentDir: remapStagedPath(staged.contentDir, stagedRepo, liveRepo),
        cacheDir: remapStagedPath(staged.cacheDir, stagedRepo, liveRepo),
        extractedDir: remapStagedPath(staged.extractedDir, stagedRepo, liveRepo),
      };
      return {
        synced,
        auditRoot: auditedConfiguredRoots[0] ?? staged.contentDir,
        publishedAuditRoot: configuredLiveRoots[0] ?? synced.contentDir,
        publishedAuditContainmentRoot: liveRepo,
        publishedAuditExpectedPhysicalRoot: expectedPublishedRoots[0] ?? synced.contentDir,
        publication: writableGitPublication({ stagedRepo, liveRepo, expectedOldHead, auditedTargetHead }),
        cleanup: () => cleanupStagingParent(stagingParent),
      };
    })
    .catch((error) => {
      cleanupStagingParent(stagingParent);
      throw error;
    });
}

async function prepareManagedUpdate(managed: ManagedInstall, force: boolean): Promise<PreparedManagedUpdate> {
  if (managed.writable && managed.localRoot) return prepareWritableManagedUpdate(managed, force);

  if (managed.source === "local") {
    const synced = await syncFromRef(managed.ref, { force, writable: managed.writable });
    return {
      synced,
      auditRoot: resolveComponentAuditRoot(synced.contentDir, managed.componentRoot, managed.installId),
      cleanup: () => {},
    };
  }

  const canonicalCacheRoot = getRegistryCacheDir();
  const stagingParent = createStagingParent(canonicalCacheRoot);
  try {
    const staged = await syncFromRef(managed.ref, {
      force,
      writable: false,
      cacheRootDir: stagingParent,
    });
    if (!pathAtOrBelow(staged.cacheDir, stagingParent)) {
      // Test/provider seams may return an already-isolated candidate. It remains
      // invisible until the lock points at it, so no directory promotion is needed.
      return {
        synced: staged,
        auditRoot: resolveComponentAuditRoot(staged.contentDir, managed.componentRoot, managed.installId),
        cleanup: () => cleanupStagingParent(stagingParent),
      };
    }
    const liveCacheDir = path.join(canonicalCacheRoot, path.relative(stagingParent, staged.cacheDir));
    const synced: SourceLockData = {
      ...staged,
      contentDir: remapStagedPath(staged.contentDir, staged.cacheDir, liveCacheDir),
      cacheDir: liveCacheDir,
      extractedDir: remapStagedPath(staged.extractedDir, staged.cacheDir, liveCacheDir),
    };
    return {
      synced,
      auditRoot: resolveComponentAuditRoot(staged.contentDir, managed.componentRoot, managed.installId),
      publication: prepareDirectoryPublication(staged.cacheDir, liveCacheDir),
      cleanup: () => cleanupStagingParent(stagingParent),
    };
  } catch (error) {
    cleanupStagingParent(stagingParent);
    throw error;
  }
}

function resolveComponentAuditRoot(contentRoot: string, componentRoot: string, id: string): string {
  const resolved = path.resolve(contentRoot, componentRoot);
  if (!pathAtOrBelow(resolved, contentRoot)) {
    throw new ConfigError(`Component root "${componentRoot}" escapes staged bundle "${id}".`);
  }
  return resolved;
}

async function publishPreparedPlainUpdate(
  id: string,
  ref: string,
  prepared: PreparedUpdate,
  stashDir: string,
  allowInsecure: boolean,
  full: boolean,
  expectedConfigGeneration: string,
): Promise<Awaited<ReturnType<typeof akmIndex>>> {
  try {
    await auditPreparedUpdate(prepared, id, ref, allowInsecure);
    return await withAssetMutationLease("source-update", async () => {
      let transaction: UnifiedUpdateTransaction | undefined;
      let releaseConfigFence: (() => void) | undefined;
      let contentPublished = false;
      let committed = false;
      try {
        const configFence = acquireConfigReadFence();
        releaseConfigFence = configFence.release;
        assertBundleAuditFence(configFence.config, id, expectedConfigGeneration);
        updateTransactionHook("fenced", id);
        if (prepared.publication) {
          prepared.publication.publish();
          contentPublished = true;
        }
        await verifyPublishedAudit(prepared, id);
        updateTransactionHook("published", id);
        updateTransactionHook("before-index", id);
        transaction = openUnifiedUpdateTransaction();
        const index = await akmIndex({
          stashDir,
          ...(full ? { full: true } : {}),
          hydrateSources: false,
          persistDetectedAdapters: false,
          deferredUpdateTransaction: transaction.deferred,
        });
        updateTransactionHook("indexed", id, { db: transaction.db });
        // Re-fence the exact published worktree after the potentially long
        // index pass and immediately before the coordinator commit. This
        // catches cooperating or observable external writes that land after
        // the first post-materialization audit.
        await verifyPublishedAudit(prepared, id);
        updateTransactionHook("before-commit", id, { db: transaction.db });
        commitUnifiedUpdateTransaction(transaction);
        committed = true;
        prepared.publication?.commit();
        return await runPostCommitEmbeddingPass(index);
      } catch (error) {
        let recoveryError = transaction ? rollbackUnifiedUpdateTransaction(transaction) : undefined;
        try {
          if (contentPublished) prepared.publication?.rollback();
        } catch (rollbackError) {
          recoveryError ??= rollbackError;
        }
        if (recoveryError) throw recoveryError;
        throw error;
      } finally {
        try {
          if (transaction) closeUnifiedUpdateTransaction(transaction, committed);
        } finally {
          releaseConfigFence?.();
        }
      }
    });
  } finally {
    prepared.cleanup();
  }
}

async function prepareGitPlainUpdate(
  gitSource: ReturnType<typeof getSources>[number],
  componentRoot: string,
  writable: boolean,
): Promise<PreparedUpdate> {
  if (!gitSource.url) throw new ConfigError(`Git source "${gitSource.name ?? "git"}" has no URL.`);
  const repo = parseGitRepoUrl(gitSource.url);
  const livePaths = getCachePaths(repo.canonicalUrl);
  const stagingParent = createStagingParent(path.dirname(livePaths.rootDir));
  const stagedPaths = getCachePaths(repo.canonicalUrl, stagingParent);
  try {
    const expectedOldHead = writable ? gitHead(livePaths.repoDir) : undefined;
    if (writable && fs.existsSync(livePaths.rootDir)) {
      fs.cpSync(livePaths.rootDir, stagedPaths.rootDir, { recursive: true, preserveTimestamps: true });
    }
    const staged = await syncMirroredRepo(gitSource, {
      force: true,
      writable,
      cacheRootDir: stagingParent,
    });
    const configuredStagedAuditRoot = resolveComponentAuditRoot(
      resolveGitContentRoot(staged.contentDir),
      componentRoot,
      gitSource.name ?? "git",
    );
    if (!pathAtOrBelow(staged.cacheDir, stagingParent)) {
      if (pathAtOrBelow(configuredStagedAuditRoot, livePaths.rootDir)) {
        throw new ConfigError(
          `Git provider for "${gitSource.name ?? gitSource.url}" wrote into the active cache instead of the update staging root; refusing to index it.`,
        );
      }
      // A provider test seam may hand back an already-isolated candidate.
      // Audit it, but do not move an unowned directory into the canonical
      // cache. Real providers honor cacheRootDir and use the promotion below.
      return {
        auditRoot: configuredStagedAuditRoot,
        cleanup: () => cleanupStagingParent(stagingParent),
      };
    }
    let auditRoot = configuredStagedAuditRoot;
    let publishedAuditRoot: string | undefined;
    let publishedAuditContainmentRoot: string | undefined;
    let publishedAuditExpectedPhysicalRoot: string | undefined;
    if (writable) {
      const physicalStagedRepo = canonicalWritablePath(stagedPaths.repoDir, "staged plain Git checkout");
      auditRoot = containedWritablePath(
        configuredStagedAuditRoot,
        physicalStagedRepo,
        `Post-sync component root for "${gitSource.name ?? "git"}"`,
      );
      publishedAuditRoot = remapStagedPath(configuredStagedAuditRoot, staged.cacheDir, livePaths.rootDir);
      publishedAuditContainmentRoot = canonicalWritablePath(livePaths.repoDir, "plain Git checkout");
      publishedAuditExpectedPhysicalRoot = path.join(
        publishedAuditContainmentRoot,
        path.relative(physicalStagedRepo, auditRoot),
      );
    }
    return {
      auditRoot,
      ...(publishedAuditRoot ? { publishedAuditRoot } : {}),
      ...(publishedAuditContainmentRoot ? { publishedAuditContainmentRoot } : {}),
      ...(publishedAuditExpectedPhysicalRoot ? { publishedAuditExpectedPhysicalRoot } : {}),
      publication: writable
        ? writableGitPublication({
            stagedRepo: stagedPaths.repoDir,
            liveRepo: livePaths.repoDir,
            expectedOldHead,
          })
        : prepareDirectoryPublication(staged.cacheDir, livePaths.rootDir),
      cleanup: () => cleanupStagingParent(stagingParent),
    };
  } catch (error) {
    cleanupStagingParent(stagingParent);
    throw error;
  }
}

async function syncGitPlainSource(
  gitSource: ReturnType<typeof getSources>[number],
  stashDir: string,
  allowInsecure: boolean,
): Promise<{ item: UpdatePlainSyncedItem; index: Awaited<ReturnType<typeof akmIndex>> }> {
  const id = gitSource.name ?? gitSource.url ?? "";
  const currentConfig = loadConfig();
  const currentSource = currentPlainSource(currentConfig, id, "git");
  const ref = currentSource.url ?? "";
  const fence = bundleAuditFence(currentConfig, id);
  const prepared = await prepareGitPlainUpdate(currentSource, fence.componentRoot, fence.writable);
  const index = await publishPreparedPlainUpdate(id, ref, prepared, stashDir, allowInsecure, true, fence.generation);
  return { item: { id, kind: "git", ref }, index };
}

async function prepareWebsitePlainUpdate(
  websiteSource: ReturnType<typeof getSources>[number],
  componentRoot: string,
): Promise<PreparedUpdate> {
  if (!websiteSource.url) throw new ConfigError(`Website source "${websiteSource.name ?? "website"}" has no URL.`);
  const livePaths = getWebsiteCachePaths(websiteSource.url);
  const stagingParent = createStagingParent(path.dirname(livePaths.rootDir));
  const stagedPaths = getWebsiteCachePaths(websiteSource.url, stagingParent);
  try {
    const provider = createWebsiteProvider(websiteSource);
    await provider.sync({
      force: true,
      secrets: storeSecretResolver,
      ensureWebsiteMirror: (config, options) =>
        ensureWebsiteMirror(config, {
          ...options,
          resolveSecret: options?.resolveSecret ?? storeSecretResolver.resolveSecret,
          cacheRootDir: stagingParent,
        }),
    });
    return {
      auditRoot: resolveComponentAuditRoot(stagedPaths.stashDir, componentRoot, websiteSource.name ?? "website"),
      publication: prepareDirectoryPublication(stagedPaths.rootDir, livePaths.rootDir),
      cleanup: () => cleanupStagingParent(stagingParent),
    };
  } catch (error) {
    cleanupStagingParent(stagingParent);
    throw error;
  }
}

async function syncWebsitePlainSource(
  websiteSource: ReturnType<typeof getSources>[number],
  stashDir: string,
  allowInsecure: boolean,
): Promise<{ item: UpdatePlainSyncedItem; index: Awaited<ReturnType<typeof akmIndex>> }> {
  const id = websiteSource.name ?? websiteSource.url ?? "";
  const currentConfig = loadConfig();
  const currentSource = currentPlainSource(currentConfig, id, "website");
  const ref = currentSource.url ?? "";
  const fence = bundleAuditFence(currentConfig, id);
  const prepared = await prepareWebsitePlainUpdate(currentSource, fence.componentRoot);
  const index = await publishPreparedPlainUpdate(id, ref, prepared, stashDir, allowInsecure, true, fence.generation);
  return { item: { id, kind: "website", ref }, index };
}

/** Sync a git-mirrored (plain) source and return an UpdateResponse (single-target path). */
async function updateGitSource(
  stashDir: string,
  target: string,
  all: boolean,
  gitSource: ReturnType<typeof getSources>[number],
  allowInsecure: boolean,
): Promise<UpdateResponse> {
  const synced = await syncGitPlainSource(gitSource, stashDir, allowInsecure);
  return buildUpdateResponse(stashDir, target, all, [], { plainSynced: [synced.item], index: synced.index });
}

/** Re-crawl a website (plain) source and return an UpdateResponse (single-target path). */
async function updateWebsiteSource(
  stashDir: string,
  target: string,
  all: boolean,
  websiteSource: ReturnType<typeof getSources>[number],
  allowInsecure: boolean,
): Promise<UpdateResponse> {
  const synced = await syncWebsitePlainSource(websiteSource, stashDir, allowInsecure);
  return buildUpdateResponse(stashDir, target, all, [], { plainSynced: [synced.item], index: synced.index });
}

/** Reconcile a filesystem source's current bytes without provider hydration. */
async function updateFilesystemSource(
  stashDir: string,
  target: string,
  all: boolean,
  filesystemSource: ReturnType<typeof getSources>[number],
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
function managedInstallViewOfPlainNpm(npmSource: ReturnType<typeof getSources>[number]): ManagedInstall {
  const id = npmSource.name ?? npmSource.path ?? "";
  const config = loadConfig();
  const currentSource = currentPlainSource(config, id, "npm");
  const spec = currentSource.path ?? "";
  const ref = spec.startsWith("npm:") ? spec : `npm:${spec}`;
  const fence = bundleAuditFence(config, id);
  return {
    bundleKey: id,
    installId: id,
    source: "npm",
    ref,
    localRoot: "",
    resolvedVersion: undefined,
    resolvedRevision: undefined,
    writable: false,
    componentRoot: fence.componentRoot,
    requiredRoots: [],
    auditConfigGeneration: fence.generation,
  };
}

/**
 * Sync a single registry-managed install and return the processed record.
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
  allowInsecure: boolean,
): Promise<{ item: UpdateResultItem; index: Awaited<ReturnType<typeof akmIndex>> }> {
  // No pre-cleanup of the old root, even under --force: the providers already
  // re-materialize staging-first (git clones into a `.tmp-*` sibling and swaps
  // only on success), so destroying `managed.localRoot` BEFORE `syncFromRef`
  // succeeds would turn any sync failure (network down, bad ref) into losing a
  // previously-working install. The old root is cleaned up below only after
  // config/lock publication and reindexing both succeed.
  const prepared = await prepareManagedUpdate(managed, force);
  try {
    await auditPreparedUpdate(prepared, managed.installId, managed.ref, allowInsecure);
    const synced = prepared.synced;

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

    return await withAssetMutationLease("source-update", async () => {
      const oldLockSnapshot = readLockfileForUpdate();
      const oldLocks = oldLockSnapshot.entries;
      const desiredLock: LockfileEntry = {
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
      };
      const desiredLocks = [...oldLocks.filter((entry) => entry.id !== desiredLock.id), desiredLock];
      const desiredLockGeneration = generationHash(desiredLocks);
      let transaction: UnifiedUpdateTransaction | undefined;
      let releaseConfigFence: (() => void) | undefined;
      let contentPublished = false;
      let lockPublished = false;
      let publishedLockSnapshot: ReturnType<typeof readLockfileForUpdate> | null | undefined;
      let committed = false;
      let index: Awaited<ReturnType<typeof akmIndex>>;
      try {
        const configFence = acquireConfigReadFence();
        releaseConfigFence = configFence.release;
        assertBundleAuditFence(configFence.config, managed.bundleKey, managed.auditConfigGeneration);
        updateTransactionHook("fenced", managed.installId);
        if (prepared.publication) {
          prepared.publication.publish();
          contentPublished = true;
        }
        await verifyPublishedAudit(prepared, managed.installId);
        publishedLockSnapshot = await publishLockfileUpdate(oldLockSnapshot, desiredLocks);
        if (!publishedLockSnapshot) throw concurrentGenerationError(managed);
        lockPublished = true;
        updateTransactionHook("published", managed.installId);
        updateTransactionHook("before-index", managed.installId);
        transaction = openUnifiedUpdateTransaction();
        index = await akmIndex({
          stashDir,
          full: true,
          hydrateSources: false,
          persistDetectedAdapters: false,
          deferredUpdateTransaction: transaction.deferred,
        });
        const currentLockSnapshot = readLockfileForUpdate();
        if (
          generationHash(currentLockSnapshot.entries) !== desiredLockGeneration ||
          currentLockSnapshot.raw !== publishedLockSnapshot.raw ||
          currentLockSnapshot.mode !== publishedLockSnapshot.mode
        ) {
          throw concurrentGenerationError(managed);
        }
        updateTransactionHook("indexed", managed.installId, { db: transaction.db });
        // Indexing can be long enough for a local writer to race the first
        // post-materialization audit. Re-verify the exact bytes/findings at the
        // final cross-store commit boundary while every AKM fence is held.
        await verifyPublishedAudit(prepared, managed.installId);
        updateTransactionHook("before-commit", managed.installId, { db: transaction.db });
        commitUnifiedUpdateTransaction(transaction);
        committed = true;
      } catch (error) {
        let recoveryError = transaction ? rollbackUnifiedUpdateTransaction(transaction) : undefined;
        let concurrentGeneration = false;
        let concurrentGenerationOwnsPublishedRoot = false;
        if (lockPublished) {
          try {
            if (
              !publishedLockSnapshot ||
              !(await compareAndSwapLockfileSnapshot(publishedLockSnapshot, oldLockSnapshot))
            ) {
              concurrentGeneration = true;
              const concurrentLocks = readLockfileForUpdate().entries;
              const concurrentEntry = concurrentLocks.find((entry) => entry.id === desiredLock.id);
              concurrentGenerationOwnsPublishedRoot =
                prepared.publication !== undefined &&
                concurrentEntry?.localRoot !== undefined &&
                path.resolve(concurrentEntry.localRoot) === path.resolve(synced.contentDir);
            }
          } catch (compensationError) {
            recoveryError ??= compensationError;
          }
        }

        if (!concurrentGenerationOwnsPublishedRoot) {
          try {
            if (contentPublished) prepared.publication?.rollback();
          } catch (rollbackError) {
            recoveryError ??= rollbackError;
          }
        }

        if (recoveryError) throw recoveryError;
        if (concurrentGeneration) throw concurrentGenerationError(managed);
        throw error;
      } finally {
        try {
          if (transaction) closeUnifiedUpdateTransaction(transaction, committed);
        } finally {
          releaseConfigFence?.();
        }
      }

      prepared.publication?.commit();
      index = await runPostCommitEmbeddingPass(index);

      if (movedRoot) {
        const currentConfig = loadConfig();
        const currentLocks = readLockfile();
        if (referencesRoot(managed.localRoot, currentConfig, currentLocks)) {
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
    });
  } finally {
    prepared.cleanup();
  }
}

function generationHash(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
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

function concurrentGenerationError(managed: ManagedInstall): ConfigError {
  return new ConfigError(
    `Managed source "${managed.installId}" changed concurrently; retained both materialized roots and deleted nothing.`,
    "INVALID_CONFIG_FILE",
    "Inspect `akm bundle list` and retry the update after the concurrent source operation completes.",
  );
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
  allowInsecure?: boolean;
}): Promise<UpdateResponse> {
  const stashDir = input?.stashDir ?? resolveStashDir();
  const target = input?.target?.trim();
  const all = input?.all === true;
  const force = input?.force === true;
  const yes = input?.yes === true;
  const allowInsecure = input?.allowInsecure === true;
  const config = loadConfig();
  const managedInstalls = listManagedInstalls(config);

  if (target && !all) {
    // Registry-managed install (lock-backed) — re-download from its locator.
    const managed = resolveManagedTarget(config, target);
    if (managed) {
      const updated = await updateManagedInstall(managed, force, yes, stashDir, allowInsecure);
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
    if (gitMatch) return updateGitSource(stashDir, target, all, gitMatch, allowInsecure);

    const websiteMatch = stashes.find((s) => {
      if (s.type !== "website") return false;
      if (isUrl && s.url === target) return true;
      if (s.name === target) return true;
      if (resolvedPath && s.path && path.resolve(s.path) === resolvedPath) return true;
      return false;
    });
    if (websiteMatch) return updateWebsiteSource(stashDir, target, all, websiteMatch, allowInsecure);

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
        managedInstallViewOfPlainNpm(npmMatch),
        force,
        yes,
        stashDir,
        allowInsecure,
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
  let latestIndex: Awaited<ReturnType<typeof akmIndex>> | undefined;
  for (const managed of selected) {
    try {
      const updated = await updateManagedInstall(managed, force, yes, stashDir, allowInsecure);
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
  // previously never even looked at. Git/npm plain sources are synced here
  // too (git and website through staged promotion; npm promoted to managed,
  // same as the single-target path above). Filesystem sources reflect their
  // files in place and are reported as intentionally skipped.
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
          const updated = await syncGitPlainSource(plain, stashDir, allowInsecure);
          plainSynced.push(updated.item);
          latestIndex = updated.index;
        } else if (plain.type === "npm") {
          const updated = await updateManagedInstall(
            managedInstallViewOfPlainNpm(plain),
            force,
            yes,
            stashDir,
            allowInsecure,
          );
          processed.push(updated.item);
          latestIndex = updated.index;
        } else if (plain.type === "website") {
          const updated = await syncWebsitePlainSource(plain, stashDir, allowInsecure);
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
