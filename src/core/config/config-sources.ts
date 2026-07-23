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
/**
 * The resolved primary stash path — the `defaultBundle`'s filesystem `path`
 * (spec §10.1) — or `undefined` when no filesystem primary is configured.
 */
export function primaryBundlePath(config: AkmConfig): string | undefined {
  const bundles = config.bundles;
  const key = config.defaultBundle;
  if (!bundles || !key) return undefined;
  const entry = bundles[key];
  return entry && typeof entry.path === "string" && entry.path.length > 0 ? entry.path : undefined;
}

export function bundlesToSourceEntries(config: AkmConfig): SourceConfigEntry[] | undefined {
  const bundles = config.bundles;
  if (!bundles) return undefined;
  const keys = Object.keys(bundles);
  const defaultKey = config.defaultBundle && config.defaultBundle in bundles ? config.defaultBundle : undefined;
  const ordered = defaultKey ? [defaultKey, ...keys.filter((k) => k !== defaultKey)] : keys;
  const entries: SourceConfigEntry[] = [];
  for (const key of ordered) {
    const entry = bundleEntryToSourceEntry(key, bundles[key]!, key === defaultKey);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Map one `bundles.<key>` entry to a runtime {@link SourceConfigEntry}. */
export function bundleEntryToSourceEntry(
  key: string,
  bundle: BundleConfigEntry,
  isPrimary = false,
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
    return { type: "git", url: normalizeInstalledGitRef("", bundle.git), ...base };
  }
  if (bundle.website && typeof bundle.website.url === "string") {
    // All non-`url` website-descriptor keys (maxPages/refresh/maxDepth + any
    // passthrough provider options) round-trip back to the runtime entry's
    // `options` bag, mirroring the pre-cutover `sources[].options` shape.
    const { url, ...rest } = bundle.website;
    return {
      type: "website",
      url,
      ...(Object.keys(rest).length > 0 ? { options: rest } : {}),
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
 * Desired 0.9.0 bundle descriptor for a registry-installed source (spec §10.1).
 * Maps the install source kind onto the ONE source descriptor a bundle entry
 * carries: git/github → a provider-ready clone URL, npm → `{ npm: ref }`,
 * everything else (local/filesystem) → `{ path: stashRoot }`.
 *
 * CRITICAL (spec §10.2:453): the materialized cache root NEVER appears in the
 * descriptor for a git/npm bundle — the desired config carries only the source
 * descriptor; the install locator stays in `registryId` and the resolved root
 * belongs exclusively in the lock's `localRoot`. Callers layer
 * `registryId`/`writable` onto the result.
 */
export function installedSourceDescriptor(
  source: string,
  ref: string | undefined,
  stashRoot: string,
): BundleConfigEntry {
  switch (source) {
    case "git":
    case "github":
      if (ref) return { git: normalizeInstalledGitRef(source, ref) };
      break;
    case "npm":
      if (ref) return { npm: ref };
      break;
    default:
      break;
  }
  // local/filesystem installs reference a real on-disk path (no package-manager
  // cache to re-materialize), so the resolved root IS the desired path.
  return { path: stashRoot };
}

function normalizeInstalledGitRef(source: string, ref: string): string {
  if (ref.startsWith("git+")) return ref.slice(4);
  const isGithubShorthand = ref.startsWith("github:") || (source === "github" && /^[^/:#]+\/[^/#]+(?:#.+)?$/.test(ref));
  if (!isGithubShorthand) return ref;

  const body = ref.startsWith("github:") ? ref.slice("github:".length) : ref;
  const fragmentAt = body.indexOf("#");
  const repository = fragmentAt >= 0 ? body.slice(0, fragmentAt) : body;
  const requestedRef = fragmentAt >= 0 ? body.slice(fragmentAt + 1) : "";
  const cloneUrl = `https://github.com/${repository.replace(/\.git$/i, "")}`;
  return requestedRef ? `${cloneUrl}/tree/${requestedRef}` : cloneUrl;
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
 * Build the full ordered list of runtime {@link ConfiguredSource} values from a
 * loaded {@link AkmConfig}, resolved from `bundles` + `defaultBundle` (spec
 * §10.1): the `defaultBundle` (primary) first, then map insertion order. The
 * retired `stashDir`/`sources[]`/`installed[]` trio is no longer read here — a
 * pre-cutover config is normalized to bundles by the migrator before it loads.
 *
 * Entries with `enabled: false` are still emitted — callers decide whether to
 * honour the flag. Entries that fail {@link parseSourceSpec} drop silently.
 * Returns `[]` when no bundles are configured.
 */
export function resolveConfiguredSources(config: AkmConfig): ConfiguredSource[] {
  const bundleEntries = bundlesToSourceEntries(config);
  if (!bundleEntries) return [];
  const out: ConfiguredSource[] = [];
  for (const persisted of bundleEntries) {
    const runtime = toConfiguredSource(persisted, persisted.primary === true);
    if (runtime) out.push(runtime);
  }
  return out;
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
