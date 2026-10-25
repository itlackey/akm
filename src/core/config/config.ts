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
import { isRefToken, substituteRefTokens } from "../ref-token";
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
import { convertEngineConfig } from "./convert-engines";
import { deepMergeConfig, isPlainObject } from "./deep-merge";
import { dropUnusableEntries } from "./unusable-entries";

export { stripJsonComments } from "./config-io";

import { getConfigDir, getConfigPath } from "../paths";
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
  IndexConfig,
  IndexPassConfig,
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

let cachedConfig: { config: AkmConfig; path: string; mtime: number; size: number } | undefined;

export function resetConfigCache(): void {
  cachedConfig = undefined;
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

  const finalConfig = parseAndValidateConfigText(text, configPath);

  // Re-stat after potential write-back so the cache key reflects the new mtime.
  let finalStat = stat;
  try {
    finalStat = fs.statSync(configPath);
  } catch {
    // Stat failed — use original stat for cache; no harm done.
  }
  cachedConfig = {
    config: finalConfig,
    path: configPath,
    mtime: finalStat.mtimeMs,
    size: finalStat.size,
  };
  return finalConfig;
}

/**
 * Run the per-file config pipeline every raw config object goes through
 * before it is either validated (the local/top-level file) or merged in as
 * an `extends` base: JSONC parse already done by the caller, then the retired
 * `engines` form read as `connections`/`harnesses` ({@link readRetiredEngines})
 * and the `configVersion` read ({@link readConfigVersion}). Unknown keys are not an
 * error: the schema drops them in memory. A shape older than 0.9.15 is not
 * converted here; it fails validation with a message naming `akm migrate
 * apply` under akm 0.9.x. Shared by {@link parseAndValidateConfigText} (the
 * local file) and {@link resolveExtendsChain} (each base in the chain) so a
 * fleet-shared base config can carry its own `configVersion` independently of
 * the file that extends it.
 */
function runConfigFilePipeline(text: string, sourcePath?: string): Record<string, unknown> {
  return readRetiredEngines(readConfigFile(text, sourcePath), sourcePath);
}

/**
 * A config file as it says it: parsed, with the retired `secret://` forms and
 * `configVersion` read, and nothing else converted. An ordinary write edits this
 * document, so what a read converts in memory (the retired `engines` form) is
 * not rewritten until `akm migrate apply`.
 */
function readConfigFile(text: string, sourcePath?: string): Record<string, unknown> {
  const raw = parseConfigText(text, sourcePath);
  const lifted = readRetiredSecretRefs(raw, [], sourcePath) as Record<string, unknown>;
  return readConfigVersion(lifted, sourcePath);
}

/** The user's `models.json` (retired), parsed; absent or unreadable is no overlay. */
function readModelsOverlay(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(getConfigDir(), "models.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `engines` / `defaults` are retired in favour of `connections` / `harnesses`.
 * A config in the old form is read as the new one, in memory, with one warning;
 * `akm migrate apply` writes it back (it runs {@link convertEngineConfig} too,
 * through this pipeline, before it deletes the keys the schema does not know).
 */
function readRetiredEngines(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const { config, notes, changed } = convertEngineConfig(raw, { modelsOverlay: readModelsOverlay(), env: process.env });
  if (!changed) return raw;
  warnOnce(
    `config:retired-engines:${sourcePath ?? "inline"}`,
    `${sourcePath ?? "config.json"} uses the retired engines/defaults form; reading it as connections/harnesses. \`akm migrate apply\` rewrites config.json.${notes.map((note) => `\n  - ${note}`).join("")}`,
  );
  return config;
}

/** The retired `secret://<name>` credential form; it survives only in {@link readRetiredSecretRefs}. */
const SECRET_STORE_REFERENCE_PATTERN = /^secret:\/\/(.+)$/;

/**
 * The `${ref}` a retired `secret://<x>` value reads as: `${<x>}` when `<x>` is
 * already a full ref, else `${secrets/<x>}`. `undefined` for any other string.
 * Shared by the config reader and the frozen workflow runner decoder.
 */
export function liftRetiredSecretRef(value: string): string | undefined {
  const name = SECRET_STORE_REFERENCE_PATTERN.exec(value)?.[1];
  if (name === undefined) return undefined;
  return isRefToken(`\${${name}}`) ? `\${${name}}` : `\${secrets/${name}}`;
}

/**
 * `secret://<x>` is retired in favour of `${ref}`. A value in that form is read
 * as its {@link liftRetiredSecretRef} with one warning naming the key; every
 * ordinary config write and `akm migrate apply`'s `configFile` step then
 * persist the new form.
 */
function readRetiredSecretRefs(node: unknown, keyPath: readonly string[], sourcePath?: string): unknown {
  if (typeof node === "string") {
    const lifted = liftRetiredSecretRef(node);
    if (lifted === undefined) return node;
    const dotted = keyPath.join(".");
    warnOnce(
      `config:secret-scheme:${sourcePath ?? "inline"}:${dotted}`,
      `${dotted}${sourcePath ? ` at ${sourcePath}` : ""} uses the retired ${JSON.stringify(node)} form; reading it as ${JSON.stringify(lifted)}. \`akm migrate apply\` rewrites config.json.`,
    );
    return lifted;
  }
  if (Array.isArray(node))
    return node.map((child, i) => readRetiredSecretRefs(child, [...keyPath, String(i)], sourcePath));
  if (isPlainConfigObject(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, readRetiredSecretRefs(child, [...keyPath, key], sourcePath)]),
    );
  }
  return node;
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
 * Resolve a local file's `extends` chain and validate the merged result
 * (deep-merged under `DEFAULT_CONFIG`) via Zod ({@link AkmConfigSchema}).
 * `liftedLocalRaw` must already be through {@link runConfigFilePipeline}.
 *
 * Split out of {@link parseAndValidateConfigText} so `mutateConfig` (#945
 * finding: baking extends-inherited fields into the local file on every
 * write) can build the same effective config from a `localRaw` it also
 * keeps around, instead of only getting the final merged `AkmConfig` back.
 */
function buildEffectiveConfig(liftedLocalRaw: Record<string, unknown>, sourcePath?: string): AkmConfig {
  const withExtends = dropUnusableEntries(resolveExtendsChain(liftedLocalRaw, sourcePath), sourcePath);

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
 * Retired `index.<passName>` keys that still validate against the generic
 * per-pass catchall schema (`IndexPassConfigSchema`), so `resolveSchemaAt`
 * below never returns `undefined` for them and the walk would otherwise
 * treat them as a live, ordinary pass. Named here so the same three
 * guarantees apply as any other retired config key (AGENTS.md "Reading
 * persisted data"): a config setting one keeps loading, is named once by
 * the unknown-key warning, and is dropped only by `akm migrate apply`.
 * `index.graph` (the LLM entity-graph extraction pass) and
 * `index.metadataEnhance` (LLM metadata enrichment) were retired in
 * 0.9.17-alpha.9; `index.stalenessDetection` before them.
 */
const RETIRED_CATCHALL_KEY_PATHS = new Set(["index.graph", "index.metadataEnhance", "index.stalenessDetection"]);

/**
 * Every dotted key in `raw` the schema does not know, at any depth (arrays
 * are not descended). Unknown keys are never an error: they are a typo, or a
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
    const schema = resolveSchemaAt(keyPath, root);
    if (RETIRED_CATCHALL_KEY_PATHS.has(keyPath.join(".")) || schema === undefined) {
      found.push(keyPath);
      continue;
    }
    // A request field on a connection (`chat_template_kwargs`, ...) is the endpoint's, not akm's: its contents are not keys akm knows.
    if (isOpaqueSchema(schema)) continue;
    const value = node[key];
    if (isPlainConfigObject(value)) found.push(...unknownConfigKeyPaths(root, value, keyPath));
  }
  return found;
}

function warnUnknownConfigKeys(raw: Record<string, unknown>, sourcePath?: string): void {
  for (const keyPath of unknownConfigKeyPaths(raw)) {
    const dotted = keyPath.join(".");
    warnOnce(
      `config:unknown-key:${sourcePath ?? "inline"}:${dotted}`,
      `Unknown config key ${JSON.stringify(dotted)}${sourcePath ? ` at ${sourcePath}` : ""} has no defined akm behavior and is ignored. Check the spelling; a key retired by this release or added by a newer one is dropped by \`akm migrate apply\`.`,
    );
  }
}

function deleteConfigPath(node: Record<string, unknown>, keyPath: readonly string[]): void {
  let cursor: unknown = node;
  for (const segment of keyPath.slice(0, -1)) {
    if (!isPlainConfigObject(cursor)) return;
    cursor = cursor[segment];
  }
  if (isPlainConfigObject(cursor)) delete cursor[keyPath[keyPath.length - 1] as string];
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
  const liftedConfig = runConfigFilePipeline(text, sourcePath);
  return buildEffectiveConfig(liftedConfig, sourcePath);
}

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
    merged = deepMergeConfig(merged, i > 0 ? sanitizeInheritedConfig(layer.raw, layer.ref ?? String(i)) : layer.raw);
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

  if (isPlainObject(inherited.search) && Object.hasOwn(inherited.search, "curateRerank")) {
    const { curateRerank: _curateRerank, ...portableSearch } = inherited.search;
    inherited.search = portableSearch;
    warnOnce(
      `config:inherited-host-local:${label}:search.curateRerank`,
      `Ignoring inherited config key "search.curateRerank" from ${label}; network endpoints and credentials are host-local.`,
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
 * #945 review finding: `mutateConfig` used to write the entire extends-merged
 * *effective* config (`next`) back to the local file on every `config
 * set`/`unset`, duplicating every inherited `connections`/`improve.strategies`
 * field into the local file on the very first ordinary write after adopting
 * `extends` — defeating the feature (shared config, ≤20-line local files)
 * and silently freezing the local copy against future upstream changes.
 *
 * Reduces `after` (the mutated effective config) down to only what the
 * mutation actually changed relative to `before` (the effective config
 * *before* the mutation), plus whatever `localRaw` — the local file's own
 * raw content, pre-`extends`-merge — already had explicitly. Everything
 * else that only came along for the ride from `extends`/`DEFAULT_CONFIG` is
 * left out, so it keeps being read from the base on the next load instead
 * of being frozen as a local literal.
 */
function pruneUnchangedInheritedFields(before: unknown, after: unknown, localRaw: unknown): unknown {
  if (!isPlainObject(after) || !isPlainObject(before)) return after;
  const localRecord = isPlainObject(localRaw) ? localRaw : undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const afterValue = after[key];
    const beforeValue = before[key];
    const localHasKey = localRecord ? Object.hasOwn(localRecord, key) : false;
    if (isPlainObject(afterValue) && isPlainObject(beforeValue)) {
      const pruned = pruneUnchangedInheritedFields(
        beforeValue,
        afterValue,
        localHasKey ? localRecord?.[key] : undefined,
      );
      const prunedHasContent = isPlainObject(pruned) ? Object.keys(pruned).length > 0 : pruned !== undefined;
      if (prunedHasContent || localHasKey) result[key] = pruned;
      continue;
    }
    if (localHasKey || !isDeepStrictEqual(afterValue, beforeValue)) {
      result[key] = afterValue;
    }
  }
  return result;
}

/**
 * Apply the edit `before` → `after` to `target` (the file's own document) and
 * nothing else: a key that is the same on both sides is left as the file has it,
 * whatever shape that is, so an unrelated write neither converts nor drops what
 * the reader only reads (the retired `engines` form, an inherited field, a key
 * the schema does not know). Only the paths that changed are written, at the same
 * path in `target`; an object the file lacks gets only the changed part. The
 * keys of a nested map follow `after`, which is how a mutation says where it
 * inserted one (`bundles`); the top level keeps the file's authored order.
 */
function applyEdit(target: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>) {
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(after)) {
    const was = before[key];
    if (isDeepStrictEqual(value, was)) continue;
    if (!isPlainObject(value) || !isPlainObject(was)) {
      target[key] = value;
      continue;
    }
    const existing = target[key];
    if (existing !== undefined && !isPlainObject(existing)) {
      target[key] = value;
      continue;
    }
    const part = existing ?? {};
    applyEdit(part, was, value);
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
): Record<string, unknown> {
  // A first write keeps the established full-default scaffold. Besides being
  // useful to a new user, the add -> rejected-install -> remove lifecycle
  // relies on that symmetry to return a pristine install to DEFAULT_CONFIG.
  if (document === undefined) return next;

  // Keys stay in their authored order and new ones follow in `next` order: the
  // add -> remove lifecycle writes the same logical object twice and must come
  // back byte for byte.
  const body = structuredClone(document);
  applyEdit(body, current, next);
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
 * What `akm migrate apply` persists: the file read as the current shape
 * (the retired `engines` form converted, the schema's own normalizations), only
 * the changed-or-already-local fields.
 */
function configWriteBody(
  localRaw: Record<string, unknown> | undefined,
  current: AkmConfig,
  next: AkmConfig,
  persistTopLevelKeys: readonly (keyof AkmConfig)[] = [],
): AkmConfig {
  // A first write keeps the established full-default scaffold. Besides being
  // useful to a new user, the add -> rejected-install -> remove lifecycle
  // relies on that symmetry to return a pristine install to DEFAULT_CONFIG.
  if (localRaw === undefined) return next;

  const pruned = pruneUnchangedInheritedFields(current, next, localRaw) as Record<string, unknown>;
  // A caller may need to persist an explicit user choice even when it equals
  // the schema default. Interactive setup uses this for semanticSearchMode:
  // "off" means the user declined the opt-in, not an incidental default that
  // should disappear from the saved configuration.
  for (const key of persistTopLevelKeys) {
    if (Object.hasOwn(next, key)) pruned[key] = next[key];
  }
  pruned.configVersion = CURRENT_CONFIG_VERSION;

  // Keep existing top-level keys in their authored order. Lifecycle rollback
  // writes the same logical object twice (add, then remove); reordering those
  // surviving keys would violate its byte-parity guarantee even though the
  // parsed JSON is equivalent. Newly changed keys follow in `next` order,
  // while nested maps (notably `bundles`) retain mutation-selected ordering.
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(localRaw)) {
    if (Object.hasOwn(pruned, key)) ordered[key] = pruned[key];
  }
  for (const [key, value] of Object.entries(pruned)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  }
  return ordered as AkmConfig;
}

export interface ConfigFileNormalization {
  /** Top-level keys whose stored shape differs from the current one. */
  readonly keys: readonly string[];
  readonly changed: boolean;
  readonly applied: boolean;
  readonly backupPath?: string;
}

/**
 * The migrator's one config step. The reader already tolerates every shape
 * 0.9.15 and later wrote (`configVersion` read as current, 0.9.16
 * `{kind, ref, sourceId}` scheduler entries, unknown keys dropped); this
 * writes that current shape back to `config.json` — the same body `mutateConfig` writes — so the tolerance
 * becomes durable. Reports without writing unless `apply` is set.
 */
export function normalizeConfigFile(configPath: string, options: { apply: boolean }): ConfigFileNormalization {
  return withConfigLock(() => {
    const text = readConfigText(configPath);
    if (text === undefined) return { keys: [], changed: false, applied: false };
    const raw = parseConfigText(text, configPath);
    // The retired-engines conversion (`readRetiredEngines`) runs inside this
    // pipeline, so it has already happened by the time the unknown-key sweep
    // below deletes what the schema does not know.
    const localRaw = runConfigFilePipeline(text, configPath);
    const current = buildEffectiveConfig(localRaw, configPath);
    const next = validateCompleteConfig({ ...current, configVersion: CURRENT_CONFIG_VERSION });
    const body = configWriteBody(localRaw, current, next) as Record<string, unknown>;
    for (const keyPath of unknownConfigKeyPaths(body)) deleteConfigPath(body, keyPath);
    // `improve.strategies["graph-refresh"]` is schema-valid (any name is a
    // legal custom-strategy key), so it never reaches the unknown-key sweep
    // above. It can only be a leftover override of the deleted graph-refresh
    // built-in (0.9.17-alpha.9) — resolveImproveStrategy now refuses that
    // name unconditionally, so the override can never apply again. Drop it
    // the same way any other retired key is dropped: only by `akm migrate
    // apply`, never by an ordinary write.
    const strategies = (body.improve as Record<string, unknown> | undefined)?.strategies as
      | Record<string, unknown>
      | undefined;
    if (strategies && Object.hasOwn(strategies, "graph-refresh")) delete strategies["graph-refresh"];
    const keys = [...new Set([...Object.keys(raw), ...Object.keys(body)])]
      .filter((key) => JSON.stringify(raw[key]) !== JSON.stringify(body[key]))
      .sort();
    if (keys.length === 0 || !options.apply) return { keys, changed: keys.length > 0, applied: false };
    const backup = backupExistingConfig(configPath);
    writeConfigAtomic(configPath, body);
    cachedConfig = undefined;
    return { keys, changed: true, applied: true, ...(backup ? { backupPath: backup.timestamped } : {}) };
  });
}

/**
 * Mutate config under one fail-closed lock spanning read, merge, validation,
 * ordinary backup, and atomic write.
 */
export function mutateConfig(
  mutate: (current: AkmConfig) => AkmConfig,
  options?: { absentNoop?: boolean },
): ConfigMutationResult {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  return withConfigLock(() => {
    const text = readConfigText(configPath);
    if (text === undefined && options?.absentNoop) {
      return { config: { ...DEFAULT_CONFIG }, written: false };
    }
    const document = text === undefined ? undefined : readConfigFile(text, configPath);
    const localRaw = document === undefined ? undefined : readRetiredEngines(document, configPath);
    const current =
      localRaw === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : buildEffectiveConfig(localRaw, configPath);
    const mutated = mutate(current);
    if (mutated === current) return { config: current, written: false };
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    if (text !== undefined) backupExistingConfig(configPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(editedConfigFile(document, current, next) as AkmConfig));
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
    const localRaw = document === undefined ? undefined : readRetiredEngines(document, configPath);
    const current =
      localRaw === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : buildEffectiveConfig(localRaw, configPath);
    const mutated = mutate(current);
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    if (text !== undefined) backupExistingConfig(configPath);
    const precommitResult = await precommit(next);
    if (mutated === current) return { config: current, written: false, precommit: precommitResult };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(
      configPath,
      sanitizeConfigForWrite(editedConfigFile(document, current, next, options?.persistTopLevelKeys) as AkmConfig),
    );
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
