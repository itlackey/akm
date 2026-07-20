// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle` read surface — the 0.9.0 CLI convergence toward the bundle
 * command family (normative spec §29). This module owns the READ verbs
 * (`list`, `show`, `items`) over the workspace's resolved bundle state:
 *
 *   - the desired configuration (`bundles` / `defaultBundle`, spec §10.1), and
 *   - the resolved lock state (`akm.lock`, spec §10.2), joined by bundle id, and
 *   - the persisted index (`item_ref` / `bundle_id` provenance columns) for the
 *     per-bundle item listing.
 *
 * Scope note (deliberate): the lifecycle verbs the §29 direction also lists
 * (`create`/`install`/`update`/`remove`/`sync`/`export`) keep their existing
 * top-level commands (`akm add`/`update`/`remove`/`sync`, …) for 0.9.0 — this
 * chunk adds the new read namespace over the freshly-landed `bundles` config +
 * lock state, nothing more. `akm bind|unbind|bindings` are Tier B and are NOT
 * implemented (spec §18 staging note, §29). No trust/activation machinery lives
 * here — these are pure reads of already-persisted state.
 */

import fs from "node:fs";
import type { AkmConfig, BundleConfigEntry } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import type { LockfileEntry } from "../../integrations/lockfile";
import { readLockfile } from "../../integrations/lockfile";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";

// ── Response shapes ───────────────────────────────────────────────────────────

/** The single source descriptor a bundle config entry carries (spec §10.1). */
export interface BundleSourceView {
  /** Which descriptor the entry uses (exactly one, enforced by the schema). */
  kind: "path" | "git" | "website" | "npm";
  /** The descriptor's locator (a path, git URL, website URL, or npm spec). */
  locator: string;
  /** Website crawl bound, when the descriptor is a website with a maxPages. */
  maxPages?: number;
}

/** The resolved lock state surfaced for a bundle (spec §10.2), when present. */
export interface BundleLockView {
  source: LockfileEntry["source"];
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
  localRoot?: string;
  manifestDigest?: string;
  adapterIds?: string[];
  installedAt?: string;
}

/** One row in `akm bundle list`. */
export interface BundleSummary {
  id: string;
  default: boolean;
  source: BundleSourceView;
  writable: boolean;
  registryId?: string;
  lock: BundleLockView | null;
}

export interface BundleListResponse {
  schemaVersion: 1;
  defaultBundle: string | null;
  bundles: BundleSummary[];
  totalBundles: number;
  /** Present only when the workspace config has no `bundles` map yet. */
  note?: string;
}

/** One configured component of a bundle (spec §10.1, transitional single-entry). */
export interface BundleComponentView {
  name: string;
  root?: string;
  adapter?: string;
  writable?: boolean;
}

export interface BundleShowResponse {
  schemaVersion: 1;
  id: string;
  default: boolean;
  source: BundleSourceView;
  writable: boolean;
  registryId?: string;
  components: BundleComponentView[];
  lock: BundleLockView | null;
  itemCount: number;
}

/** One indexed item belonging to a bundle. */
export interface BundleItem {
  ref: string;
  conceptId: string;
  type: string;
  name: string;
}

export interface BundleItemsResponse {
  schemaVersion: 1;
  bundle: string;
  items: BundleItem[];
  totalItems: number;
  byType: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive the single source descriptor view from a validated bundle entry. */
function describeBundleSource(entry: BundleConfigEntry): BundleSourceView {
  if (typeof entry.path === "string" && entry.path.length > 0) {
    return { kind: "path", locator: entry.path };
  }
  if (typeof entry.git === "string" && entry.git.length > 0) {
    return { kind: "git", locator: entry.git };
  }
  if (entry.website && typeof entry.website.url === "string") {
    return {
      kind: "website",
      locator: entry.website.url,
      ...(typeof entry.website.maxPages === "number" ? { maxPages: entry.website.maxPages } : {}),
    };
  }
  if (typeof entry.npm === "string" && entry.npm.length > 0) {
    return { kind: "npm", locator: entry.npm };
  }
  // A validated config always carries exactly one descriptor; this fallback
  // only fires for a hand-corrupted entry that bypassed schema validation.
  return { kind: "path", locator: "" };
}

/** Project a lockfile entry onto the §10.2 view (drops the redundant `id`). */
function toLockView(entry: LockfileEntry | undefined): BundleLockView | null {
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

/** Component views for a bundle entry (transitional single-entry `components` map). */
function describeComponents(entry: BundleConfigEntry): BundleComponentView[] {
  const components = entry.components;
  if (!components) return [];
  return Object.entries(components).map(([name, component]) => ({
    name,
    ...(typeof component.root === "string" ? { root: component.root } : {}),
    ...(typeof component.adapter === "string" ? { adapter: component.adapter } : {}),
    ...(typeof component.writable === "boolean" ? { writable: component.writable } : {}),
  }));
}

/**
 * Enumerate the indexed items whose durable `bundle_id` provenance equals
 * `bundleId`. Returns `[]` when the index has not been built yet — a bundle
 * with no index rows is a valid (just-installed, not-yet-indexed) state, not an
 * error. Deterministically ordered (type, then conceptId) so the JSON is stable.
 */
export function readBundleItems(bundleId: string, dbPath?: string): BundleItem[] {
  const resolvedPath = dbPath ?? getDbPath();
  if (!fs.existsSync(resolvedPath)) return [];

  let db: Database | undefined;
  try {
    db = openExistingDatabase(resolvedPath);
    const items: BundleItem[] = [];
    for (const row of getAllEntries(db)) {
      if (row.bundleId !== bundleId) continue;
      const conceptId = row.conceptId ?? row.entry.name;
      items.push({
        ref: `${bundleId}//${conceptId}`,
        conceptId,
        type: row.entry.type,
        name: row.entry.name,
      });
    }
    items.sort((a, b) => a.type.localeCompare(b.type) || a.conceptId.localeCompare(b.conceptId));
    return items;
  } catch (err) {
    // Surface (don't swallow) so an operator can diagnose a corrupt/locked index
    // rather than silently seeing an empty bundle. Mirrors `akm info` behavior.
    process.stderr.write(`[akm bundle] failed to read index items from ${resolvedPath}: ${String(err)}\n`);
    return [];
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        /* ignore close error */
      }
    }
  }
}

/** Resolve one bundle config entry by id or throw a not-found naming the bundle. */
function requireBundle(config: AkmConfig, id: string): BundleConfigEntry {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new UsageError("A bundle id is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  const bundles = config.bundles;
  const entry = bundles?.[trimmed];
  if (!entry) {
    throw new NotFoundError(
      bundles
        ? `No bundle named "${trimmed}". Run \`akm bundle list\` to see configured bundles.`
        : `No bundles are configured. This workspace still uses the pre-0.9.0 source shape; run \`akm migrate apply\` to adopt bundles.`,
      "SOURCE_NOT_FOUND",
    );
  }
  return entry;
}

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * `akm bundle list` — the configured bundles (spec §10.1 desired config) joined
 * with their resolved lock state (spec §10.2), defaultBundle marked. Empty (with
 * a migration `note`) for a workspace that still uses the pre-0.9.0 source shape.
 */
export function akmBundleList(): BundleListResponse {
  const config = loadConfig();
  const bundles = config.bundles;
  const defaultBundle = config.defaultBundle ?? null;

  if (!bundles) {
    return {
      schemaVersion: 1,
      defaultBundle: null,
      bundles: [],
      totalBundles: 0,
      note: "No bundles configured. This workspace still uses the pre-0.9.0 source shape (`stashDir`/`sources`/`installed`); run `akm migrate apply` to adopt the bundle model.",
    };
  }

  const locks = readLockfile();
  const lockById = new Map(locks.map((entry) => [entry.id, entry]));

  const summaries: BundleSummary[] = Object.entries(bundles).map(([id, entry]) => ({
    id,
    default: id === defaultBundle,
    source: describeBundleSource(entry),
    writable: entry.writable === true,
    ...(typeof entry.registryId === "string" ? { registryId: entry.registryId } : {}),
    lock: toLockView(lockById.get(id)),
  }));

  return {
    schemaVersion: 1,
    defaultBundle,
    bundles: summaries,
    totalBundles: summaries.length,
  };
}

/**
 * `akm bundle show <id>` — one bundle's desired config (source descriptor,
 * writable, registryId, components), its resolved lock state, and its indexed
 * item count. Not-found (exit 1) for an unknown or unconfigured bundle.
 */
export function akmBundleShow(input: { id: string; dbPath?: string }): BundleShowResponse {
  const config = loadConfig();
  const entry = requireBundle(config, input.id);
  const id = input.id.trim();
  const lock = readLockfile().find((e) => e.id === id);

  return {
    schemaVersion: 1,
    id,
    default: id === config.defaultBundle,
    source: describeBundleSource(entry),
    writable: entry.writable === true,
    ...(typeof entry.registryId === "string" ? { registryId: entry.registryId } : {}),
    components: describeComponents(entry),
    lock: toLockView(lock),
    itemCount: readBundleItems(id, input.dbPath).length,
  };
}

/**
 * `akm bundle items <id>` — the indexed items belonging to a bundle, keyed by
 * their canonical `bundle//conceptId` ref, with a per-type count. Not-found
 * (exit 1) for an unknown or unconfigured bundle.
 */
export function akmBundleItems(input: { id: string; dbPath?: string }): BundleItemsResponse {
  const config = loadConfig();
  requireBundle(config, input.id);
  const id = input.id.trim();

  const items = readBundleItems(id, input.dbPath);
  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    bundle: id,
    items,
    totalItems: items.length,
    byType,
  };
}
