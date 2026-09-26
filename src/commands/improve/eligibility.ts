// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The refs an improve run may consider, read from the index, and the small predicates over them. */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, parseRefInput, resolveRef, typeNameFromConceptId } from "../../core/asset/resolve-ref";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import type { ImproveEligibleRef, ImproveIndexSnapshot } from "../../core/improve-types";
import { isPathAbsent } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { deriveInstallations, deriveWritableBundleIds } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import type { Database } from "../../storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { hasCurrentEntriesTable } from "../../storage/repositories/index-entry-schema";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import { SqliteReadSnapshotUnavailableError } from "../../storage/sqlite-read-snapshot";
import { isDistillRefusedInputType } from "./distill";
import { isStrategyFilteredForAllPasses } from "./improve-strategies";
import { parseMemoryRef } from "./memory/derived-ref";

type Scope = { mode: "all" | "type" | "ref"; value?: string };

/** The asset type of a short or bundle-qualified conceptId (`""` when unknown). */
export function assetTypeOf(ref: string): string {
  return typeNameFromConceptId(ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref)?.type ?? "";
}

/**
 * Run `fn` against index.db — the live index, or a non-mutating snapshot for
 * a dry run. `undefined` when there is none or the read fails (best-effort).
 */
export function withIndexDb<T>(readOnly: boolean, fn: (db: Database) => T): T | undefined {
  let db: Database | undefined;
  try {
    db = readOnly ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    return db ? fn(db) : undefined;
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return undefined;
  } finally {
    if (db) closeDatabase(db);
  }
}

/**
 * The index for candidate selection, or `undefined` when it is absent. An
 * index without a readable `entries` table needs a rebuild and says so.
 */
function openEligibilityDb(readOnly: boolean): Database | undefined {
  const db = readOnly
    ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true })
    : isPathAbsent(getDbPath())
      ? undefined
      : openExistingDatabase();
  if (db && !hasCurrentEntriesTable(db)) {
    closeDatabase(db);
    throw new ConfigError(
      "index.db has no entries table this akm can read, so nothing can be selected for improvement.",
      "INDEX_SCHEMA_INCOMPATIBLE",
      "Run `akm index` to rebuild the derived index from the currently materialized sources.",
    );
  }
  return db;
}

/**
 * How a dry run describes an index it could not read. Only the typed
 * failures map to an empty plan; any other error still throws.
 */
function unreadableSnapshot(readOnly: boolean, error: unknown): ImproveIndexSnapshot | undefined {
  if (!readOnly) return undefined;
  if (error instanceof SqliteReadSnapshotUnavailableError) {
    return {
      status: "incompatible",
      reason: `index.db cannot provide a stable non-mutating snapshot (${error.message}); dry-run uses an empty snapshot`,
    };
  }
  if (error instanceof ConfigError && error.code === "INDEX_SCHEMA_INCOMPATIBLE") {
    return {
      status: "incompatible",
      reason: `index.db is incompatible; ${error.hint() ?? error.message} Dry-run uses an empty snapshot and does not migrate it.`,
    };
  }
  return undefined;
}

export function resolveImproveScope(scope: string | undefined): Scope {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseRefInput(trimmed);
    return { mode: "ref", value: trimmed };
  } catch (err) {
    // A bare word is a `--scope <type>` filter (an unknown type matches
    // nothing); a ref-shaped value that fails to parse is a real error.
    if (!/[/:#]/.test(trimmed)) return { mode: "type", value: trimmed };
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Invalid --scope "${trimmed}": ${message}`, "INVALID_FLAG_VALUE");
  }
}

/** Dedupe by durable identity (item_ref, else ref), keeping the first. */
export function dedupeRefs(refs: ImproveEligibleRef[]): ImproveEligibleRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = r.itemRef ?? r.ref;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type EligibleRefs = {
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
  /**
   * Refs every per-ref pass (reflect and distill) of the active strategy would
   * refuse. Dropped here, reported once as `strategy_filtered_all_passes`.
   */
  strategyFilteredRefs: ImproveEligibleRef[];
  /** The index state the selector observed. */
  indexSnapshot?: ImproveIndexSnapshot;
};

export async function collectEligibleRefs(
  scope: Scope,
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
  config?: AkmConfig,
): Promise<EligibleRefs> {
  return collectEligibleRefsFromIndex(scope, stashDir, improveProfile, false, config);
}

/** Dry-run selector: query an existing index without creating or mutating it. */
export async function collectEligibleRefsReadOnly(
  scope: Scope,
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
  config?: AkmConfig,
): Promise<EligibleRefs> {
  return collectEligibleRefsFromIndex(scope, stashDir, improveProfile, true, config);
}

async function collectEligibleRefsFromIndex(
  scope: Scope,
  stashDir: string | undefined,
  improveProfile: ImproveProfileConfig | undefined,
  readOnly: boolean,
  configOverride?: AkmConfig,
): Promise<EligibleRefs> {
  const empty = (indexSnapshot?: ImproveIndexSnapshot): EligibleRefs => ({
    plannedRefs: [],
    memorySummary: { eligible: 0, derived: 0 },
    strategyFilteredRefs: [],
    ...(indexSnapshot ? { indexSnapshot } : {}),
  });
  const config = configOverride ?? loadConfig();
  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir, config);
  } catch {
    return empty();
  }
  if (sources.length === 0) return empty();
  const installations = deriveInstallations(sources);
  const writableBundleIds = deriveWritableBundleIds(sources);
  const ready: ImproveIndexSnapshot = {
    status: "ready",
    reason: readOnly ? "loaded a non-mutating point-in-time copy of the existing index" : "loaded the prepared index",
  };
  const missing: ImproveIndexSnapshot = {
    status: "missing",
    reason: readOnly
      ? "index.db is missing; dry-run uses an empty snapshot and does not create it"
      : "index.db is missing after index preparation; the selector uses an empty snapshot",
  };
  let db: Database | undefined;
  try {
    db = openEligibilityDb(readOnly);
    if (!db) return empty(missing);
    if (scope.mode === "ref" && scope.value) {
      const entriesByItemRef = new Map(getAllEntries(db).map((entry) => [entry.itemRef, entry] as const));
      const resolved = resolveRef(scope.value, {
        defaultBundle: config.defaultBundle,
        bundles: installations.map((installation) => ({
          id: installation.id,
          hasConcept: (conceptId) => entriesByItemRef.has(`${installation.id}//${conceptId}`),
        })),
      });
      const indexed = entriesByItemRef.get(`${resolved.bundle}//${resolved.conceptId}`);
      if (!indexed?.bundleId || !indexed.conceptId || !fs.existsSync(indexed.filePath)) {
        if (await findAssetFilePath(scope.value, stashDir)) return empty(ready);
        throw new NotFoundError(`Asset not found in the selected writable source: ${scope.value}`, "ASSET_NOT_FOUND");
      }
      if (!writableBundleIds.has(indexed.bundleId)) return empty(ready);
      const isMemory = indexed.entry.type === "memory";
      return {
        plannedRefs: [
          { ref: indexed.conceptId, itemRef: indexed.itemRef, reason: "scope-ref", filePath: indexed.filePath },
        ],
        memorySummary: {
          eligible: isMemory ? 1 : 0,
          derived: isMemory && indexed.entry.name.endsWith(".derived") ? 1 : 0,
        },
        strategyFilteredRefs: [],
        indexSnapshot: ready,
      };
    }
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined).filter((indexed) =>
      writableBundleIds.has(indexed.bundleId),
    );
    const planned = new Map<string, ImproveEligibleRef>();
    const strategyFiltered = new Map<string, ImproveEligibleRef>();
    let memoryEligible = 0;
    let memoryDerived = 0;
    for (const indexed of entries) {
      const ref = conceptIdFromTypeName(indexed.entry.type, indexed.entry.name);
      try {
        parseRefInput(ref);
      } catch (error) {
        if (error instanceof UsageError || error instanceof NotFoundError) continue;
        throw error;
      }
      const isDerived = indexed.entry.name.endsWith(".derived");
      // `.derived` memories skip reflect; cleanup inspects them on its own.
      if (!isDerived && !planned.has(ref) && !strategyFiltered.has(ref)) {
        const candidate = { ref, filePath: indexed.filePath, itemRef: indexed.itemRef };
        if (improveProfile && isStrategyFilteredForAllPasses(ref, improveProfile)) {
          strategyFiltered.set(ref, { ...candidate, reason: "strategy_filtered_all_passes" });
        } else {
          const reason = scope.mode !== "type" && indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type";
          planned.set(ref, { ...candidate, reason });
        }
      }
      if (indexed.entry.type === "memory") {
        memoryEligible += 1;
        if (isDerived) memoryDerived += 1;
      }
    }
    return {
      plannedRefs: [...planned.values()],
      memorySummary: { eligible: memoryEligible, derived: memoryDerived },
      strategyFilteredRefs: [...strategyFiltered.values()],
      indexSnapshot: ready,
    };
  } catch (error) {
    rethrowIfTestIsolationError(error);
    const snapshot = unreadableSnapshot(readOnly, error);
    if (snapshot) return empty(snapshot);
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
}

/** The parent memory a `--scope <memory ref>` cleanup is restricted to. */
export function memoryCleanupParentRef(scope: Scope, stashDir?: string): string | undefined {
  if (scope.mode !== "ref" || !scope.value) return undefined;
  const parsed = parseRefInput(scope.value);
  if (parsed.type !== "memory") return undefined;
  if (!parsed.name.endsWith(".derived")) return conceptIdFromTypeName(parsed.type, parsed.name);
  for (const source of resolveSourceEntries(stashDir)) {
    const candidate = path.join(source.path, "memories", `${parsed.name}.md`);
    if (!fs.existsSync(candidate)) continue;
    const fm = parseFrontmatter(fs.readFileSync(candidate, "utf8")).data;
    const parent = parseMemoryRef(typeof fm.source === "string" ? fm.source : undefined);
    if (parent) return parent;
  }
  return conceptIdFromTypeName("memory", parsed.name.slice(0, -".derived".length));
}

export function isLessonCandidate(ref: string): boolean {
  return parseRefInput(ref).type === "lesson";
}

/** Should this ref enter the distill queue? Types distill refuses never do. */
export function isDistillCandidateRef(ref: string, stashDir?: string): boolean {
  if (isDistillRefusedInputType(parseRefInput(ref).type)) return false;
  return shouldDistillMemoryRef(ref, stashDir);
}

/** A non-derived memory that is not marked `quality: proposed`. */
export function shouldDistillMemoryRef(ref: string, stashDir?: string): boolean {
  const parsed = parseRefInput(ref);
  if (parsed.type !== "memory") return false;
  for (const source of resolveSourceEntries(stashDir)) {
    const candidate = `${source.path}/memories/${parsed.name}.md`;
    if (!fs.existsSync(candidate)) continue;
    if (parseFrontmatter(fs.readFileSync(candidate, "utf8")).data.quality === "proposed") return false;
    break;
  }
  return !parsed.name.endsWith(".derived");
}

export function shouldAnalyzeMemoryCleanup(
  scope: Scope,
  eligibleMemories: number,
  primaryStashDir: string | undefined,
): boolean {
  if (!primaryStashDir || eligibleMemories === 0) return false;
  if (scope.mode === "all") return true;
  if (scope.mode === "type") return scope.value === "memory";
  return scope.value ? parseRefInput(scope.value).type === "memory" : false;
}

export function buildUtilityMap(refs: ImproveEligibleRef[], readOnly = false): Map<string, number> {
  const map = new Map<string, number>();
  if (refs.length === 0) return map;
  const refSet = new Set(refs.map((r) => r.ref));
  withIndexDb(readOnly, (db) => {
    const idToRef = new Map<number, string>();
    for (const indexed of getAllEntries(db)) {
      const ref = conceptIdFromTypeName(indexed.entry.type, indexed.entry.name);
      if (refSet.has(ref)) idToRef.set(indexed.id, ref);
    }
    if (idToRef.size === 0) return;
    for (const [id, score] of getUtilityScoresByIds(db, [...idToRef.keys()]).global) {
      const ref = idToRef.get(id);
      if (ref) map.set(ref, score.utility);
    }
  });
  return map;
}

export async function findAssetFilePath(
  ref: string,
  stashDir?: string,
  writableBundleIds?: Set<string>,
): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    writableBundleIds,
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: true,
  });
}
