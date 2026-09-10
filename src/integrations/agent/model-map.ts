// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../core/common";
import type { EngineConfig } from "../../core/config/config-types";
import { ENGINE_NAME_PATTERN_SOURCE } from "../../core/config/engine-semantics";
import { ConfigError, UsageError } from "../../core/errors";
import { getConfigDir } from "../../core/paths";
import { warnOnce } from "../../core/warn";
import { cloneExecutionJsonObject, type ExecutionJsonObject, type ExecutionJsonValue } from "../../execution/json";

/**
 * Installed and operator-owned model intent aliases (#802 / WP2).
 *
 * The common cascade consumes this loader/expansion API for current runtime
 * execution callers. A recognized alias expands once into exact model and
 * inference defaults at its selecting layer; engine lowerers consume that
 * resolved request and never reinterpret the alias. The independent API also
 * remains usable by WP6/WP7 source and freeze adapters without hard-coding
 * provider mappings.
 */

export const MODEL_MAP_VERSION = 1 as const;

let standaloneInstalledModelMapText: string | undefined;

export interface ModelMapProfileLayer {
  readonly model?: string;
  readonly inference?: ExecutionJsonObject | null;
  /**
   * Indirection to a configured `engines.<name>` connection: borrow that
   * engine's own `model` (and, for an `llm`-kind engine, its inference
   * defaults) instead of hand-typing a literal model string here (#946).
   * Mutually exclusive with `model` at the same layer; resolved once at merge
   * time in {@link mergeModelMapLayers} so every downstream consumer keeps
   * seeing only a concrete `{ model, inference }` profile.
   */
  readonly engine?: string;
}

export type ModelMapEntryLayer = string | ModelMapProfileLayer;
export type ModelMapEngineLayer = Readonly<Record<string, ModelMapEntryLayer>>;

export interface ModelMapLayerV1 {
  readonly version: typeof MODEL_MAP_VERSION;
  readonly aliases: Readonly<Record<string, ModelMapEngineLayer>>;
}

export interface ResolvedModelMapProfile {
  readonly model: string;
  readonly inference?: ExecutionJsonObject | null;
}

export interface ResolvedModelMapV1 {
  readonly version: typeof MODEL_MAP_VERSION;
  readonly aliases: Readonly<Record<string, Readonly<Record<string, ResolvedModelMapProfile>>>>;
}

export interface ResolvedModelMapSelection {
  readonly input: string;
  readonly interpretation: "alias" | "exact";
  readonly model: string;
  readonly inference?: ExecutionJsonObject | null;
  readonly unmappedForEngine?: true;
}

const ENGINE_KEY_PATTERN = new RegExp(ENGINE_NAME_PATTERN_SOURCE);
const ALIAS_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_MAP_KEYS = new Set(["__proto__", "constructor", "prototype", "tostring"]);

function assertSafeMapKey(key: string, source: string, jsonPath: string): void {
  if (RESERVED_MAP_KEYS.has(key.toLowerCase())) {
    invalid(source, jsonPath, "reserved prototype-like key is not allowed");
  }
}

function invalid(source: string, jsonPath: string, detail: string): never {
  throw new ConfigError(
    `Invalid ${source} at ${jsonPath}: ${detail}`,
    "INVALID_CONFIG_FILE",
    `Fix ${source}, or remove the optional user models.json to use AKM's installed defaults.`,
  );
}

function requireRecord(value: unknown, source: string, jsonPath: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(source, jsonPath, "expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
  jsonPath: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid(source, `${jsonPath}.${key}`, "unknown field");
  }
}

function requireNonemptyString(value: unknown, source: string, jsonPath: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid(source, jsonPath, "expected a nonempty string without surrounding whitespace");
  }
  return value;
}

function freezeRecord<T>(entries: Iterable<readonly [string, T]>): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return Object.freeze(record);
}

function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseProfileLayer(value: unknown, source: string, jsonPath: string): ModelMapEntryLayer {
  if (typeof value === "string") return requireNonemptyString(value, source, jsonPath);
  const record = requireRecord(value, source, jsonPath);
  assertOnlyKeys(record, ["model", "inference", "engine"], source, jsonPath);
  if (!Object.hasOwn(record, "model") && !Object.hasOwn(record, "inference") && !Object.hasOwn(record, "engine")) {
    invalid(source, jsonPath, "structured profile must contain model, inference, and/or engine");
  }
  if (Object.hasOwn(record, "model") && Object.hasOwn(record, "engine")) {
    invalid(source, jsonPath, "model and engine cannot both be set; engine is an indirection for the model value");
  }
  const out: { model?: string; inference?: ExecutionJsonObject | null; engine?: string } = {};
  if (Object.hasOwn(record, "model")) out.model = requireNonemptyString(record.model, source, `${jsonPath}.model`);
  if (Object.hasOwn(record, "engine")) {
    const rawEngine = requireNonemptyString(record.engine, source, `${jsonPath}.engine`);
    const engine = rawEngine.toLowerCase();
    assertSafeMapKey(engine, source, `${jsonPath}.engine`);
    if (!ENGINE_KEY_PATTERN.test(engine)) {
      invalid(source, `${jsonPath}.engine`, "engine reference must be lowercase kebab-case");
    }
    out.engine = engine;
  }
  if (Object.hasOwn(record, "inference")) {
    if (record.inference === null) out.inference = null;
    else {
      try {
        out.inference = cloneExecutionJsonObject(record.inference, `${source} ${jsonPath}.inference`);
      } catch (error) {
        invalid(source, `${jsonPath}.inference`, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return Object.freeze(out);
}

/** Parse one installed or user layer. Partial structured profiles are valid at this stage. */
export function parseModelMapLayer(text: string, source: string): ModelMapLayerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid(source, "$", "invalid JSON syntax");
  }
  const root = requireRecord(parsed, source, "$");
  assertOnlyKeys(root, ["version", "aliases"], source, "$");
  if (root.version !== MODEL_MAP_VERSION) {
    invalid(source, "$.version", `expected version ${MODEL_MAP_VERSION}`);
  }
  if (!Object.hasOwn(root, "aliases")) invalid(source, "$.aliases", "required field is missing");
  const rawAliases = requireRecord(root.aliases, source, "$.aliases");
  const aliases: Array<readonly [string, ModelMapEngineLayer]> = [];
  const aliasesSeen = new Map<string, string>();
  for (const [rawAlias, rawEngines] of Object.entries(rawAliases)) {
    const alias = rawAlias.toLowerCase();
    assertSafeMapKey(alias, source, `$.aliases.${rawAlias}`);
    if (!ALIAS_KEY_PATTERN.test(alias)) invalid(source, `$.aliases.${rawAlias}`, "alias must be lowercase kebab-case");
    const previous = aliasesSeen.get(alias);
    if (previous !== undefined) {
      invalid(source, `$.aliases.${rawAlias}`, `alias collides case-insensitively with ${previous}`);
    }
    aliasesSeen.set(alias, rawAlias);
    const engineRecord = requireRecord(rawEngines, source, `$.aliases.${rawAlias}`);
    if (Object.keys(engineRecord).length === 0) {
      invalid(source, `$.aliases.${rawAlias}`, "alias must contain at least one engine mapping");
    }
    const engines: Array<readonly [string, ModelMapEntryLayer]> = [];
    const enginesSeen = new Map<string, string>();
    for (const [rawEngine, rawProfile] of Object.entries(engineRecord)) {
      const engine = rawEngine.toLowerCase();
      assertSafeMapKey(engine, source, `$.aliases.${rawAlias}.${rawEngine}`);
      if (!ENGINE_KEY_PATTERN.test(engine)) {
        invalid(source, `$.aliases.${rawAlias}.${rawEngine}`, "engine key must be lowercase kebab-case");
      }
      const previousEngine = enginesSeen.get(engine);
      if (previousEngine !== undefined) {
        invalid(
          source,
          `$.aliases.${rawAlias}.${rawEngine}`,
          `engine key collides case-insensitively with ${previousEngine}`,
        );
      }
      enginesSeen.set(engine, rawEngine);
      engines.push([engine, parseProfileLayer(rawProfile, source, `$.aliases.${rawAlias}.${rawEngine}`)]);
    }
    aliases.push([alias, freezeRecord(engines)]);
  }
  return Object.freeze({ version: MODEL_MAP_VERSION, aliases: freezeRecord(aliases) });
}

function isJsonObject(value: ExecutionJsonValue | undefined): value is ExecutionJsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function mergeJsonValue(base: ExecutionJsonValue | undefined, overlay: ExecutionJsonValue): ExecutionJsonValue {
  if (!isJsonObject(base) || !isJsonObject(overlay)) return overlay;
  const entries = new Map<string, ExecutionJsonValue>(Object.entries(base));
  for (const [key, value] of Object.entries(overlay)) entries.set(key, mergeJsonValue(entries.get(key), value));
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeLayerEntry(entry: ModelMapEntryLayer): ModelMapProfileLayer {
  return typeof entry === "string" ? Object.freeze({ model: entry }) : entry;
}

function mergeProfiles(base: ModelMapProfileLayer | undefined, overlay: ModelMapEntryLayer): ModelMapProfileLayer {
  const next = normalizeLayerEntry(overlay);
  const out: { model?: string; inference?: ExecutionJsonObject | null; engine?: string } = {};
  if (base?.model !== undefined) out.model = base.model;
  if (base?.engine !== undefined) out.engine = base.engine;
  if (base && Object.hasOwn(base, "inference")) out.inference = base.inference;
  // A literal `model` and an `engine` indirection are mutually exclusive within
  // one layer (enforced at parse time); across layers, whichever the nearer
  // layer sets replaces the other so the merged profile keeps that invariant.
  if (next.model !== undefined) {
    out.model = next.model;
    delete out.engine;
  }
  if (next.engine !== undefined) {
    out.engine = next.engine;
    delete out.model;
  }
  if (Object.hasOwn(next, "inference")) {
    out.inference =
      next.inference !== null && next.inference !== undefined && isJsonObject(base?.inference)
        ? (mergeJsonValue(base.inference, next.inference) as ExecutionJsonObject)
        : next.inference;
  }
  return Object.freeze(out);
}

export interface EngineModelAndInference {
  readonly model?: string;
  readonly inference?: ExecutionJsonObject;
}

/**
 * Derive the `{ model, inference }` a model-map profile borrows from a
 * configured engine (#946). Shared verbatim by
 * `execution-definitions.ts`'s own execution-defaults derivation
 * (`engineDefaults`) so the two paths cannot silently diverge. `model` is
 * copied verbatim from the engine's own config value; it must already be
 * meaningful for the model-map column's platform (akm does not translate
 * between an engine's connection and an agent platform's own provider
 * registry). Only `kind: "llm"` engines contribute inference defaults — an
 * agent-kind engine's schema carries no temperature/thinking fields.
 */
export function engineModelAndInference(engine: EngineConfig): EngineModelAndInference {
  const out: { model?: string; inference?: ExecutionJsonObject } = {};
  if (Object.hasOwn(engine, "model") && engine.model !== undefined) out.model = engine.model;
  if (engine.kind === "llm") {
    const inference: Record<string, unknown> = {};
    if (Object.hasOwn(engine, "temperature")) inference.temperature = engine.temperature;
    if (Object.hasOwn(engine, "maxTokens")) inference.maxTokens = engine.maxTokens;
    if (Object.hasOwn(engine, "supportsJsonSchema")) inference.supportsJsonSchema = engine.supportsJsonSchema;
    if (Object.hasOwn(engine, "extraParams")) inference.extraParams = engine.extraParams;
    if (Object.hasOwn(engine, "contextLength")) inference.contextLength = engine.contextLength;
    if (Object.hasOwn(engine, "enableThinking")) inference.enableThinking = engine.enableThinking;
    if (Object.hasOwn(engine, "reasoningEffort")) inference.reasoningEffort = engine.reasoningEffort;
    if (Object.keys(inference).length > 0) out.inference = inference as ExecutionJsonObject;
  }
  return Object.freeze(out);
}

/** Overlay user fields over installed fields, per (alias, column), without resolving `engine` indirection. */
function mergeRawProfileLayers(
  installed: ModelMapLayerV1,
  user?: ModelMapLayerV1,
): Map<string, Map<string, ModelMapProfileLayer>> {
  const aliases = new Map<string, Map<string, ModelMapProfileLayer>>();
  const apply = (layer: ModelMapLayerV1): void => {
    for (const [alias, layerEngines] of Object.entries(layer.aliases)) {
      const mergedEngines = aliases.get(alias) ?? new Map<string, ModelMapProfileLayer>();
      for (const [engineKey, profile] of Object.entries(layerEngines)) {
        mergedEngines.set(engineKey, mergeProfiles(mergedEngines.get(engineKey), profile));
      }
      aliases.set(alias, mergedEngines);
    }
  };
  apply(installed);
  if (user) apply(user);
  return aliases;
}

/**
 * The overlaid-but-unresolved profile per (alias, column), before any
 * `engine` indirection is expanded. `akm models list` (#946) uses this to
 * report whether a column resolves through a literal `model` or an `engine`
 * reference — information {@link mergeModelMapLayers} collapses away once it
 * performs the final resolution.
 */
export function mergedModelMapProfiles(
  installed: ModelMapLayerV1,
  user?: ModelMapLayerV1,
): Readonly<Record<string, Readonly<Record<string, ModelMapProfileLayer>>>> {
  const aliases = mergeRawProfileLayers(installed, user);
  const out: Array<readonly [string, Readonly<Record<string, ModelMapProfileLayer>>]> = [];
  for (const [alias, engineProfiles] of aliases) out.push([alias, freezeRecord(engineProfiles)]);
  return freezeRecord(out);
}

/**
 * Overlay user fields over installed fields, resolve any `engine` indirection
 * against configured engines, then enforce usable merged profiles.
 */
export function mergeModelMapLayers(
  installed: ModelMapLayerV1,
  user?: ModelMapLayerV1,
  engines?: Readonly<Record<string, EngineConfig>>,
): ResolvedModelMapV1 {
  const aliases = mergeRawProfileLayers(installed, user);

  const resolvedAliases: Array<readonly [string, Readonly<Record<string, ResolvedModelMapProfile>>]> = [];
  for (const [alias, engineProfiles] of aliases) {
    const resolvedEngines: Array<readonly [string, ResolvedModelMapProfile]> = [];
    for (const [engineKey, profile] of engineProfiles) {
      let model = profile.model;
      let inference = Object.hasOwn(profile, "inference") ? profile.inference : undefined;
      if (model === undefined && profile.engine !== undefined) {
        const target = ownValue(engines, profile.engine);
        if (target === undefined) {
          invalid(
            "merged models.json",
            `$.aliases.${alias}.${engineKey}.engine`,
            `references unknown engine ${JSON.stringify(profile.engine)}; a usable model is required after overlay`,
          );
        }
        const expansion = engineModelAndInference(target);
        if (expansion.model === undefined) {
          invalid(
            "merged models.json",
            `$.aliases.${alias}.${engineKey}.engine`,
            `engine ${JSON.stringify(profile.engine)} has no usable model; a usable model is required after overlay`,
          );
        }
        model = expansion.model;
        inference =
          inference === undefined
            ? expansion.inference
            : inference !== null && isJsonObject(expansion.inference)
              ? (mergeJsonValue(expansion.inference, inference) as ExecutionJsonObject)
              : inference;
      }
      if (model === undefined) {
        invalid(
          "merged models.json",
          `$.aliases.${alias}.${engineKey}.model`,
          "a usable model is required after overlay",
        );
      }
      resolvedEngines.push([engineKey, Object.freeze(inference !== undefined ? { model, inference } : { model })]);
    }
    resolvedAliases.push([alias, freezeRecord(resolvedEngines)]);
  }
  return Object.freeze({ version: MODEL_MAP_VERSION, aliases: freezeRecord(resolvedAliases) });
}

function selectionFromProfile(
  input: string,
  profile: ResolvedModelMapProfile | ModelMapProfileLayer,
): ResolvedModelMapSelection {
  if (!profile.model) throw new ConfigError(`Model alias ${JSON.stringify(input)} does not resolve to a usable model.`);
  return Object.freeze({
    input,
    interpretation: "alias" as const,
    model: profile.model,
    ...(Object.hasOwn(profile, "inference") ? { inference: profile.inference } : {}),
  });
}

/** Resolve one alias through the merged installed/user registry. */
export function resolveModelMapAlias(
  input: string,
  engine: string,
  map: ResolvedModelMapV1,
): ResolvedModelMapSelection {
  const alias = input.toLowerCase();
  const selectedEngine = engine.toLowerCase();
  const tier = ownValue(map.aliases, alias);
  const profile = ownValue(tier, selectedEngine);
  if (profile !== undefined) return selectionFromProfile(input, profile);

  const knownAliasUnmappedForEngine = tier !== undefined;
  if (knownAliasUnmappedForEngine) {
    warnOnce(
      `model-map-alias-no-engine-mapping:${alias}:${selectedEngine}`,
      `[akm] Model alias ${JSON.stringify(input)} has no mapping for engine ${JSON.stringify(engine)}; using ${JSON.stringify(input)} as the literal model name. Add $.aliases.${alias}.${engine} to models.json to map it.`,
    );
  }
  return Object.freeze({
    input,
    interpretation: "exact" as const,
    model: input,
    ...(knownAliasUnmappedForEngine ? { unmappedForEngine: true as const } : {}),
  });
}

export function userModelMapPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), "models.json");
}

export interface LoadModelMapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly installedText?: string;
  /** Configured engines an `engine`-backed profile may resolve against (#946). */
  readonly engines?: Readonly<Record<string, EngineConfig>>;
}

export interface LoadedModelMap {
  readonly map: ResolvedModelMapV1;
  readonly userPath: string;
  readonly userStatus: "absent" | "loaded";
}

function modelMapFileError(label: string, filePath: string, action: string): ConfigError {
  return new ConfigError(
    `${label} could not be ${action}: ${filePath}.`,
    "INVALID_CONFIG_FILE",
    `Ensure ${filePath} is a readable regular file owned by the expected user.`,
  );
}

/**
 * Read through a nonblocking, no-follow descriptor and enforce the config-size
 * ceiling before parsing. `optional` recognizes only a true lstat ENOENT as
 * absence; dangling links and every non-regular type are configuration errors.
 */
function readModelMapFile(filePath: string, label: string, optional: boolean): string | undefined {
  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(filePath);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw modelMapFileError(label, filePath, optional ? "inspected" : "found");
  }
  if (!targetStat.isFile()) {
    throw new ConfigError(
      `Unable to read ${label.toLowerCase()} because it is not a readable regular file: ${filePath}.`,
      "INVALID_CONFIG_FILE",
      "Replace it with a readable regular models.json file, or a symlink to one.",
    );
  }

  const nonblock =
    process.platform !== "win32" && typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | nonblock);
    const openedStat = fs.fstatSync(fd);
    if (!sameFileIdentity(targetStat, openedStat)) {
      throw new ConfigError(
        `${label} changed while it was being opened: ${filePath}.`,
        "INVALID_CONFIG_FILE",
        "Retry after ensuring no other process is replacing models.json.",
      );
    }
    const text = fs.readFileSync(fd, "utf8");
    fs.closeSync(fd);
    fd = undefined;
    return text;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw modelMapFileError(label, filePath, "read");
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The actionable read error above remains authoritative.
      }
    }
  }
}

/** Resolve the one authoritative external-asset location for this runtime. */
export function installedModelMapPaths(moduleUrl = import.meta.url): readonly string[] {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDirectory = path.dirname(modulePath);
  const unbundledModule =
    path.basename(moduleDirectory) === "agent" && path.basename(path.dirname(moduleDirectory)) === "integrations";
  const assetPath = path.resolve(moduleDirectory, unbundledModule ? "../../assets/models.json" : "assets/models.json");
  return Object.freeze([assetPath]);
}

/**
 * Standalone bootstrap only. `scripts/akm-standalone.ts` derives these bytes
 * from the authoritative JSON import that Bun embeds into the executable.
 */
export function registerStandaloneModelMapFallback(text: string): void {
  standaloneInstalledModelMapText = text;
}

/** Load installed bytes lazily so health can report a missing/bad package asset. */
export function readInstalledModelMapText(options: LoadModelMapOptions = {}): string {
  if (options.installedText !== undefined) return options.installedText;
  // Registration occurs only in the compiled standalone bootstrap. Once set,
  // the embedded authority must win over any mutable file beside the binary.
  if (standaloneInstalledModelMapText !== undefined) return standaloneInstalledModelMapText;
  const candidates = installedModelMapPaths();
  for (const candidate of candidates) {
    const external = readModelMapFile(candidate, "Installed models.json", true);
    if (external !== undefined) return external;
  }
  throw new ConfigError(
    `Installed models.json is missing from this AKM installation (checked: ${candidates.join(", ")}).`,
    "INVALID_CONFIG_FILE",
    "Reinstall AKM so its dist/assets/models.json package asset is restored.",
  );
}

export interface LoadedModelMapLayers {
  readonly installed: ModelMapLayerV1;
  readonly user?: ModelMapLayerV1;
  readonly userPath: string;
  readonly userStatus: "absent" | "loaded";
}

/** Read and parse the installed authority plus the optional operator overlay, without resolving them. */
export function loadModelMapLayers(options: LoadModelMapOptions = {}): LoadedModelMapLayers {
  const installed = parseModelMapLayer(readInstalledModelMapText(options), "installed models.json");
  const userPath = userModelMapPath(options.env);
  const userText = readModelMapFile(userPath, "User models.json", true);
  const user = userText !== undefined ? parseModelMapLayer(userText, `user models.json (${userPath})`) : undefined;
  return Object.freeze({ installed, ...(user ? { user } : {}), userPath, userStatus: user ? "loaded" : "absent" });
}

/** Load the installed authority plus the optional operator overlay. */
export function loadModelMap(options: LoadModelMapOptions = {}): LoadedModelMap {
  const { installed, user, userPath, userStatus } = loadModelMapLayers(options);
  return Object.freeze({ map: mergeModelMapLayers(installed, user, options.engines), userPath, userStatus });
}

export interface CopyDefaultModelMapOptions extends LoadModelMapOptions {
  readonly overwrite?: boolean;
}

export interface CopyDefaultModelMapResult {
  readonly path: string;
  readonly copied: true;
  readonly overwritten: boolean;
}

function targetExistsError(target: string, detail: string): UsageError {
  return new UsageError(
    `${detail}: ${target}`,
    "RESOURCE_ALREADY_EXISTS",
    "Move the existing target aside, then retry. Use --overwrite only for a stable regular file you intend to replace.",
  );
}

function copyIoError(target: string, action: string, hint?: string): ConfigError {
  return new ConfigError(
    `Unable to ${action} user models.json at ${target}.`,
    "INVALID_CONFIG_FILE",
    hint ?? "Check the configuration directory ownership and permissions, then retry.",
  );
}

function inspectCopyTarget(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw copyIoError(target, "inspect");
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (!left.isFile() || !right.isFile()) return false;
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function syncCopyDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // A preceding sync/open failure is more useful than a cleanup failure.
      }
    }
  }
}

function stageDefaultModelMap(target: string, text: string): string {
  const stage = `${target}.copy.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileAtomic(stage, text, 0o600);
    return stage;
  } catch {
    throw copyIoError(target, "write a staged copy of");
  }
}

/** Explicitly copy validated installed bytes into the normal config directory. */
export function copyDefaultModelMap(options: CopyDefaultModelMapOptions = {}): CopyDefaultModelMapResult {
  const text = readInstalledModelMapText(options);
  mergeModelMapLayers(parseModelMapLayer(text, "installed models.json"));
  const target = userModelMapPath(options.env);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    throw copyIoError(target, "create the configuration directory for");
  }
  const existing = inspectCopyTarget(target);
  if (existing && !existing.isFile()) {
    throw targetExistsError(target, "Refusing to replace a non-regular models.json target");
  }
  if (existing && options.overwrite !== true) {
    throw targetExistsError(target, "User models.json already exists");
  }

  const stage = stageDefaultModelMap(target, text);
  let stagePresent = true;
  try {
    if (existing === undefined) {
      try {
        // Hard-link publication is an atomic no-replace operation: EEXIST
        // means a racing creator won, and their bytes remain untouched.
        fs.linkSync(stage, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw targetExistsError(target, "User models.json was created while defaults were being prepared");
        }
        throw copyIoError(target, "publish");
      }
      try {
        fs.unlinkSync(stage);
        stagePresent = false;
      } catch {
        // The target was already published atomically. Cleanup is best-effort
        // from this point forward; `finally` retries without turning a
        // successful copy into a false failure.
      }
    } else {
      const current = inspectCopyTarget(target);
      if (!current || !sameFileIdentity(existing, current)) {
        throw targetExistsError(target, "User models.json changed while defaults were being prepared");
      }
      try {
        // rename replaces the directory entry itself; it never follows a
        // symlink inserted after the final identity check.
        fs.renameSync(stage, target);
        stagePresent = false;
      } catch {
        throw copyIoError(target, "replace");
      }
    }
  } finally {
    if (stagePresent) {
      try {
        fs.unlinkSync(stage);
      } catch {
        // Best-effort cleanup; the target was never published from this path.
      }
    }
  }
  try {
    syncCopyDirectory(path.dirname(target));
  } catch {
    throw copyIoError(
      target,
      "durably publish",
      `The target may already exist at ${target}; inspect it before retrying because directory durability could not be confirmed.`,
    );
  }
  return { path: target, copied: true as const, overwritten: existing !== undefined };
}
