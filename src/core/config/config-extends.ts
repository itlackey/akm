// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBundleSlug } from "../asset/asset-ref";
import { isRecord, toErrorMessage } from "../common";
import { ConfigError } from "../errors";
import { getConfigPath } from "../paths";
import { warnOnce } from "../warn";
import { runConfigFilePipeline, warnUnknownConfigKeys } from "./config-file-forms";
import { readConfigText } from "./config-io";
import { bundleContentRoot } from "./config-sources";
import { deepMergeConfig, isPlainObject } from "./deep-merge";

// ── `extends` inheritance (#945) ────────────────────────────────────────────

/** One layer of an `extends` chain, from the local file (`ref: undefined`) outward to the chain's root. */
interface ConfigLayer {
  /** The `extends` value that led here; `undefined` for the local/topmost layer. */
  ref: string | undefined;
  /** This layer's raw config, already through {@link runConfigFilePipeline}. */
  raw: Record<string, unknown>;
}

/**
 * Walk an `extends` chain starting at `localRaw` (already through
 * {@link runConfigFilePipeline}), returning every layer from the local file
 * outward to the chain's root, local first. A chain is allowed (a base may
 * itself set `extends`); a cycle (a resolved source repeating) throws
 * {@link ConfigError} instead of recursing forever.
 */
export function collectExtendsLayers(localRaw: Record<string, unknown>, configPath: string | undefined): ConfigLayer[] {
  const layers: ConfigLayer[] = [{ ref: undefined, raw: localRaw }];
  const visited = new Set<string>(configPath ? [path.resolve(configPath)] : []);
  let current = localRaw;
  let currentPath = configPath;
  let containmentRoot: string | undefined;
  while (true) {
    const ref = current.extends;
    if (ref === undefined) return layers;
    if (typeof ref !== "string" || !ref.trim()) {
      throw new ConfigError(
        `Invalid "extends"${currentPath ? ` at ${currentPath}` : ""}: expected a non-empty string (a file path or bundle//path ref), got ${JSON.stringify(ref)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const resolved = resolveConfigRefSource(ref, current, currentPath, containmentRoot);
    const { text, resolvedPath } = resolved;
    if (visited.has(resolvedPath)) {
      throw new ConfigError(
        `Config "extends" cycle detected: "${ref}"${currentPath ? ` (from ${currentPath})` : ""} resolves back to an already-visited config at ${resolvedPath}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    visited.add(resolvedPath);
    const baseRaw = runConfigFilePipeline(text, resolvedPath);
    warnUnknownConfigKeys(baseRaw, resolvedPath);
    layers.push({ ref, raw: baseRaw });
    current = baseRaw;
    currentPath = resolvedPath;
    containmentRoot = resolved.containmentRoot;
  }
}

/**
 * Deep-merge an `extends` chain into its effective raw shape: each layer's
 * own fields win over its base's (`deepMergeConfig` "local wins" semantics),
 * reduced root-to-local so the local file's fields win overall. `DEFAULT_CONFIG`
 * is NOT applied here — the caller still layers it outermost, unchanged.
 *
 * The merged result's `extends` field, if any, is always the LOCAL file's own
 * literal value (never a base's) — `deepMergeConfig`'s local-wins semantics
 * already guarantee this at every level, since a layer only has `extends` set
 * when it itself declares one. Keeping it (rather than stripping it) lets
 * `akm config set`/`unset` round-trip the directive: `mutateConfig` reads the
 * effective config as `current` for the mutation, but writes back only the
 * fields `pruneUnchangedInheritedFields` finds changed-or-already-local (the
 * effective object is never written verbatim, which would duplicate every
 * inherited field into the local file). That pruning keys off
 * which fields are present in `current`/`next`, so `extends` has to still be
 * one of them or it would silently vanish from disk on the very next
 * `config set`.
 */
export function resolveExtendsChain(
  localRaw: Record<string, unknown>,
  configPath: string | undefined,
): Record<string, unknown> {
  const layers = collectExtendsLayers(localRaw, configPath);
  let merged: Record<string, unknown> = {};
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    const raw = i > 0 ? sanitizeInheritedConfig(layer.raw, layer.ref ?? String(i)) : layer.raw;
    const inherited = merged.projects;
    merged = deepMergeConfig(merged, raw);
    // A project is replaced whole by name: its fields are never merged across layers.
    if (isPlainObject(inherited) && isPlainObject(raw.projects)) merged.projects = { ...inherited, ...raw.projects };
  }
  return merged;
}

const HOST_LOCAL_CONFIG_KEYS = new Set([
  "bundles",
  "defaultBundle",
  "defaultWriteTarget",
  "embedding",
  "experimental",
  "registries",
  "scheduler",
  "setup",
]);

/**
 * Shared config contributes portable behavior only. Source ownership,
 * credentials, executable paths/arguments, and activation remain in the
 * host's top-level config even when a bundle supplies the inherited file.
 * LLM endpoints and model selection remain portable; their credentials never
 * do.
 */
export function sanitizeInheritedConfig(raw: Record<string, unknown>, label: string): Record<string, unknown> {
  const inherited = { ...raw };
  for (const key of HOST_LOCAL_CONFIG_KEYS) {
    if (!Object.hasOwn(inherited, key)) continue;
    delete inherited[key];
    warnOnce(
      `config:inherited-host-local:${label}:${key}`,
      `Ignoring inherited config key ${JSON.stringify(key)} from ${label}; it is host-local and must be declared in the top-level config file.`,
    );
  }

  let strippedAuthority = false;
  for (const section of ["connections", "harnesses"] as const) {
    const entries = inherited[section];
    if (!isPlainObject(entries)) continue;
    const portableEntries: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (!isPlainObject(entry)) {
        portableEntries[name] = entry;
        continue;
      }
      const portable = { ...entry };
      for (const key of ["apiKey", "bin", "args", "workspace"] as const) {
        if (!Object.hasOwn(portable, key)) continue;
        delete portable[key];
        strippedAuthority = true;
      }
      portableEntries[name] = portable;
    }
    inherited[section] = portableEntries;
  }
  if (strippedAuthority) {
    warnOnce(
      `config:inherited-host-local:${label}:connections-authority`,
      `Ignoring inherited connection credentials, harness executable arguments, or workspace from ${label}; those fields are host-local.`,
    );
  }

  if (isPlainObject(inherited.improve) && isPlainObject(inherited.improve.strategies)) {
    const strategies: Record<string, unknown> = {};
    let strippedSync = false;
    for (const [name, profile] of Object.entries(inherited.improve.strategies)) {
      if (isPlainObject(profile) && Object.hasOwn(profile, "sync")) {
        const { sync: _sync, ...portableProfile } = profile;
        strategies[name] = portableProfile;
        strippedSync = true;
      } else {
        strategies[name] = profile;
      }
    }
    inherited.improve = { ...inherited.improve, strategies };
    if (strippedSync) {
      warnOnce(
        `config:inherited-host-local:${label}:improve.sync`,
        `Ignoring inherited improve strategy sync policy from ${label}; publication policy is host-local.`,
      );
    }
  }
  return inherited;
}

/** True when `ref`'s segment before the first `//` is a legal bundle slug — the `bundle//<path>` shape, not a plain filesystem path. */
function looksLikeBundleAssetRef(ref: string): boolean {
  const boundary = ref.indexOf("//");
  return boundary > 0 && isBundleSlug(ref.slice(0, boundary));
}

/**
 * Resolve an `extends` value (or a `config diff <ref>` CLI argument — same
 * grammar) to its config text and the absolute path it was read from. Either
 * a filesystem path (relative to the directory of `fromConfigPath`; `~`
 * expands) or a `bundle//<path>` ref, where the part after `//` is a plain
 * file path *relative to that bundle's content root* — NOT an asset
 * conceptId. It needs no asset type (`scripts/`, `knowledge/`, …) and is
 * never indexed; a shared config file just lives wherever the bundle puts
 * it. No URL form and no fetch/sync — the source must already exist locally;
 * a missing file/bundle throws {@link ConfigError} naming the ref, as does an
 * empty, absolute, or content-root-escaping path after `//`. `akm config diff` (config-cli.ts) shares the grammar.
 */
export function resolveConfigRefSource(
  ref: string,
  context: Record<string, unknown>,
  fromConfigPath: string | undefined,
  containmentRoot?: string,
): { text: string; resolvedPath: string; containmentRoot?: string } {
  return looksLikeBundleAssetRef(ref)
    ? resolveConfigBundleRefSource(ref, context, containmentRoot)
    : resolveConfigFileRefSource(ref, fromConfigPath, containmentRoot);
}

function resolveConfigFileRefSource(
  ref: string,
  fromConfigPath: string | undefined,
  containmentRoot?: string,
): { text: string; resolvedPath: string; containmentRoot?: string } {
  // `~` expands to the home directory.
  const expanded = ref.startsWith("~") ? path.join(os.homedir(), ref.slice(1)) : ref;
  let resolvedPath: string;
  if (path.isAbsolute(expanded)) {
    resolvedPath = expanded;
  } else if (fromConfigPath) {
    resolvedPath = path.resolve(path.dirname(fromConfigPath), expanded);
  } else {
    throw new ConfigError(
      `extends "${ref}" is a relative path, but the current config has no known file location to resolve it against.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (containmentRoot !== undefined) assertConfigExtendsPhysicalContainment(containmentRoot, resolvedPath, ref);
  const text = readConfigText(resolvedPath);
  if (text === undefined) {
    throw new ConfigError(
      `extends "${ref}" resolves to ${resolvedPath}, which does not exist. Create the file first, or point "extends" at an existing config.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { text, resolvedPath, ...(containmentRoot ? { containmentRoot } : {}) };
}

function resolveConfigBundleRefSource(
  ref: string,
  context: Record<string, unknown>,
  outerContainmentRoot?: string,
): { text: string; resolvedPath: string; containmentRoot: string } {
  // Split by hand rather than through `parseBundleRef`: the part after `//`
  // is a plain file path here, not an asset conceptId, so it must not be run
  // through conceptId validation (which, for instance, rejects every `..`
  // segment outright — stricter than the "must not escape the content root"
  // rule this function enforces itself below via `path.resolve`).
  // `looksLikeBundleAssetRef` already confirmed `ref` has this `bundle//`
  // shape with a legal bundle slug before routing here.
  const boundary = ref.indexOf("//");
  const bundleId = ref.slice(0, boundary);
  const relativePath = ref.slice(boundary + 2);
  if (!relativePath) {
    throw new ConfigError(`extends "${ref}" is missing a path after "${bundleId}//".`, "INVALID_CONFIG_FILE");
  }
  if (path.isAbsolute(relativePath)) {
    throw new ConfigError(
      `extends "${ref}" must be a path relative to bundle "${bundleId}"'s content root, not absolute.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const bundles = isRecord(context.bundles) ? context.bundles : undefined;
  const bundleEntry = bundles?.[bundleId];
  const bundlePath =
    isRecord(bundleEntry) && typeof bundleEntry.path === "string" && bundleEntry.path.length > 0
      ? bundleEntry.path
      : undefined;
  if (!bundlePath || !isRecord(bundleEntry)) {
    throw new ConfigError(
      `extends "${ref}" names bundle "${bundleId}", which is not a configured filesystem bundle (bundles.${bundleId}.path). Only a filesystem bundle can host an "extends" source.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const root = typeof bundleEntry.root === "string" ? bundleEntry.root : undefined;
  const bundleRoot = bundleContentRoot(bundlePath, root);

  const resolvedPath = path.resolve(bundleRoot, relativePath);
  const relativeToRoot = path.relative(bundleRoot, resolvedPath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new ConfigError(`extends "${ref}" escapes bundle "${bundleId}"'s content root.`, "INVALID_CONFIG_FILE");
  }

  const containmentRoot = fs.realpathSync.native(bundleRoot);
  assertConfigExtendsPhysicalContainment(containmentRoot, resolvedPath, ref);
  if (outerContainmentRoot !== undefined) {
    assertConfigExtendsPhysicalContainment(outerContainmentRoot, resolvedPath, ref);
  }
  const text = readConfigText(resolvedPath);
  if (text === undefined) {
    throw new ConfigError(
      `extends "${ref}" resolves to ${resolvedPath}, which does not exist locally. Sync the bundle first, or point "extends" at an existing file.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return { text, resolvedPath, containmentRoot: outerContainmentRoot ?? containmentRoot };
}

function assertConfigExtendsPhysicalContainment(root: string, candidate: string, ref: string): void {
  let physicalRoot: string;
  let physicalCandidate: string;
  try {
    physicalRoot = fs.realpathSync.native(root);
    physicalCandidate = fs.realpathSync.native(candidate);
  } catch (cause) {
    throw new ConfigError(
      `Unable to verify physical containment for extends ${JSON.stringify(ref)}: ${toErrorMessage(cause)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const relative = path.relative(physicalRoot, physicalCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError(
      `extends ${JSON.stringify(ref)} resolves through a symbolic link outside its bundle content root.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

/**
 * `akm config get --show-source` (#945): which raw layer the dotted path's
 * value comes from — `"local"` when the local file's own raw JSON sets it,
 * `"extends:<ref>"` for the nearest chain member that sets it (the ref by
 * which that member is reached), or `"default"` when no layer sets it
 * (`DEFAULT_CONFIG` or schema default supplies it). Computed lazily by
 * re-walking the raw layers on each call — no merge-time bookkeeping.
 */
export function getConfigValueSource(dotted: string): string {
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  if (text === undefined) return "default";
  const liftedConfig = runConfigFilePipeline(text, configPath);
  const segments = dotted.split(".").filter((s) => s.length > 0);
  for (const layer of collectExtendsLayers(liftedConfig, configPath)) {
    const effectiveLayer = layer.ref === undefined ? layer.raw : sanitizeInheritedConfig(layer.raw, layer.ref);
    if (hasRawPath(effectiveLayer, segments)) {
      return layer.ref === undefined ? "local" : `extends:${layer.ref}`;
    }
  }
  return "default";
}

export function hasRawPath(raw: unknown, segments: string[]): boolean {
  let cursor: unknown = raw;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}
