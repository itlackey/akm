// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isBundleSlug } from "../asset/asset-ref";
import { deriveBundleId } from "../bundle-id";
import { isRecord, resolveStashDir } from "../common";
import { ConfigError } from "../errors";
import { substituteRefTokens } from "../ref-token";
import { formatRegistryLabel, hasRegistryUrlCredentials } from "../registry-url";
import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  withConfigLock,
  writeConfigAtomic,
} from "./config-io";
import { AkmConfigSchema, CURRENT_CONFIG_VERSION } from "./config-schema";
import {
  bundleComponentConfig,
  bundleContentRoot,
  bundleContentRoots,
  bundleSourceId,
  bundlesToSourceEntries,
  filesystemBundleSourceId,
  isBundleEnabled,
} from "./config-sources";
import type {
  AkmConfig,
  BundleConfigEntry,
  ConnectionConfig,
  HarnessConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
} from "./config-types";
import { isOpaqueSchema, resolveSchemaAt } from "./config-walker";
import { deepMergeConfig, isPlainObject } from "./deep-merge";
import { ImproveConfigSchema } from "./schema/improve";
import { dropUnusableProjects } from "./schema/projects";
import { RegistryConfigEntrySchema } from "./schema/sources-bundles";
import { dropUnusableEntries, findUnusableEntries, resolveBundlePaths, type UnusableEntry } from "./unusable-entries";

export { stripJsonComments } from "./config-io";

import { getConfigPath } from "../paths";
import { warn, warnOnce } from "../warn";

// Re-export type surface from config-types.ts so call sites don't need to
// move (the runtime values live here; the types are documentation-only).
export type {
  AkmConfig,
  BundleConfigEntry,
  ConfiguredSource,
  ConnectionConfig,
  EmbeddingConnectionConfig,
  HarnessConfig,
  HarnessId,
  ImproveConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  ImproveWhere,
  OutputConfig,
  RegistryConfigEntry,
  SchedulerConfig,
  SourceConfigEntry,
  SourceSpec,
} from "./config-types";
// Canonical harness-id source of truth (#565) — runtime value re-export.
export { VALID_HARNESS_IDS } from "./config-types";

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  registries: [
    { url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", name: "akm-registry" },
    { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh", enabled: false },
  ],
  output: {
    format: "json",
    detail: "brief",
  },
};

// ── Load / Save / Update ────────────────────────────────────────────────────

let cachedConfig:
  | {
      config: AkmConfig;
      path: string;
      mtime: number;
      size: number;
    }
  | undefined;

export function resetConfigCache(): void {
  cachedConfig = undefined;
}

const INHERITED_CONNECTIONS = Symbol("inheritedConnections");

/**
 * The connections only an `extends` base defines in `config`: this host's file names none of them. A base
 * chooses such a connection's endpoint, so it never uses a key stored on this host: keys are for the
 * connections this host's own config file defines. The loader attaches the set to the config it returns
 * (not enumerable, so a copy made with spread has none), and a config that did not come from the loader
 * has none inherited.
 */
export function inheritedConnectionsOf(config: AkmConfig): ReadonlySet<string> {
  return (config as { [INHERITED_CONNECTIONS]?: ReadonlySet<string> })[INHERITED_CONNECTIONS] ?? new Set();
}

/**
 * {@link inheritedConnectionsOf} the config as it is now on this host, loaded here when the cache holds
 * nothing: for a caller with no config in hand.
 */
export function isInheritedConnection(name: string): boolean {
  return inheritedConnectionsOf(loadUserConfig()).has(name);
}

export function loadUserConfig(): AkmConfig {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `Unable to read config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_CONFIG_FILE",
      );
    }
    cachedConfig = undefined;
    return { ...DEFAULT_CONFIG };
  }

  // Cache key: mtimeMs + size. Tests that write rapidly back-to-back inside
  // the mtime resolution window MUST call resetConfigCache() between writes —
  // every public test helper already does.
  if (
    cachedConfig &&
    cachedConfig.path === configPath &&
    cachedConfig.mtime === stat.mtimeMs &&
    cachedConfig.size === stat.size
  ) {
    return cachedConfig.config;
  }

  let text: string | undefined;
  try {
    text = readConfigText(configPath);
  } catch (err) {
    throw new ConfigError(
      `Unable to read config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (text === undefined) {
    cachedConfig = undefined;
    return { ...DEFAULT_CONFIG };
  }

  const lifted = readConfigFile(text, configPath);
  const finalConfig = buildEffectiveConfig(lifted, configPath);
  const written = isPlainConfigObject(lifted.connections) ? lifted.connections : {};
  const inheritedConnections = new Set(
    Object.keys(finalConfig.connections ?? {}).filter((name) => !Object.hasOwn(written, name)),
  );

  // Re-stat after potential write-back so the cache key reflects the new mtime.
  let finalStat = stat;
  try {
    finalStat = fs.statSync(configPath);
  } catch {
    // Stat failed — use original stat for cache; no harm done.
  }
  Object.defineProperty(finalConfig, INHERITED_CONNECTIONS, { value: inheritedConnections });
  cachedConfig = {
    config: finalConfig,
    path: configPath,
    mtime: finalStat.mtimeMs,
    size: finalStat.size,
  };
  return finalConfig;
}

/**
 * A config file as it says it: parsed, with `configVersion` read, and nothing else
 * converted. Every raw config object goes through it before it is validated (the
 * local file) or merged in as an `extends` base, so a fleet-shared base can carry its
 * own `configVersion`. Unknown keys are not an error: the schema drops them in memory.
 * A retired form (the `engines` form, `secret://`) is not converted here: it is named
 * once ({@link warnUnknownConfigKeys}, {@link warnRetiredSecretRefs}), and `akm migrate apply` rewrites it. An ordinary
 * write edits this document, so nothing a read does not understand is rewritten either.
 */
export function readConfigFile(text: string, sourcePath?: string): Record<string, unknown> {
  const raw = parseConfigText(text, sourcePath);
  warnRetiredSecretRefs(raw, [], sourcePath);
  return readConfigVersion(raw, sourcePath);
}

/**
 * `secret://<name>` is retired in favour of `${secrets/<name>}`. A value in that form is not read as a reference, so
 * each one is named once, by key; `akm migrate apply` rewrites it.
 */
function warnRetiredSecretRefs(node: unknown, keyPath: readonly string[], sourcePath?: string): void {
  if (typeof node === "string") {
    if (!node.startsWith("secret://") || node.length === "secret://".length) return;
    const dotted = keyPath.join(".");
    warnOnce(
      `config:secret-scheme:${sourcePath ?? "inline"}:${dotted}`,
      `${dotted}${sourcePath ? ` at ${sourcePath}` : ""} uses the retired "secret://" form, which this release does not read as a reference. Run \`akm migrate apply\` to rewrite config.json.`,
    );
  } else if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) warnRetiredSecretRefs(child, [...keyPath, String(i)], sourcePath);
  } else if (isPlainConfigObject(node)) {
    for (const [key, child] of Object.entries(node)) warnRetiredSecretRefs(child, [...keyPath, key], sourcePath);
  }
}

/**
 * `configVersion` is read, never gated on. `"0.9.0"` is the only value akm
 * has ever shipped, and a document without the field is that same document.
 * Any other value is named once and the file is read as the current shape
 * anyway; every ordinary config write and `akm migrate apply`'s `configFile`
 * step then persist `"0.9.0"`.
 */
function readConfigVersion(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const version = raw.configVersion;
  if (version === CURRENT_CONFIG_VERSION) return raw;
  if (version !== undefined) {
    warnOnce(
      `config:config-version${sourcePath ? `:${sourcePath}` : ""}`,
      `${sourcePath ?? "config.json"} declares configVersion ${JSON.stringify(version)}; this release reads it as ${CURRENT_CONFIG_VERSION}.`,
    );
  }
  return { ...raw, configVersion: CURRENT_CONFIG_VERSION };
}

/**
 * `output.format: html` is retired with akm's HTML output (AKM Desktop replaces it). The value is safely
 * ignorable, so the config keeps loading, the format falls back to the default, and one warning says why.
 * A read does not rewrite the file.
 */
function dropRetiredOutputFormat(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const output = raw.output;
  if (!isPlainConfigObject(output) || output.format !== "html") return raw;
  warnOnce(
    `config:output-format-html:${sourcePath ?? "inline"}`,
    `output.format "html" is no longer supported${sourcePath ? ` (${sourcePath})` : ""}: HTML reports moved to AKM Desktop. Using the default format; set output.format to json, jsonl, yaml, text or md.`,
  );
  const { format: _html, ...rest } = output;
  return { ...raw, output: rest };
}

/**
 * `improve.model`, `improve.llm` and `improve.timeoutMs` set the base for every model call. A value the schema
 * refuses (an empty model, a non-positive or over-ceiling timeout, a malformed `llm`) is safely ignorable: the base
 * falls back to the default, one warning says why, and the config keeps loading. A read does not rewrite the file.
 */
export function dropInvalidImproveBase(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const improve = raw.improve;
  if (!isPlainConfigObject(improve)) return raw;
  const rest = { ...improve };
  for (const key of ["model", "llm", "timeoutMs"] as const) {
    if (!(key in improve)) continue;
    const parsed = ImproveConfigSchema.shape[key].safeParse(improve[key]);
    if (parsed.success) continue;
    warnOnce(
      `config:improve-base-invalid:${sourcePath ?? "inline"}:${key}`,
      `improve.${key} is invalid${sourcePath ? ` (${sourcePath})` : ""} and is ignored: ${parsed.error.issues.map((i) => i.message).join("; ")}.`,
    );
    delete rest[key];
  }
  return Object.keys(rest).length === Object.keys(improve).length ? raw : { ...raw, improve: rest };
}

/**
 * Resolve a local file's `extends` chain and validate the merged result
 * (deep-merged under `DEFAULT_CONFIG`) via Zod ({@link AkmConfigSchema}).
 * `liftedLocalRaw` must already be through {@link readConfigFile}.
 *
 * Split out of {@link parseAndValidateConfigText} so `mutateConfig` (#945
 * finding: baking extends-inherited fields into the local file on every
 * write) can build the same effective config from a `localRaw` it also
 * keeps around, instead of only getting the final merged `AkmConfig` back.
 */
export function buildEffectiveConfig(liftedLocalRaw: Record<string, unknown>, sourcePath?: string): AkmConfig {
  const chained = dropInvalidImproveBase(
    dropRetiredOutputFormat(
      dropUnusableProjects(
        dropUnusableEntries(
          resolveBundlePaths(
            resolveExtendsChain(dropUnusableProjects(liftedLocalRaw, sourcePath), sourcePath),
            sourcePath,
          ),
          sourcePath,
        ),
        sourcePath,
      ),
      sourcePath,
    ),
    sourcePath,
  );
  // Writing an `embedding` block says semantic search is wanted: a config that names no mode reads as "auto".
  const withExtends =
    chained.embedding !== undefined && chained.semanticSearchMode === undefined
      ? { ...chained, semanticSearchMode: "auto" }
      : chained;

  const where = sourcePath ? ` at ${sourcePath}` : "";
  warnUnknownConfigKeys(liftedLocalRaw, sourcePath);
  const parsed = AkmConfigSchema.safeParse(withExtends);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid config${where}:\n${lines}`, "INVALID_CONFIG_FILE");
  }
  const merged = deepMergeConfig(DEFAULT_CONFIG, parsed.data as Partial<AkmConfig>) as AkmConfig;
  const finalResult = AkmConfigSchema.safeParse(merged);
  if (!finalResult.success) {
    const lines = finalResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(
      `Invalid merged config${sourcePath ? ` at ${sourcePath}` : ""}:\n${lines}`,
      "INVALID_CONFIG_FILE",
    );
  }
  assertUniquePhysicalBundleRoots(finalResult.data, sourcePath);
  return finalResult.data;
}

/**
 * Every dotted key in `raw` the schema does not know, at any depth (arrays
 * are not descended, except the entries of `registries`). Unknown keys are never an error: they are a typo, or a
 * key another release used. Reads keep them (they round-trip through
 * ordinary writes, so a newer release's settings survive a downgrade);
 * `akm migrate apply` drops them.
 */
export function unknownConfigKeyPaths(
  root: Record<string, unknown>,
  node: Record<string, unknown> = root,
  prefix: readonly string[] = [],
): string[][] {
  const found: string[][] = [];
  for (const key of Object.keys(node).sort()) {
    const keyPath = [...prefix, key];
    // `$schema` is the editor hint every JSON-schema-aware config carries; akm ignores it silently.
    if (prefix.length === 0 && key === "$schema") continue;
    const schema = resolveSchemaAt(keyPath, root);
    if (schema === undefined) {
      found.push(keyPath);
      continue;
    }
    // A request field on a connection (`chat_template_kwargs`, ...) is the endpoint's, not akm's: its contents are not keys akm knows.
    if (isOpaqueSchema(schema)) continue;
    const value = node[key];
    if (isPlainConfigObject(value)) found.push(...unknownConfigKeyPaths(root, value, keyPath));
    // `registries` is the one array of keyed entries: a key its entries no longer have (`options`) is named too.
    if (keyPath.join(".") === "registries" && Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (!isPlainConfigObject(entry)) return;
        for (const field of Object.keys(entry).sort()) {
          if (!(field in RegistryConfigEntrySchema.shape)) found.push([...keyPath, String(index), field]);
        }
      });
    }
  }
  return found;
}

/**
 * What a key this release does not read is told, once. The retired `engines` / `defaults` form and an `engine` key in
 * a model-work block say where model work runs: ignoring them runs that work on the default connection or harness, or
 * on none, so their message says what stops and names the command that rewrites the file.
 */
const RETIRED_ENGINE_KEY = /^(engines|defaults|improve(\.processes\.[^.]+|\.qualityGate)?\.engine)$/;

function warnUnknownConfigKeys(raw: Record<string, unknown>, sourcePath?: string): void {
  for (const keyPath of unknownConfigKeyPaths(raw)) {
    const dotted = keyPath.join(".");
    const at = sourcePath ? ` at ${sourcePath}` : "";
    if (RETIRED_ENGINE_KEY.test(dotted)) {
      warnOnce(
        `config:retired-engine-key:${sourcePath ?? "inline"}:${dotted}`,
        `Config key ${JSON.stringify(dotted)}${at} is the retired engines form, which this release does not read: its connections and harnesses are not configured, so model work runs on the default connection or harness, or not at all. Run \`akm migrate apply\` to convert the file.`,
      );
      continue;
    }
    warnOnce(
      `config:unknown-key:${sourcePath ?? "inline"}:${dotted}`,
      `Unknown config key ${JSON.stringify(dotted)}${at} has no defined akm behavior and is ignored. Check the spelling; a key retired by this release or added by a newer one is dropped by \`akm migrate apply\`.`,
    );
  }
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUniquePhysicalBundleRoots(config: AkmConfig, sourcePath?: string): void {
  const owners = new Map<string, string>();
  for (const { id, contentRoot } of bundleContentRoots(config)) {
    const prior = owners.get(contentRoot);
    if (prior !== undefined) {
      throw new ConfigError(
        `Invalid config${sourcePath ? ` at ${sourcePath}` : ""}: bundles ${JSON.stringify(prior)} and ${JSON.stringify(id)} resolve to the same physical content root ${contentRoot}.`,
        "INVALID_CONFIG_FILE",
        "Configure one bundle id per physical source root; symbolic-link aliases are not separate bundles.",
      );
    }
    owners.set(contentRoot, id);
  }
}

/**
 * Parse raw config text and validate via Zod.
 * ({@link AkmConfigSchema}). Returns the merged-with-defaults AkmConfig.
 *
 * `configVersion` is read as the current version whatever it says (see
 * {@link readConfigVersion}). When the config sets `extends` (#945), its
 * resolved chain is deep-merged underneath before validation — see
 * {@link resolveExtendsChain}.
 */
export function parseAndValidateConfigText(text: string, sourcePath?: string): AkmConfig {
  const liftedConfig = readConfigFile(text, sourcePath);
  return buildEffectiveConfig(liftedConfig, sourcePath);
}

// ── `extends` inheritance (#945) ────────────────────────────────────────────

/** One layer of an `extends` chain, from the local file (`ref: undefined`) outward to the chain's root. */
interface ConfigLayer {
  /** The `extends` value that led here; `undefined` for the local/topmost layer. */
  ref: string | undefined;
  /** This layer's raw config, already through {@link readConfigFile}. */
  raw: Record<string, unknown>;
}

/**
 * Walk an `extends` chain starting at `localRaw` (already through
 * {@link readConfigFile}), returning every layer from the local file
 * outward to the chain's root, local first. A chain is allowed (a base may
 * itself set `extends`); a cycle (a resolved source repeating) throws
 * {@link ConfigError} instead of recursing forever.
 */
function collectExtendsLayers(localRaw: Record<string, unknown>, configPath: string | undefined): ConfigLayer[] {
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
    const baseRaw = readConfigFile(text, resolvedPath);
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
 * fields `pruneUnchangedInheritedFields` finds changed-or-already-local (#945
 * finding — the effective object used to be baked into the local file
 * verbatim, duplicating every inherited field into it). That pruning keys off
 * which fields are present in `current`/`next`, so `extends` has to still be
 * one of them or it would silently vanish from disk on the very next
 * `config set`.
 */
function resolveExtendsChain(
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
  "embedding",
  "experimental",
  "registries",
  "scheduler",
]);

/**
 * Shared config contributes portable behavior only. Source ownership,
 * credentials, executable paths/arguments, and activation remain in the
 * host's top-level config even when a bundle supplies the inherited file.
 * LLM endpoints and model selection remain portable; their credentials never
 * do.
 */
function sanitizeInheritedConfig(raw: Record<string, unknown>, label: string): Record<string, unknown> {
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

/** `~` expands to the home directory. */
function expandExtendsHomePath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
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
 * empty, absolute, or content-root-escaping path after `//`.
 */
function resolveConfigRefSource(
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
  const expanded = expandExtendsHomePath(ref);
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
  let componentRoot: string | undefined;
  try {
    componentRoot = bundleComponentConfig(bundleEntry as BundleConfigEntry)?.root;
  } catch (err) {
    throw new ConfigError(
      `extends "${ref}" names bundle "${bundleId}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
    );
  }
  const bundleRoot = bundleContentRoot(bundlePath, componentRoot);

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
      `Unable to verify physical containment for extends ${JSON.stringify(ref)}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
  const liftedConfig = readConfigFile(text, configPath);
  const segments = dotted.split(".").filter((s) => s.length > 0);
  for (const layer of collectExtendsLayers(liftedConfig, configPath)) {
    const effectiveLayer = layer.ref === undefined ? layer.raw : sanitizeInheritedConfig(layer.raw, layer.ref);
    if (hasRawPath(effectiveLayer, segments)) {
      return layer.ref === undefined ? "local" : `extends:${layer.ref}`;
    }
  }
  return "default";
}

function hasRawPath(raw: unknown, segments: string[]): boolean {
  let cursor: unknown = raw;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}

// Exposed for `akm config diff` (config-cli.ts): the `<path|bundle//ref>`
// argument shares the exact same resolution grammar as `extends`.
export { resolveConfigRefSource };

/**
 * The configured stash sources as an ordered {@link SourceConfigEntry} list.
 *
 * Every source is a `bundles.<slug>` entry. This derives the provider-ready
 * source list from `bundles` (defaultBundle first, then map order). Returns
 * `[]` when no bundles are configured.
 */
export function getSources(config: AkmConfig): SourceConfigEntry[] {
  return bundlesToSourceEntries(config) ?? [];
}

export function getEffectiveRegistries(config: AkmConfig): RegistryConfigEntry[] {
  return config.registries ?? DEFAULT_CONFIG.registries ?? [];
}

type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: unknown;
};
export type ImproveProcessName = NamedKeys<NonNullable<ImproveProfileConfig["processes"]>>;

/**
 * Transitional internal accessor. It deliberately never consults a configured
 * default strategy; callers must pass their already selected strategy.
 */
export function getImproveProcessConfig(
  processName: ImproveProcessName,
  selected?: ImproveProfileConfig,
): ImproveProcessConfig | undefined {
  return selected?.processes?.[processName];
}

/** The entry named `default`, else the lone entry, else none. */
function defaultEntry<T>(entries: Record<string, T> | undefined): { name: string; entry: T } | undefined {
  if (!entries) return undefined;
  const names = Object.keys(entries);
  const name = Object.hasOwn(entries, "default") ? "default" : names.length === 1 ? names[0] : undefined;
  return name === undefined ? undefined : { name, entry: entries[name] as T };
}

/**
 * What is wrong when connections or harnesses are configured but none of a kind is the default: several, and
 * none called `default`. The phrase (no final period) names the fix. Undefined when every kind that is configured has a default
 * (`only` limits the check to one kind).
 */
export function ambiguousDefaultAdvice(config: AkmConfig, only?: "connection" | "harness"): string | undefined {
  const advice = (["connection", "harness"] as const).flatMap((kind) => {
    if (only && kind !== only) return [];
    const names = Object.keys((kind === "connection" ? config.connections : config.harnesses) ?? {});
    if (names.length < 2 || names.includes("default")) return [];
    return [
      `Several ${kind === "harness" ? "harnesses" : "connections"} are configured (${names.join(", ")}) and none is named "default": name one default in config.json, or pick one with --${kind}`,
    ];
  });
  return advice.length > 0 ? advice.join("; ") : undefined;
}

/** The default connection: the one named `default`, else the only one. */
export function defaultConnection(config: AkmConfig): { name: string; connection: ConnectionConfig } | undefined {
  const found = defaultEntry(config.connections);
  return found ? { name: found.name, connection: found.entry } : undefined;
}

/** The default harness: the one named `default`, else the only one. */
export function defaultHarness(config: AkmConfig): { name: string; harness: HarnessConfig } | undefined {
  const found = defaultEntry(config.harnesses);
  return found ? { name: found.name, harness: found.entry } : undefined;
}

export function loadConfig(): AkmConfig {
  return loadUserConfig();
}

export function saveConfig(config: AkmConfig): void {
  // Every lifecycle write produces the only config version this binary can load.
  const currentConfig = { ...config, configVersion: CURRENT_CONFIG_VERSION } as AkmConfig;
  saveConfigReal(currentConfig);
}

function saveConfigReal(config: AkmConfig): void {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  withConfigLock(() => {
    const validated = validateCompleteConfig(config);
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, sanitizeConfigForWrite(validated));
  });
}

export function validateCompleteConfig(config: AkmConfig): AkmConfig {
  const parseResult = AkmConfigSchema.safeParse(config);
  if (parseResult.success) return parseResult.data;
  const lines = parseResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  throw new ConfigError(
    `Refusing to save invalid config:\n${lines}`,
    "INVALID_CONFIG_FILE",
    "Fix the listed fields, or undo the offending `akm config set`. " +
      "If this looks like an akm bug, re-run with --debug to attach the traceback.",
  );
}

export interface ConfigMutationResult {
  /**
   * The full EFFECTIVE config after the mutation — `next` (or `current`
   * when the mutate callback was a no-op) — the same shape `loadConfig()`
   * returns, `extends` chain already merged in, every field intact
   * including credential references (`embedding.apiKey`,
   * `connections.<name>.apiKey`, ...). #953 field gap: this is NOT the pruned write body — pruning
   * (`editedConfigFile`, #945) only decides
   * what gets written to the local config FILE when it uses `extends`; a
   * caller that keeps using this returned `config` for the rest of its run
   * (as `src/indexer/indexer.ts`'s `akmIndexReal` does after
   * `detectAndPersistBundleAdapters`) gets the complete config either way,
   * never a pruned local view.
   */
  config: AkmConfig;
  written: boolean;
}

/**
 * Apply the edit `before` → `after` to `target` (the file's own document) and
 * nothing else: a key that is the same on both sides is left as the file has it,
 * whatever shape that is, so an unrelated write neither converts nor drops what
 * the reader only reads (the retired `engines` form, an inherited field, a key
 * the schema does not know). Only the paths that changed are written, at the same
 * path in `target`; an object the file lacks gets only the changed part. The
 * keys of a nested map follow `after`, which is how a mutation says where it
 * inserted one (`bundles`); the top level keeps the file's authored order. A
 * removal of a key the document does not hold is left undone. A `projects` entry is one value, as an array is.
 */
function applyEdit(
  target: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  at: readonly string[] = [],
): void {
  for (const key of Object.keys(before)) {
    if (Object.hasOwn(after, key)) continue;
    if (Object.hasOwn(target, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(after)) {
    const was = before[key];
    if (isDeepStrictEqual(value, was)) continue;
    // The reader takes a project whole by name, so one is written whole (an inherited project's unchanged fields
    // included), never as the changed part of it.
    if (at.length === 1 && at[0] === "projects") {
      target[key] = value;
      continue;
    }
    const existing = target[key];
    // An entry the reader dropped (a connection with no endpoint) is absent from
    // `before` but present in the file: an edit to it adds to what the file has.
    const merges = was === undefined ? isPlainObject(existing) : isPlainObject(was);
    if (!isPlainObject(value) || !merges || (existing !== undefined && !isPlainObject(existing))) {
      target[key] = value;
      continue;
    }
    const part = existing ?? {};
    applyEdit(part, isPlainObject(was) ? was : {}, value, [...at, key]);
    followKeyOrder(part, value);
    if (existing !== undefined || Object.keys(part).length > 0) target[key] = part;
  }
}

/** Put the keys of `target` in the order of `order`, those it does not name after. */
function followKeyOrder(target: Record<string, unknown>, order: Record<string, unknown>): void {
  const keys = [
    ...Object.keys(order).filter((key) => Object.hasOwn(target, key)),
    ...Object.keys(target).filter((key) => !Object.hasOwn(order, key)),
  ];
  const entries = keys.map((key) => [key, target[key]] as const);
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of entries) target[key] = value;
}

/**
 * A bundle that `next` holds under a new name came from the loaded entry, whose
 * `path` is the resolved one. Write the path the file spelled for the entry it
 * replaced (`~/x` stays `~/x`).
 */
function keepRenamedBundlePaths(
  body: Record<string, unknown>,
  document: Record<string, unknown>,
  current: AkmConfig,
  next: AkmConfig,
): void {
  const written = document.bundles;
  if (!isPlainObject(written) || !isPlainObject(body.bundles)) return;
  for (const [name, entry] of Object.entries(next.bundles ?? {})) {
    if (Object.hasOwn(current.bundles ?? {}, name)) continue;
    const from = Object.entries(current.bundles ?? {}).find(([, old]) => isDeepStrictEqual(old, entry))?.[0];
    const asWritten = from === undefined ? undefined : written[from];
    const target = (body.bundles as Record<string, unknown>)[name];
    if (isPlainObject(asWritten) && typeof asWritten.path === "string" && isPlainObject(target)) {
      target.path = asWritten.path;
    }
  }
}

/**
 * What an ordinary `mutateConfig`/`mutateConfigWithPrecommit` write persists:
 * the file's own document with the edit `current` → `next` applied
 * ({@link applyEdit}). Lifecycle mutations must not serialize every schema
 * default merely because validation materialized it in memory (#972), nor the
 * fields that only came along from `extends` (#945).
 */
function editedConfigFile(
  document: Record<string, unknown> | undefined,
  current: AkmConfig,
  next: AkmConfig,
  persistTopLevelKeys: readonly (keyof AkmConfig)[] = [],
  writeProjects: readonly string[] = [],
): Record<string, unknown> {
  // Keys stay in their authored order and new ones follow in `next` order: the
  // add -> remove lifecycle writes the same logical object twice and must come
  // back byte for byte.
  const source = document ?? {};
  const body = structuredClone(source);
  applyEdit(body, current, next);
  keepRenamedBundlePaths(body, source, current, next);
  // A project the caller names is written whole even when it equals the effective entry: the file's own may hold parts the reader ignores.
  for (const name of writeProjects) {
    const entry = next.projects?.[name];
    if (!entry) continue;
    if (!isPlainObject(body.projects)) body.projects = {};
    (body.projects as Record<string, unknown>)[name] = entry;
  }
  // A caller may need to persist an explicit user choice even when it equals the
  // schema default. Interactive setup uses this for semanticSearchMode: "off"
  // means the user declined the opt-in, not an incidental default.
  for (const key of persistTopLevelKeys) {
    if (Object.hasOwn(next, key)) body[key] = next[key];
  }
  body.configVersion = CURRENT_CONFIG_VERSION;
  return body;
}

/**
 * The connection or harness that `key` (`connections.<name>[.…]`,
 * `harnesses.<name>[.…]`) is inside, when the reader drops it: this file holds it
 * and nothing, an `extends` base included, completes it. `akm config` cannot edit
 * an entry it cannot see.
 */
export function unusableEntryAt(key: string): (UnusableEntry & { group: "connections" | "harnesses" }) | undefined {
  const [group, name] = key.split(".");
  if (group !== "connections" && group !== "harnesses") return undefined;
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;
  const document = readConfigFile(text, configPath);
  const entry = findUnusableEntries(document).find(
    (found) => found.name === name && found.kind === (group === "connections" ? "connection" : "harness"),
  );
  if (!entry || Object.hasOwn(buildEffectiveConfig(document, configPath)[group] ?? {}, entry.name)) return undefined;
  return { ...entry, group };
}

/**
 * Mutate config under one fail-closed lock spanning read, merge, validation,
 * ordinary backup, and atomic write.
 */
export function mutateConfig(
  mutate: (current: AkmConfig) => AkmConfig,
  options?: { absentNoop?: boolean; writeProjects?: readonly string[] },
): ConfigMutationResult {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  return withConfigLock(() => {
    const text = readConfigText(configPath);
    if (text === undefined && options?.absentNoop) {
      return { config: { ...DEFAULT_CONFIG }, written: false };
    }
    const document = text === undefined ? undefined : readConfigFile(text, configPath);
    const current =
      document === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : buildEffectiveConfig(document, configPath);
    const mutated = mutate(current);
    if (mutated === current) return { config: current, written: false };
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    const body = editedConfigFile(document, current, next, [], options?.writeProjects);
    if (text !== undefined) backupExistingConfig(configPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(body as AkmConfig));
    return { config: next, written: true };
  });
}

/**
 * Mutate config while holding the write lock across one validated pre-commit
 * side effect. Setup uses this to reject a three-way conflict before creating
 * its stash, while preventing another config writer from racing the final save.
 */
export async function mutateConfigWithPrecommit<T>(
  mutate: (current: AkmConfig) => AkmConfig,
  precommit: (next: AkmConfig) => Promise<T>,
  options?: { persistTopLevelKeys?: readonly (keyof AkmConfig)[] },
): Promise<ConfigMutationResult & { precommit: T }> {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const release = acquireConfigLock();
  try {
    const text = readConfigText(configPath);
    const document = text === undefined ? undefined : readConfigFile(text, configPath);
    const current =
      document === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : buildEffectiveConfig(document, configPath);
    const mutated = mutate(current);
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    const body = editedConfigFile(document, current, next, options?.persistTopLevelKeys);
    if (text !== undefined) backupExistingConfig(configPath);
    const precommitResult = await precommit(next);
    if (mutated === current) return { config: current, written: false, precommit: precommitResult };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(body as AkmConfig));
    return { config: next, written: true, precommit: precommitResult };
  } finally {
    release();
  }
}

/**
 * The source identity 0.9.16 bound a scheduler grant to: the configured
 * bundle's source id, or the implicit `AKM_BUNDLE_DIR` stash's. `undefined`
 * when the bundle is not active on this host.
 */
export function schedulerSourceIdFor(config: AkmConfig, bundleId: string): string | undefined {
  if (isBundleEnabled(config, bundleId)) return bundleSourceId(config, bundleId);
  if (config.bundles?.[bundleId] !== undefined || !process.env.AKM_BUNDLE_DIR?.trim()) return undefined;
  try {
    const root = resolveStashDir();
    const implicitId = deriveBundleId(undefined, root, new Set(Object.keys(config.bundles ?? {})));
    return implicitId === bundleId ? filesystemBundleSourceId(root) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drop what must not reach `config.json` before it is written.
 *
 * A literal `apiKey` is not dropped: akm never reads or sends it (see
 * `envReferenceApiKey`), but it is the user's, and `akm migrate apply` is what
 * moves it. Only registry URLs carrying credentials are removed here.
 * `quiet` skips the warnings for a caller that only asks whether a write would
 * drop anything and writes nothing itself.
 */
export function sanitizeConfigForWrite(config: AkmConfig, options?: { quiet?: boolean }): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };

  if (config.registries) {
    const droppedRegistries: string[] = [];
    const registries = config.registries.filter((entry) => {
      if (!hasRegistryUrlCredentials(entry.url)) return true;
      droppedRegistries.push(formatRegistryLabel(entry));
      return false;
    });
    if (droppedRegistries.length > 0) {
      sanitized.registries = registries;
      if (!options?.quiet)
        warn(
          `Config sanitizer dropped registry entr${droppedRegistries.length === 1 ? "y" : "ies"} with URL credentials before writing to disk:\n  - ${droppedRegistries.join("\n  - ")}\n\nRegistry URLs must be credential-free; configure a credential-free HTTPS endpoint.`,
        );
    }
  }

  return sanitized;
}

export function updateConfig(partial: Partial<AkmConfig>): AkmConfig {
  return mutateConfig((current) => deepMergeConfig(current, partial) as AkmConfig).config;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Looks up a `${ref}` secret's stored value, or `null` if it isn't there. Implemented by `resolveSecretFromStore` in `sources/snapshot-fetchers/secret-seam.ts`; passed in rather than imported here to avoid a cycle (that module's dependencies import this one). */
export type SecretStoreResolver = (ref: string) => string | null;

/**
 * Resolve a single secret value: expand `${VAR}` / `$VAR` against
 * `process.env`, then substitute `${ref}` tokens (`${secrets/name}`) through
 * `resolveFromStore`. Use this at apiKey / authorization-header consumption
 * sites (LLM client, embedder, agent SDK runner) — NOT on the load path.
 * Non-string inputs pass through unchanged.
 *
 * Returns the input unchanged when no substitution markers are present, so
 * literal API key strings (already-resolved secrets) are zero-cost.
 *
 * Other config string values (URLs, endpoints, model names, prompts) are
 * preserved verbatim on read — only fields explicitly routed through this
 * helper are expanded.
 *
 * A `${ref}` that fails to resolve throws `ConfigError` (naming the ref, never
 * the secret) rather than silently sending an unusable credential.
 */
export function resolveSecret(value: string | undefined, resolveFromStore?: SecretStoreResolver): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  if (!value.includes("$")) return value;
  // Env expansion runs first so a secret value containing `$` is never re-expanded.
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced, bare) => {
      const name = (braced ?? bare) as string;
      const resolved = process.env[name];
      if (!resolved) {
        // #953: an unset/empty $VAR used to substitute silently, so a gateway
        // that enforces auth on inference (e.g. Bifrost) failed every call with
        // an opaque 401 instead of a diagnosable warning naming the variable.
        warnOnce(
          `config:empty-env-var:${name}`,
          `Environment variable ${name} referenced by a $VAR apiKey is unset or empty; the request will be sent without a valid credential.`,
        );
      }
      return resolved ?? "";
    },
  );
  const { values, missing } = substituteRefTokens({ value: expanded }, (ref) => {
    const stored = resolveFromStore?.(ref) ?? null;
    return stored === null ? undefined : { kind: "secret", value: stored };
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Secret store reference "\${${missing[0]}}" did not resolve to a stored value.`,
      "SECRET_REFERENCE_UNRESOLVED",
    );
  }
  return values.value;
}

// Re-export source runtime helpers — implementation lives in config-sources.ts.
export {
  bundleComponentConfig,
  bundleContentRoot,
  bundleContentRoots,
  bundleEntryToSourceEntry,
  bundleKeyForContentRoot,
  bundlePhysicalContentRoot,
  bundleSourceId,
  bundlesToSourceEntries,
  installedSourceDescriptor,
  isBundleEnabled,
  parseSourceSpec,
  primaryBundlePath,
  resolveActiveConfiguredSources,
  resolveConfiguredSources,
} from "./config-sources";

/**
 * Merge a partial user-config override onto a base config. Used by
 * {@link loadUserConfig} (DEFAULT_CONFIG + on-disk) and {@link updateConfig}
 * (current config + partial patch). Sub-objects with named records (profiles,
 * defaults, etc.) shallow-merge; arrays override wholesale.
 */
