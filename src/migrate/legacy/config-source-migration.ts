// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn next-minor — Chunk-8 config-shape migration (WI-8.4).
 *
 * Translates the pre-cutover source configuration
 * (`stashDir` / `sources[]` / `installed[]`) into the 0.9.0 `bundles` +
 * `defaultBundle` shape (spec §10.1). Runs as a pure pre-validation transform in
 * the migrator's config-applied phase (`cli/config-migrate.ts`): the old keys
 * are removed and the emitted `bundles` map is keyed by exactly what
 * `deriveInstallations` derives for each source at runtime (D-R5 no-identity
 * shift), because BOTH sides call the ONE shared {@link deriveBundleId} helper.
 *
 * `defaultBundle` is the primary stash's derived id — the source marked
 * `primary: true`, else the synthetic entry built from top-level `stashDir`.
 *
 * Ordering mirrors the transitional runtime resolvers (primary first, then
 * `sources[]` in declared order, then `installed[]`) so the emitted map's
 * insertion order reproduces the runtime installation-priority order after the
 * migration.
 *
 * NOTE (Tier A scope): an `installed[]` entry is emitted as a filesystem bundle
 * pointing at its already-materialized `stashRoot` (the runtime read path is
 * preserved verbatim — resolveSourceEntries walked exactly that root before).
 * Its original registry id is preserved in the entry's `registryId` locator so
 * nothing is lost. Splitting the desired source descriptor (git/npm + ref) from
 * the resolved cache root into the lock (§10.2) is a follow-up — see the WI-8.5
 * handoff.
 */

import os from "node:os";
import path from "node:path";
import type { BundleConfigEntry } from "../../core/config/config-types";
import { deriveBundleId } from "../../indexer/installations";
import type { SearchSource } from "../../indexer/search/search-source";

/** The pre-cutover source keys this transform consumes and removes. */
const OLD_SOURCE_KEYS = ["stashDir", "sources", "installed"] as const;

/** True when a raw config object carries any pre-cutover source key. */
export function hasOldSourceShape(raw: Record<string, unknown>): boolean {
  return OLD_SOURCE_KEYS.some((k) => k in raw && raw[k] !== undefined);
}

/** Expand a leading `~` against the home directory (config paths may use it). */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * One pre-cutover source in migration-ready form: the derivation inputs
 * (`path` + `registryId` for {@link deriveBundleId}), the runtime `writable`
 * flag, whether it is the primary stash, and the 0.9.0 source descriptor to
 * emit.
 */
interface MigratableSource {
  /** Filesystem-ish locator used by `slugForPath` when the id must be derived. */
  derivationPath: string;
  /** Original registry id (source name / installed id), or `undefined`. */
  registryId?: string;
  writable?: boolean;
  primary?: boolean;
  descriptor: BundleConfigEntry;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Build the 0.9.0 source descriptor for one pre-cutover `sources[]` entry. */
function sourceEntryDescriptor(entry: Record<string, unknown>): BundleConfigEntry | undefined {
  const type = readString(entry.type) ?? "filesystem";
  const entryPath = readString(entry.path);
  const url = readString(entry.url);
  const options = (entry.options as Record<string, unknown> | undefined) ?? undefined;
  const maxPages = typeof options?.maxPages === "number" ? (options.maxPages as number) : undefined;
  switch (type) {
    case "filesystem":
      return entryPath ? { path: entryPath } : undefined;
    case "git":
      return url ? { git: url } : undefined;
    case "website":
      return url ? { website: { url, ...(maxPages !== undefined ? { maxPages } : {}) } } : undefined;
    case "npm":
      // Today's npm source carries the package spec in `path` (parseSourceSpec).
      return entryPath ? { npm: entryPath } : undefined;
    default:
      return entryPath ? { path: entryPath } : undefined;
  }
}

/**
 * Extract the ordered pre-cutover source list from a raw config object, mirroring
 * the runtime resolution order: primary first, then `sources[]`, then
 * `installed[]`.
 */
export function oldConfigMigratableSources(raw: Record<string, unknown>): MigratableSource[] {
  const out: MigratableSource[] = [];
  const sources = Array.isArray(raw.sources) ? (raw.sources as Array<Record<string, unknown>>) : [];
  const installed = Array.isArray(raw.installed) ? (raw.installed as Array<Record<string, unknown>>) : [];
  const stashDir = readString(raw.stashDir);

  // Primary: an explicit `primary: true` source wins; otherwise the top-level
  // `stashDir` (a synthetic writable filesystem primary).
  const primaryEntry = sources.find((entry) => entry.primary === true);
  if (primaryEntry) {
    const descriptor = sourceEntryDescriptor(primaryEntry);
    const p = readString(primaryEntry.path);
    if (descriptor) {
      out.push({
        derivationPath: p ? path.resolve(expandTilde(p)) : (readString(primaryEntry.url) ?? ""),
        registryId: readString(primaryEntry.name),
        writable: primaryEntry.writable === true,
        primary: true,
        descriptor,
      });
    }
  } else if (stashDir) {
    out.push({
      derivationPath: path.resolve(expandTilde(stashDir)),
      writable: true,
      primary: true,
      descriptor: { path: stashDir },
    });
  }

  for (const entry of sources) {
    if (entry === primaryEntry) continue;
    const descriptor = sourceEntryDescriptor(entry);
    if (!descriptor) continue;
    const p = readString(entry.path);
    out.push({
      derivationPath: p ? path.resolve(expandTilde(p)) : (readString(entry.url) ?? ""),
      registryId: readString(entry.name),
      writable: entry.writable === true,
      descriptor,
    });
  }

  for (const entry of installed) {
    const stashRoot = readString(entry.stashRoot);
    if (!stashRoot) continue;
    // Emit the materialized root as a filesystem bundle so the runtime read path
    // is preserved (see the module NOTE). Preserve the install id as the locator.
    out.push({
      derivationPath: path.resolve(expandTilde(stashRoot)),
      registryId: readString(entry.id),
      writable: entry.writable === true,
      descriptor: { path: stashRoot },
    });
  }

  return out;
}

/**
 * The SearchSource[] view of the pre-cutover config — the exact input a "direct
 * `deriveInstallations` run over the old source list" consumes for the D-R5
 * no-identity-shift proof.
 */
export function oldConfigToSearchSources(raw: Record<string, unknown>): SearchSource[] {
  return oldConfigMigratableSources(raw).map((src) => ({
    path: src.derivationPath,
    ...(src.registryId ? { registryId: src.registryId } : {}),
    ...(src.writable ? { writable: true } : {}),
  }));
}

/**
 * Translate the pre-cutover source shape into `bundles` + `defaultBundle`,
 * removing `stashDir`/`sources`/`installed`. Idempotent: a config with no old
 * source keys (already migrated, or none configured) is returned unchanged, so
 * the transform is safe to run over any migration target.
 */
export function migrateConfigSourcesToBundles(raw: Record<string, unknown>): Record<string, unknown> {
  // Already migrated (or half-migrated — the schema rejects that): leave as-is.
  if ("bundles" in raw) return raw;
  if (!hasOldSourceShape(raw)) return raw;

  const migratable = oldConfigMigratableSources(raw);
  const usedIds = new Set<string>();
  const bundles: Record<string, BundleConfigEntry> = {};
  let defaultBundle: string | undefined;

  for (const src of migratable) {
    // The ONE shared derivation, so the emitted key equals the runtime
    // installation id by construction (D-R5).
    const id = deriveBundleId(src.registryId, src.derivationPath, usedIds);
    const entry: BundleConfigEntry = { ...src.descriptor };
    if (src.writable) entry.writable = true;
    // Preserve the original registry id when the slug-legal key differs from it
    // (a non-slug-legal id like `github:owner/repo`), so the locator is not lost.
    if (src.registryId && src.registryId !== id) entry.registryId = src.registryId;
    bundles[id] = entry;
    if (src.primary) defaultBundle = id;
  }

  const out: Record<string, unknown> = { ...raw };
  for (const key of OLD_SOURCE_KEYS) delete out[key];
  out.bundles = bundles;
  if (defaultBundle !== undefined) out.defaultBundle = defaultBundle;
  return out;
}
