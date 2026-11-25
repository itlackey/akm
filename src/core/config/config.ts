// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { deriveBundleId } from "../bundle-id";
import { isRecord, resolveStashDir } from "../common";
import { ConfigError, UsageError } from "../errors";
import { substituteRefTokens } from "../ref-token";
import { formatRegistryLabel, hasRegistryUrlCredentials } from "../registry-url";
import { hasRawPath, resolveExtendsChain } from "./config-extends";
import {
  dropRetiredOutputFormat,
  isPlainConfigObject,
  readConfigFile,
  readRetiredForms,
  runConfigFilePipeline,
  unknownConfigKeyPaths,
  warnUnknownConfigKeys,
  withoutModelsOverlay,
} from "./config-file-forms";
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
  bundleContentRoots,
  bundleOverlaps,
  bundleSourceId,
  bundlesToSourceEntries,
  filesystemBundleSourceId,
  isBundleEnabled,
} from "./config-sources";
import type {
  AkmConfig,
  ConnectionConfig,
  HarnessConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
} from "./config-types";
import { convertBundleComponents } from "./convert-bundle-components";
import { convertEngineConfig, type EngineTarget } from "./convert-engines";
import { fileFlatCredentials, writeCredential } from "./credentials";
import { deepMergeConfig, isPlainObject } from "./deep-merge";
import { warnDeprecatedConfigKeys } from "./deprecated-keys";
import { REMOVED_IMPROVE_STRATEGY_NAMES } from "./engine-semantics";
import { readLearningAliases } from "./learning-aliases";
import { documentEndpoint, planKeyMoves } from "./migrate-keys";
import { modelsFileExists, readModelsFile, retireModelsFile } from "./models-file";
import { rememberEngineTargets } from "./retired-engines";
import { dropUnusableProjects } from "./schema/projects";
import { dropUnusableEntries, findUnusableEntries, type UnusableEntry } from "./unusable-entries";

export { stripJsonComments } from "./config-io";

import { getConfigPath } from "../paths";
import { warn, warnOnce, withWarningsSuppressed } from "../warn";

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
 * {@link inheritedConnectionsOf} the config as it is on this host, loaded here when the cache holds
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

  const lifted = runConfigFilePipeline(text, configPath);
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
 * The connections and harnesses an `extends` base defines on its own, without the
 * models.json overlay the loader folds into them: what the migrator folds into
 * entries only the base defines, as partial local entries, once the file is gone.
 */
function inheritedEntries(
  document: Record<string, unknown>,
  configPath: string,
): { connections: Record<string, unknown>; harnesses: Record<string, unknown> } | undefined {
  if (document.extends === undefined) return undefined;
  return withoutModelsOverlay(() => {
    const base = buildEffectiveConfig({ configVersion: document.configVersion, extends: document.extends }, configPath);
    return { connections: { ...base.connections }, harnesses: { ...base.harnesses } };
  });
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
  const chained = readLearningAliases(
    dropRetiredOutputFormat(
      dropUnusableProjects(
        dropUnusableEntries(
          resolveExtendsChain(dropUnusableProjects(liftedLocalRaw, sourcePath), sourcePath),
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
  // Deprecated in 0.10.261120, removed in 0.11. The base files' own `extends` are not reported separately.
  if (liftedLocalRaw.extends !== undefined) {
    warnOnce(
      "config:extends-deprecated",
      `\`extends\` is Deprecated and is removed in 0.11: copy the inherited settings into this config file${sourcePath ? ` (${sourcePath})` : ""}; \`akm config get <key> --show-source\` shows which come from the base.`,
    );
  }
  warnDeprecatedConfigKeys(liftedLocalRaw, sourcePath);
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

function deleteConfigPath(node: Record<string, unknown>, keyPath: readonly string[]): void {
  let cursor: unknown = node;
  for (const segment of keyPath.slice(0, -1)) {
    if (!isPlainConfigObject(cursor)) return;
    cursor = cursor[segment];
  }
  if (isPlainConfigObject(cursor)) delete cursor[keyPath[keyPath.length - 1] as string];
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
 * none called `default`. The phrase (no final period) names the fix. Undefined when every kind that is configured has a default.
 */
export function ambiguousDefaultAdvice(config: AkmConfig): string | undefined {
  const advice = (["connection", "harness"] as const).flatMap((kind) => {
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

/**
 * The effective config. `warn: false` is for a read nobody asked for (a background check): it emits no warning, takes
 * no part in the once-per-process warning bookkeeping and leaves the config cache as it found it, so the command's
 * own load still warns.
 */
export function loadConfig(options?: { warn?: boolean }): AkmConfig {
  if (options?.warn !== false) return loadUserConfig();
  const cached = cachedConfig;
  try {
    return withWarningsSuppressed(loadUserConfig);
  } finally {
    cachedConfig = cached;
  }
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

/**
 * Validate a config about to be written. With `current` (the config on disk) a bundle that overlaps another (equal,
 * inside or containing) and did not overlap it in `current` is refused: a write may not add an overlap, though a
 * config that already has one keeps loading and can be written.
 */
export function validateCompleteConfig(config: AkmConfig, current?: AkmConfig): AkmConfig {
  const parseResult = AkmConfigSchema.safeParse(config);
  if (parseResult.success) {
    if (current) assertNoNewBundleOverlap(parseResult.data, current);
    return parseResult.data;
  }
  const lines = parseResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  throw new ConfigError(
    `Refusing to save invalid config:\n${lines}`,
    "INVALID_CONFIG_FILE",
    "Fix the listed fields, or undo the offending `akm config set`. " +
      "If this looks like an akm bug, re-run with --debug to attach the traceback.",
  );
}

function assertNoNewBundleOverlap(next: AkmConfig, current: AkmConfig): void {
  // An existing overlap is told by its two roots and kind, not bundle ids: renaming a bundle of an existing pair
  // keeps the pair. Counted, so a second bundle at the same roots is still a new overlap.
  const keyOf = (overlap: { roots: readonly string[]; kind: string }) =>
    `${[...overlap.roots].sort().join("\0")}|${overlap.kind}`;
  const present = new Map<string, number>();
  for (const overlap of bundleOverlaps(current)) present.set(keyOf(overlap), (present.get(keyOf(overlap)) ?? 0) + 1);
  for (const overlap of bundleOverlaps(next)) {
    const left = present.get(keyOf(overlap)) ?? 0;
    if (left > 0) {
      present.set(keyOf(overlap), left - 1);
      continue;
    }
    const [first, second] = overlap.bundles;
    const [firstRoot, secondRoot] = overlap.roots;
    const [inner, outer] = overlap.inner === first ? [first, second] : [second, first];
    const [innerRoot, outerRoot] = overlap.inner === first ? [firstRoot, secondRoot] : [secondRoot, firstRoot];
    const what =
      overlap.kind === "same"
        ? `bundles ${JSON.stringify(first)} and ${JSON.stringify(second)} have the same content root ${firstRoot}`
        : `bundle ${JSON.stringify(inner)} is inside bundle ${JSON.stringify(outer)} (${innerRoot} is inside ${outerRoot})`;
    throw new ConfigError(
      `Refusing to save config: ${what}.`,
      "INVALID_CONFIG_FILE",
      "Bundles that overlap share files, and the index files each shared file under the bundle configured first. Add the directory only once, or keep the directories apart " +
        "(a wiki folder inside a bundle becomes its own bundle once moved out). A symbolic-link alias of a bundle's " +
        "directory is not a separate bundle.",
    );
  }
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
 * `mutateConfig` must not write the entire extends-merged *effective* config
 * (`next`) back to the local file on every `config set`/`unset`: that would
 * duplicate every inherited `connections`/`improve.strategies`
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
 * inserted one (`bundles`); the top level keeps the file's authored order. A
 * removal of a key the document does not hold is left undone and recorded in
 * `unremoved`, with the path of the key. A `projects` entry is one value, as an array is.
 */
function applyEdit(
  target: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  unremoved: string[][] = [],
  at: readonly string[] = [],
): void {
  for (const key of Object.keys(before)) {
    if (Object.hasOwn(after, key)) continue;
    if (Object.hasOwn(target, key)) delete target[key];
    else unremoved.push([...at, key]);
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
    applyEdit(part, isPlainObject(was) ? was : {}, value, unremoved, [...at, key]);
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
  unremoved: string[][] = [],
  writeProjects: readonly string[] = [],
): Record<string, unknown> {
  // A first write keeps the established full-default scaffold. Besides being
  // useful to a new user, the add -> rejected-install -> remove lifecycle
  // relies on that symmetry to return a pristine install to DEFAULT_CONFIG.
  if (document === undefined) return next;

  // Keys stay in their authored order and new ones follow in `next` order: the
  // add -> remove lifecycle writes the same logical object twice and must come
  // back byte for byte.
  const body = structuredClone(document);
  applyEdit(body, current, next, unremoved);
  keepRetiredComponentWritable(body, next);
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
 * A bundle still in the retired `components` form keeps its `writable` there, and the reader takes that one over the
 * bundle's own: an edit to the bundle's `writable` has to reach it, or the next read gives the old value back.
 */
function keepRetiredComponentWritable(body: Record<string, unknown>, next: AkmConfig): void {
  if (!isPlainObject(body.bundles)) return;
  for (const [name, entry] of Object.entries(body.bundles)) {
    const writable = next.bundles?.[name]?.writable;
    if (writable === undefined || !isPlainObject(entry) || !isPlainObject(entry.components)) continue;
    for (const component of Object.values(entry.components)) {
      if (isPlainObject(component) && component.writable !== undefined) component.writable = writable;
    }
  }
}

/**
 * A file still in the retired `engines` form holds `engines` and `defaults`, not
 * the `connections`, `harnesses` and `improve` keys the reader makes of them, so
 * removing one of those is a change the file cannot take: the next load would
 * bring it back. Refuse it, once, until `akm migrate apply` has converted the file.
 */
function refuseRemovalFromRetiredForm(
  unremoved: readonly string[][],
  document: Record<string, unknown> | undefined,
  converted: Record<string, unknown> | undefined,
): void {
  const fromRetiredForm = unremoved.filter(
    (keyPath) => hasRawPath(converted, [...keyPath]) && !hasRawPath(document, [...keyPath]),
  );
  if (fromRetiredForm.length === 0) return;
  throw new UsageError(
    `Cannot remove ${fromRetiredForm.map((keyPath) => keyPath.join(".")).join(", ")}: it comes from a retired form (engines, bundles.<name>.components) or models.json, which this config.json still reads. ` +
      "Run `akm migrate apply` to convert the file, then repeat the change.",
  );
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

/**
 * The connection or harness that `key` (`connections.<name>[.…]`,
 * `harnesses.<name>[.…]`) is inside, when the reader drops it: this file holds it
 * and nothing, an `extends` base included, completes it. `akm config` cannot edit
 * an entry it cannot see. `inFile` says whether the file itself holds the entry
 * under that name, or it comes from the retired `engines` form.
 */
export function unusableEntryAt(
  key: string,
): (UnusableEntry & { group: "connections" | "harnesses"; inFile: boolean }) | undefined {
  const [group, name] = key.split(".");
  if (group !== "connections" && group !== "harnesses") return undefined;
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;
  const document = readConfigFile(text, configPath);
  const localRaw = readRetiredForms(document, configPath);
  const entry = findUnusableEntries(localRaw).find(
    (found) => found.name === name && found.kind === (group === "connections" ? "connection" : "harness"),
  );
  if (!entry || Object.hasOwn(buildEffectiveConfig(localRaw, configPath)[group] ?? {}, entry.name)) return undefined;
  return { ...entry, group, inFile: isRecord(document[group]) && Object.hasOwn(document[group], entry.name) };
}

export interface ConfigFileNormalization {
  /** Top-level keys whose stored shape differs from the current one. */
  readonly keys: readonly string[];
  readonly changed: boolean;
  readonly applied: boolean;
  readonly backupPath?: string;
  /** The `credentials.json` entries the config's keys move to (names only), when any do. */
  readonly credentials?: readonly string[];
  /** Where `credentials.json` was copied to before its older entries were filed, when any were. */
  readonly credentialsBackupPath?: string;
  /** Where the retired `models.json` was moved to, after its aliases were folded in. */
  readonly modelsFileBackupPath?: string;
  /** What each engine of the retired `engines` form became, for the step that rewrites assets' `engine:` keys. */
  readonly engineTargets?: Readonly<Record<string, EngineTarget>>;
  /** What the conversion could not carry, and each key and entry the step left alone or moved. */
  readonly notes?: readonly string[];
}

/** What `akm migrate apply` needs from outside the config module to read a key the config holds as a secret reference. */
export interface NormalizeConfigOptions {
  readonly apply: boolean;
  readonly resolveFromStore?: SecretStoreResolver;
}

/**
 * A connection or harness the reader drops stays in the file exactly as written,
 * with a note on what to fix. One this file only half says, which an `extends`
 * base completes, is not dropped (it is in `current`) and gets no note.
 */
function keepUnusableEntries(
  body: Record<string, unknown>,
  localRaw: Record<string, unknown>,
  current: AkmConfig,
  notes: string[],
): void {
  for (const { kind, name, why } of findUnusableEntries(localRaw)) {
    const holder = kind === "connection" ? "connections" : "harnesses";
    if (Object.hasOwn(current[holder] ?? {}, name)) continue;
    const entries = isRecord(body[holder]) ? (body[holder] as Record<string, unknown>) : {};
    body[holder] = { ...entries, [name]: (localRaw[holder] as Record<string, unknown>)[name] };
    notes.push(`${holder}.${name}: kept as written, and ignored by akm because ${why}. Fix it, or remove it.`);
  }
}

/**
 * The migrator's one config step. The reader already tolerates every shape
 * 0.9.15 and later wrote (`configVersion` read as current, 0.9.16
 * `{kind, ref, sourceId}` scheduler entries, unknown keys dropped); this
 * writes the current shape back to `config.json` so the tolerance becomes
 * durable: the retired `engines` form converted to `connections` / `harnesses`,
 * every key akm no longer reads from config filed in `credentials.json`
 * ({@link planKeyMoves}), and a connection or harness the reader drops kept as
 * written. Reports without writing unless `apply` is set.
 */
export function normalizeConfigFile(configPath: string, options: NormalizeConfigOptions): ConfigFileNormalization {
  const normalize = (): ConfigFileNormalization => {
    const text = readConfigText(configPath);
    if (text === undefined) return { keys: [], changed: false, applied: false };
    const raw = parseConfigText(text, configPath);
    const document = readConfigFile(text, configPath);
    // The conversion runs before the unknown-key sweep below deletes what the
    // schema does not know (inventory surprise 8).
    const overlay = readModelsFile();
    const inherited = overlay === undefined ? undefined : inheritedEntries(document, configPath);
    const converted = convertEngineConfig(document, {
      modelsOverlay: overlay,
      env: process.env,
      ...(inherited ? { inherited } : {}),
    });
    const plan = planKeyMoves(document, converted, {
      resolveSecretRef: (ref) => resolveSecret(ref, options.resolveFromStore),
    });
    const lifted = convertBundleComponents(plan.config);
    const localRaw = lifted.config;
    const current = buildEffectiveConfig(localRaw, configPath);
    const next = validateCompleteConfig({ ...current, configVersion: CURRENT_CONFIG_VERSION });
    const body = configWriteBody(localRaw, current, next) as Record<string, unknown>;
    for (const keyPath of unknownConfigKeyPaths(body)) deleteConfigPath(body, keyPath);
    // `improve.strategies["graph-refresh"]` is schema-valid (any name is a
    // legal custom-strategy key), so it never reaches the unknown-key sweep
    // above. It can only be a leftover override of the deleted graph-refresh
    // built-in — resolveImproveStrategy now refuses that
    // name unconditionally, so the override can never apply again. Drop it
    // the same way any other retired key is dropped: only by `akm migrate
    // apply`, never by an ordinary write.
    const strategies = (body.improve as Record<string, unknown> | undefined)?.strategies as
      | Record<string, unknown>
      | undefined;
    if (strategies && Object.hasOwn(strategies, "graph-refresh")) delete strategies["graph-refresh"];
    // A built-in strategy 0.10 removed cannot be selected, and nothing the person set makes it one again; the
    // default strategy applies in its place. A name the file defines under `improve.strategies` is theirs.
    const improveBody = body.improve as Record<string, unknown> | undefined;
    const removedStrategy = improveBody?.strategy;
    const dropsStrategy =
      typeof removedStrategy === "string" &&
      (removedStrategy === "graph-refresh" ||
        ((REMOVED_IMPROVE_STRATEGY_NAMES as readonly string[]).includes(removedStrategy) &&
          !(strategies && Object.hasOwn(strategies, removedStrategy))));
    if (dropsStrategy && improveBody) delete improveBody.strategy;
    // A key in the older flat form is filed only under an endpoint this file itself gives the block.
    const flat = fileFlatCredentials((slot) => documentEndpoint(plan.config, slot), false, plan.moves);
    const notes = [
      ...converted.notes,
      ...plan.notes,
      ...flat.notes,
      ...lifted.bundles.map(
        (name) => `bundles.${name}.components: its adapter, root and writable are now on the bundle itself.`,
      ),
    ];
    if (dropsStrategy)
      notes.push(
        `improve.strategy: "${removedStrategy}" was removed in 0.10, so it is dropped and the default strategy applies; name "default" or "consolidate", or define "${removedStrategy}" under improve.strategies.`,
      );
    keepUnusableEntries(body, localRaw, current, notes);
    const hasModelsFile = modelsFileExists();
    if (hasModelsFile) {
      notes.push(
        "models.json: its aliases are folded in where they name a configured connection or harness (the ones that do not are listed above), then the file moves to the config-backups directory.",
      );
    }
    const keys = [...new Set([...Object.keys(raw), ...Object.keys(body)])]
      .filter((key) => JSON.stringify(raw[key]) !== JSON.stringify(body[key]))
      .sort();
    const reported = {
      keys,
      ...(plan.moves.length > 0 || flat.filed.length > 0
        ? { credentials: [...plan.moves.map((move) => move.name), ...flat.filed] }
        : {}),
      ...(notes.length > 0 ? { notes } : {}),
      ...(Object.keys(converted.targets).length > 0 ? { engineTargets: converted.targets } : {}),
    };
    const changed = keys.length > 0 || hasModelsFile || flat.filed.length > 0;
    if (!changed || !options.apply) return { ...reported, changed, applied: false };
    let backup: ReturnType<typeof backupExistingConfig>;
    const credentialsBackupPath =
      flat.filed.length > 0
        ? fileFlatCredentials((slot) => documentEndpoint(plan.config, slot), true, plan.moves).backupPath
        : undefined;
    if (keys.length > 0) {
      // The keys are filed before the file that holds them is rewritten; a store
      // that cannot take them (malformed, unwritable) throws here and loses none.
      for (const move of plan.moves) writeCredential(move.slot, move.value, move.endpoint);
      // The old engine names outlive the file that had them, until the references to them are migrated.
      if (Object.keys(converted.targets).length > 0) rememberEngineTargets(converted.targets);
      backup = backupExistingConfig(configPath);
      writeConfigAtomic(configPath, body);
      cachedConfig = undefined;
    }
    const modelsFileBackupPath = hasModelsFile ? retireModelsFile() : undefined;
    return {
      ...reported,
      changed: true,
      applied: true,
      ...(backup ? { backupPath: backup.timestamped } : {}),
      ...(credentialsBackupPath ? { credentialsBackupPath } : {}),
      ...(modelsFileBackupPath ? { modelsFileBackupPath } : {}),
    };
  };
  // A read-only plan must not create the config directory just to take the write lock.
  return options.apply ? withConfigLock(normalize) : normalize();
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
    const localRaw = document === undefined ? undefined : readRetiredForms(document, configPath);
    const current =
      localRaw === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : buildEffectiveConfig(localRaw, configPath);
    const mutated = mutate(current);
    if (mutated === current) return { config: current, written: false };
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION }, current);
    const unremoved: string[][] = [];
    const body = editedConfigFile(document, current, next, [], unremoved, options?.writeProjects);
    refuseRemovalFromRetiredForm(unremoved, document, localRaw);
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
    const localRaw = document === undefined ? undefined : readRetiredForms(document, configPath);
    const current =
      localRaw === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : buildEffectiveConfig(localRaw, configPath);
    const mutated = mutate(current);
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION }, current);
    const unremoved: string[][] = [];
    const body = editedConfigFile(document, current, next, options?.persistTopLevelKeys, unremoved);
    if (mutated !== current) refuseRemovalFromRetiredForm(unremoved, document, localRaw);
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
 * The source identity a scheduler grant is bound to: the configured
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
        // An unset/empty $VAR would otherwise substitute silently, and a gateway
        // that enforces auth on inference (e.g. Bifrost) would fail every call with
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
  bundleAtDir,
  bundleContentRoot,
  bundleContentRoots,
  bundleEntryToSourceEntry,
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
