// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runtime helpers that derive {@link ConfiguredSource} values from the
 * persisted {@link SourceConfigEntry} / {@link InstalledBundle} shapes
 * in an {@link AkmConfig}.
 */
import { createHash } from "node:crypto";
import type { AkmConfig, BundleConfigEntry, ConfiguredSource, SourceConfigEntry, SourceSpec } from "./config-types";

/**
 * Convert a `bundles` map (0.9.0 config-shape cutover, spec §10.1 / D-R5) into
 * the ordered {@link SourceConfigEntry} list the transitional runtime source
 * resolvers already consume — `defaultBundle` first (primary), then map
 * insertion order (preserving today's installation-priority semantics, on which
 * D-R4 short-ref resolution depends). Each entry's `name` IS its bundle key, so
 * `deriveInstallations` re-derives the exact same installation id (D-R5 rule 1).
 *
 * Returns `undefined` for an old-shape config (no `bundles`), so callers fall
 * back to the pre-cutover `stashDir`/`sources[]`/`installed[]` resolution.
 */
export function bundlesToSourceEntries(config: AkmConfig): SourceConfigEntry[] | undefined {
  const bundles = config.bundles;
  if (!bundles) return undefined;
  const keys = Object.keys(bundles);
  const defaultKey = config.defaultBundle && config.defaultBundle in bundles ? config.defaultBundle : undefined;
  const ordered = defaultKey ? [defaultKey, ...keys.filter((k) => k !== defaultKey)] : keys;
  const entries: SourceConfigEntry[] = [];
  for (const key of ordered) {
    const entry = bundleEntryToSourceEntry(key, bundles[key], key === defaultKey);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Map one `bundles.<key>` entry to a runtime {@link SourceConfigEntry}. */
function bundleEntryToSourceEntry(
  key: string,
  bundle: BundleConfigEntry,
  isPrimary: boolean,
): SourceConfigEntry | undefined {
  const base = {
    name: key,
    ...(bundle.writable !== undefined ? { writable: bundle.writable } : {}),
    ...(isPrimary ? { primary: true } : {}),
  };
  if (typeof bundle.path === "string" && bundle.path.length > 0) {
    return { type: "filesystem", path: bundle.path, ...base };
  }
  if (typeof bundle.git === "string" && bundle.git.length > 0) {
    return { type: "git", url: bundle.git, ...base };
  }
  if (bundle.website && typeof bundle.website.url === "string") {
    const maxPages = bundle.website.maxPages;
    return {
      type: "website",
      url: bundle.website.url,
      ...(typeof maxPages === "number" ? { options: { maxPages } } : {}),
      ...base,
    };
  }
  if (typeof bundle.npm === "string" && bundle.npm.length > 0) {
    // Today's npm source carries the package spec in `path` (see parseSourceSpec).
    return { type: "npm", path: bundle.npm, ...base };
  }
  return undefined;
}

/**
 * Synthesize a stable identifier when a {@link SourceConfigEntry} omits its
 * `name`. Uses a short hash of the discriminating fields so two equivalent
 * entries collapse to the same generated name.
 */
function deriveBundleName(entry: SourceConfigEntry): string {
  if (entry.name) return entry.name;
  const seed = JSON.stringify({
    type: entry.type,
    path: entry.path ?? null,
    url: entry.url ?? null,
  });
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${entry.type}-${hash}`;
}

/**
 * Convert a persisted {@link SourceConfigEntry} into the runtime
 * {@link SourceSpec} discriminated union. Returns `undefined` when the entry
 * is missing the fields its provider type requires (e.g. a `filesystem`
 * entry with no `path`); callers should drop or warn for those.
 */
export function parseSourceSpec(entry: SourceConfigEntry): SourceSpec | undefined {
  switch (entry.type) {
    case "filesystem":
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
    case "git":
      return entry.url ? { type: "git", url: entry.url } : undefined;
    case "website":
      return entry.url
        ? {
            type: "website",
            url: entry.url,
            ...(typeof entry.options?.maxPages === "number" ? { maxPages: entry.options.maxPages as number } : {}),
          }
        : undefined;
    case "npm":
      return entry.path ? { type: "npm", package: entry.path } : undefined;
    default:
      // Unknown provider — best-effort fallback so callers still get something.
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
  }
}

/**
 * Build the full ordered list of runtime {@link ConfiguredSource} values from
 * a loaded {@link AkmConfig}:
 *   1. The entry marked `primary: true` (or a synthetic entry from `stashDir`).
 *   2. Remaining `sources[]` entries in declared order.
 *   3. Legacy `installed[]` entries, mapped into runtime entries.
 *
 * Entries with `enabled: false` are still emitted — callers decide whether to
 * honour the flag. Entries that fail {@link parseSourceSpec} drop silently.
 */
export function resolveConfiguredSources(config: AkmConfig): ConfiguredSource[] {
  // NEW shape (spec §10.1): resolve from `bundles` + `defaultBundle`. The
  // bundle list is already ordered defaultBundle-first, so mapping it in order
  // preserves the primary-then-priority semantics the old shape produced below.
  const bundleEntries = bundlesToSourceEntries(config);
  if (bundleEntries) {
    const out: ConfiguredSource[] = [];
    for (const persisted of bundleEntries) {
      const runtime = toConfiguredSource(persisted, persisted.primary === true);
      if (runtime) out.push(runtime);
    }
    return out;
  }

  const entries: ConfiguredSource[] = [];
  const sources = config.sources ?? [];

  let primary = sources.find((entry) => entry.primary === true);
  if (!primary && config.stashDir) {
    primary = { type: "filesystem", path: config.stashDir, primary: true };
  }
  if (primary) {
    const runtime = toConfiguredSource(primary, true);
    if (runtime) entries.push(runtime);
  }

  for (const entry of sources) {
    if (entry === primary) continue;
    const runtime = toConfiguredSource(entry, false);
    if (runtime) entries.push(runtime);
  }

  for (const installed of config.installed ?? []) {
    entries.push({
      name: installed.id,
      type: "filesystem",
      source: { type: "filesystem", path: installed.stashRoot },
      enabled: true,
      writable: installed.writable,
    });
  }

  return entries;
}

function toConfiguredSource(persisted: SourceConfigEntry, isPrimary: boolean): ConfiguredSource | undefined {
  const source = parseSourceSpec(persisted);
  if (!source) return undefined;
  return {
    name: deriveBundleName(persisted),
    type: persisted.type,
    source,
    ...(persisted.enabled !== undefined ? { enabled: persisted.enabled } : {}),
    ...(persisted.writable !== undefined ? { writable: persisted.writable } : {}),
    ...(isPrimary || persisted.primary ? { primary: true } : {}),
    ...(persisted.options ? { options: persisted.options } : {}),
  };
}
