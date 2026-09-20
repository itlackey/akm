// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runtime helpers that derive provider-ready and {@link ConfiguredSource}
 * values from the current bundle map in an {@link AkmConfig}.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors";
import type { AkmConfig, BundleConfigEntry, ConfiguredSource, SourceConfigEntry, SourceSpec } from "./config-types";

/** The current one-component-per-bundle configuration entry, if present. */
export function bundleComponentConfig(
  bundle: BundleConfigEntry | undefined,
): { root?: string; adapter?: string; writable?: boolean } | undefined {
  if (!bundle?.components) return undefined;
  const components = Object.values(bundle.components);
  if (components.length !== 1) {
    throw new ConfigError("A bundle components map must contain exactly one component.", "INVALID_CONFIG_FILE");
  }
  return components[0];
}

/**
 * Convert the current `bundles` map into its ordered provider projection:
 * `defaultBundle` first, then map insertion order. Each entry's `name` is its
 * bundle key. Returns `undefined` when no bundles map is configured.
 */
/**
 * A bundle's true identity: its configured `path` plus its component's
 * `root` (default `"."`), fully resolved. Two bundle entries whose bare
 * `path` differs (relative vs. absolute, trailing slash, `~` vs. expanded)
 * can still resolve to this same directory — this is the identity akm
 * compares before registering or reconciling a bundle (issue #870).
 */
export function bundleContentRoot(entryPath: string, componentRoot?: string): string {
  return path.resolve(entryPath, componentRoot ?? ".");
}

/**
 * Physical identity for an already materialized filesystem bundle.
 *
 * Configuration may spell the same directory through relative paths or
 * symbolic links. Those spellings are not distinct sources: treating them as
 * distinct would make ownership, default-source trust, and scheduler grants
 * depend on syntax instead of the directory the OS will actually read.
 */
export function bundlePhysicalContentRoot(entryPath: string, componentRoot?: string): string {
  const resolved = bundleContentRoot(entryPath, componentRoot);
  try {
    return fs.realpathSync.native(resolved);
  } catch (cause) {
    // Cache-backed sources can be configured before they are materialized.
    // Their source descriptor remains the identity until a real path exists.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw new ConfigError(
      `Unable to resolve physical bundle root ${JSON.stringify(resolved)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "INVALID_CONFIG_FILE",
    );
  }
}

/** Whether a configured bundle participates in reads, writes, and execution. */
export function isBundleEnabled(config: AkmConfig, bundleId: string): boolean {
  const bundle = config.bundles?.[bundleId];
  return bundle !== undefined && bundle.enabled !== false;
}

/**
 * Stable identity of the origin currently installed under a bundle id.
 *
 * This deliberately excludes mutable policy (`enabled`, `writable`,
 * credentials, adapter selection) and bundle contents. Ordinary updates and
 * adapter auto-detection for the same origin keep their grant; changing the
 * locator or component root does not.
 */
export function bundleSourceId(config: AkmConfig, bundleId: string): string {
  const bundle = config.bundles?.[bundleId];
  if (!bundle) {
    throw new ConfigError(`Bundle ${JSON.stringify(bundleId)} is not configured.`, "INVALID_CONFIG_FILE");
  }
  const component = bundleComponentConfig(bundle);
  let source: Readonly<Record<string, unknown>>;
  if (bundle.path !== undefined) {
    source = { kind: "filesystem", locator: bundlePhysicalContentRoot(bundle.path, component?.root) };
  } else if (bundle.git !== undefined) {
    source = { kind: "git", locator: normalizeInstalledGitRef("git", bundle.git) };
  } else if (bundle.website !== undefined) {
    // Crawl/refresh settings are mutable fetch policy, not source identity.
    // Changing them must not silently revoke a user's scheduling decision for
    // the same website origin.
    source = { kind: "website", url: bundle.website.url };
  } else if (bundle.npm !== undefined) {
    source = { kind: "npm", locator: bundle.npm };
  } else {
    throw new ConfigError(`Bundle ${JSON.stringify(bundleId)} has no source descriptor.`, "INVALID_CONFIG_FILE");
  }
  return hashBundleSourceIdentity({
    version: 1,
    source,
    registryId: bundle.registryId ?? null,
    componentRoot: component?.root ?? ".",
  });
}

/** Identity for an environment-only filesystem bundle not persisted in config. */
export function filesystemBundleSourceId(contentRoot: string): string {
  return hashBundleSourceIdentity({
    version: 1,
    source: { kind: "filesystem", locator: bundlePhysicalContentRoot(contentRoot) },
    registryId: null,
    componentRoot: ".",
  });
}

function hashBundleSourceIdentity(identity: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256")
    .update("akm.bundle-source\0v1\0")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
}

/**
 * The resolved primary stash path — the `defaultBundle`'s filesystem `path`
 * (spec §10.1) — or `undefined` when no filesystem primary is configured.
 */
export function primaryBundlePath(config: AkmConfig): string | undefined {
  const bundles = config.bundles;
  const key = config.defaultBundle;
  if (!bundles || !key) return undefined;
  const entry = bundles[key];
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return undefined;
  const componentRoot = bundleComponentConfig(entry)?.root;
  const bundleRoot = path.resolve(entry.path);
  if (!componentRoot || componentRoot === ".") return bundleRoot;
  const resolved = path.resolve(bundleRoot, componentRoot);
  const relative = path.relative(bundleRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError(`Component root "${componentRoot}" escapes bundle "${key}".`, "INVALID_CONFIG_FILE");
  }
  return resolved;
}

/**
 * Every configured filesystem bundle's id paired with its resolved content
 * root. Used to detect two bundle ids that resolve to the same directory
 * (issue #870) and to find the id that already owns a given root before a
 * new one is registered.
 */
export function bundleContentRoots(config: AkmConfig): { id: string; contentRoot: string }[] {
  const bundles = config.bundles ?? {};
  const out: { id: string; contentRoot: string }[] = [];
  for (const [id, entry] of Object.entries(bundles)) {
    if (typeof entry.path !== "string" || entry.path.length === 0) continue;
    out.push({ id, contentRoot: bundlePhysicalContentRoot(entry.path, bundleComponentConfig(entry)?.root) });
  }
  return out;
}

/** The bundle id whose resolved content root already matches `resolvedContentRoot`, if any. */
export function bundleKeyForContentRoot(config: AkmConfig, resolvedContentRoot: string): string | undefined {
  let physical = path.resolve(resolvedContentRoot);
  try {
    physical = fs.realpathSync.native(physical);
  } catch {
    // Compare the unresolved absolute locator when the candidate is not yet materialized.
  }
  return bundleContentRoots(config).find((entry) => entry.contentRoot === physical)?.id;
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
    ...(bundle.credential !== undefined ? { credential: bundle.credential } : {}),
    ...(bundle.enabled !== undefined ? { enabled: bundle.enabled } : {}),
    ...(isPrimary ? { primary: true } : {}),
  };
  if (typeof bundle.path === "string" && bundle.path.length > 0) {
    return { type: "filesystem", path: bundle.path, ...base };
  }
  if (typeof bundle.git === "string" && bundle.git.length > 0) {
    return { type: "git", url: normalizeInstalledGitRef("", bundle.git), ...base };
  }
  if (bundle.website && typeof bundle.website.url === "string") {
    // All non-`url` website-descriptor keys become provider options.
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
 * Produce a stable internal identifier for a provider projection. Current
 * bundle-derived entries always carry `name`; the hash protects manually
 * constructed internal values.
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
 * Convert a provider-ready {@link SourceConfigEntry} into the runtime
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
      return undefined;
  }
}

/**
 * Build the full ordered list of runtime {@link ConfiguredSource} values from a
 * loaded {@link AkmConfig}, resolved from `bundles` + `defaultBundle` (spec
 * §10.1): the `defaultBundle` (primary) first, then map insertion order. The
 * retired `stashDir`/`sources[]`/`installed[]` trio is never read or normalized.
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
    if (runtime) {
      const component = bundleComponentConfig(config.bundles?.[persisted.name ?? ""]);
      out.push({
        ...runtime,
        ...(component?.adapter ? { adapterId: component.adapter } : {}),
        ...(component?.root ? { componentRoot: component.root } : {}),
        ...(component?.writable !== undefined ? { writable: component.writable } : {}),
      });
    }
  }
  return out;
}

/** Active sources in the same deterministic order as `resolveConfiguredSources`. */
export function resolveActiveConfiguredSources(config: AkmConfig): ConfiguredSource[] {
  return resolveConfiguredSources(config).filter((source) => source.enabled !== false);
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
