// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors";
import { ensureMigrationBackupWithConfigLockHeld } from "../migration-backup";
import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  withConfigLock,
  writeConfigAtomic,
} from "./config-io";
import { AkmConfigSchema, CURRENT_CONFIG_VERSION } from "./config-schema";
import type {
  AkmConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  IndexConfig,
  IndexPassConfig,
  LlmConnectionConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
} from "./config-types";
import { deepMergeConfig } from "./deep-merge";

export { stripJsonComments } from "./config-io";

import { materializeLlmConnection, resolveLlmEngineUse } from "../../integrations/agent/engine-resolution";
import { getConfigPath } from "../paths";
import { warn } from "../warn";

// Re-export type surface from config-types.ts so call sites don't need to
// move (the runtime values live here; the types are documentation-only).
export type {
  AgentProfileConfig,
  AkmConfig,
  ConfiguredSource,
  EmbeddingConnectionConfig,
  EngineConfig,
  HarnessId,
  ImproveConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  IndexConfig,
  IndexPassConfig,
  LlmConnectionConfig,
  LlmProfileConfig,
  OutputConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
  SourceSpec,
} from "./config-types";
// Canonical harness-id source of truth (#565) — runtime value re-export.
export { VALID_HARNESS_IDS } from "./config-types";

// ── Feedback failure-mode constants (F-3 / #384) ────────────────────────────

// Canonical taxonomy lives in the schema/validator layer; re-exported here so
// existing `../core/config/config` import sites keep working.
export { FEEDBACK_FAILURE_MODES, type FeedbackFailureMode } from "./config-schema";

/**
 * Default value for {@link IndexPassConfig.graphExtractionBatchSize}. Chosen
 * empirically: 4 amortises the per-call HTTP overhead 4× while keeping the
 * combined prompt size well under common 8K/16K context windows (each body is
 * sliced to ~500 chars in the graph-extract prompt builder).
 */
export const DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE = 4;

/**
 * Approximate character budget per asset body inside a batched
 * graph-extraction prompt — used by {@link resolveBatchSize} to derive a
 * context-window ceiling when `llm.contextLength` is configured. This accounts
 * for the actual `MAX_BODY_CHARS` (500) in graph-extract.ts plus the system
 * prompt, user prompt wrapper, and expected JSON response overhead.
 */
const GRAPH_EXTRACTION_CHARS_PER_BODY = 1500;

/**
 * Clamp a configured batch size against the model's known context window.
 *
 * `configured` defaults to {@link DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE} when
 * `undefined`. When `contextLength` is provided, the result is the smaller of
 * `configured` and `floor(contextLength / GRAPH_EXTRACTION_CHARS_PER_BODY)`,
 * with a floor of 1 so the batched path always processes at least one body.
 */
export function resolveBatchSize(configured: number | undefined, contextLength?: number): number {
  const base = configured && configured > 0 ? configured : DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE;
  if (!contextLength || contextLength <= 0) return base;
  const ceiling = Math.max(1, Math.floor(contextLength / GRAPH_EXTRACTION_CHARS_PER_BODY));
  return Math.max(1, Math.min(base, ceiling));
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "auto",
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

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".akm", "config.json");

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

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
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
 * Parse raw config text and validate via Zod.
 * ({@link AkmConfigSchema}). Returns the merged-with-defaults AkmConfig.
 *
 * The migration handles all one-time 0.7→0.8 transforms (legacy keys,
 * boolean→string coercions, openviking rename); the schema then validates
 * the canonical shape and throws on anything it doesn't recognise.
 */
export function parseAndValidateConfigText(text: string, sourcePath?: string): AkmConfig {
  const raw = parseConfigText(text, sourcePath);
  if (raw.configVersion !== CURRENT_CONFIG_VERSION) {
    throw new ConfigError(
      `Unsupported configVersion${sourcePath ? ` at ${sourcePath}` : ""}: expected "${CURRENT_CONFIG_VERSION}".`,
      "UNSUPPORTED_CONFIG_VERSION",
      "Recreate engines and improve.strategies manually for AKM 0.9.0; profile-based configuration is not translated automatically.",
    );
  }
  const parsed = AkmConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    const where = sourcePath ? ` at ${sourcePath}` : "";
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
  return finalResult.data;
}

export function getSources(config: AkmConfig): SourceConfigEntry[] {
  return config.sources ?? [];
}

export function getEffectiveRegistries(config: AkmConfig): RegistryConfigEntry[] {
  return config.registries ?? DEFAULT_CONFIG.registries ?? [];
}

/** Resolve and materialize the configured default LLM engine at dispatch time. */
export function requireLlmConfig(config: AkmConfig): LlmConnectionConfig {
  return materializeLlmConnection(resolveLlmEngineUse(config, []));
}

/**
 * Like {@link requireLlmConfig} but returns `undefined` instead of throwing
 * when no LLM is configured. Use in code paths where the LLM is optional.
 */
export function getDefaultLlmConfig(config: AkmConfig): LlmConnectionConfig | undefined {
  const resolved = resolveLlmEngineUse(config, [], { optional: true });
  return resolved ? materializeLlmConnection(resolved) : undefined;
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
  _config: AkmConfig,
  processName: ImproveProcessName,
  selected?: ImproveProfileConfig,
): ImproveProcessConfig | undefined {
  return selected?.processes?.[processName];
}

export function loadConfig(): AkmConfig {
  // Single-layer load: only the user-level config file is read. Project-level
  // .akm/config.json files discovered under cwd-ancestors emit a one-time
  // deprecation warning (#457) but are NOT merged.
  warnIfProjectConfigPresent(process.cwd());
  return loadUserConfig();
}

let saveConfigOverride: ((config: AkmConfig) => void) | undefined;

/** TEST-ONLY. Swap the implementation of `saveConfig`; pass undefined to restore. */
export function _setSaveConfigForTests(fake?: (config: AkmConfig) => void): void {
  saveConfigOverride = fake;
}

export function saveConfig(config: AkmConfig): void {
  // Every lifecycle write produces the only config version this binary can load.
  const currentConfig = { ...config, configVersion: CURRENT_CONFIG_VERSION } as AkmConfig;
  if (saveConfigOverride) {
    saveConfigOverride(currentConfig);
    return;
  }
  saveConfigReal(currentConfig);
}

function saveConfigReal(config: AkmConfig): void {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  withConfigLock(() => {
    const validated = validateCompleteConfig(config);
    ensureMigrationBackupWithConfigLockHeld();
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
  config: AkmConfig;
  written: boolean;
}

/**
 * Mutate config under one fail-closed lock spanning read, merge, validation,
 * migration backup, ordinary backup, and atomic write.
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
    const current =
      text === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : parseAndValidateConfigText(text, configPath);
    const mutated = mutate(current);
    if (mutated === current) return { config: current, written: false };
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    ensureMigrationBackupWithConfigLockHeld();
    if (text !== undefined) backupExistingConfig(configPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(next));
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
): Promise<ConfigMutationResult & { precommit: T }> {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const release = acquireConfigLock();
  try {
    const text = readConfigText(configPath);
    const current =
      text === undefined ? ({ ...DEFAULT_CONFIG } as AkmConfig) : parseAndValidateConfigText(text, configPath);
    const mutated = mutate(current);
    const next = validateCompleteConfig({ ...mutated, configVersion: CURRENT_CONFIG_VERSION });
    // Setup's pre-commit may initialize the stash. Prove the rebase and final
    // config are valid, then require the recovery snapshots before that first
    // external side effect.
    ensureMigrationBackupWithConfigLockHeld();
    if (text !== undefined) backupExistingConfig(configPath);
    const precommitResult = await precommit(next);
    if (mutated === current) return { config: current, written: false, precommit: precommitResult };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, sanitizeConfigForWrite(next));
    return { config: next, written: true, precommit: precommitResult };
  } finally {
    release();
  }
}

/**
 * Strip literal apiKey fields before writing config to disk.
 * API keys are expected to come from environment variables
 * (AKM_EMBED_API_KEY, AKM_LLM_API_KEY, AKM_PROFILE_<NAME>_API_KEY).
 *
 * `${VAR}` / `$VAR` references are preserved — they are not secrets, they
 * are deferred lookups resolved at consumption by `resolveSecret`. Dropping
 * them would break the documented config-on-disk pattern.
 *
 * When a non-reference literal value is stripped, emit a `warn()` so the
 * user knows their key was dropped and how to provide it at runtime (#474).
 * Previously the strip was silent — a user invoking `akm setup --from <file>
 * --yes` with an `apiKey` field expected persistence and got a wiped config
 * with no feedback.
 */
function sanitizeConfigForWrite(config: AkmConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  const stripped: string[] = [];

  if (config.embedding?.apiKey !== undefined) {
    const apiKey = config.embedding.apiKey;
    if (isEnvReference(apiKey)) {
      // Preserve reference verbatim — not a secret.
      sanitized.embedding = { ...config.embedding };
    } else {
      const { apiKey: _drop, ...rest } = config.embedding;
      sanitized.embedding = rest;
      if (apiKey) stripped.push("embedding.apiKey (set AKM_EMBED_API_KEY to provide at runtime)");
    }
  } else if (config.embedding) {
    sanitized.embedding = { ...config.embedding };
  }

  if (config.engines) {
    const engines: Record<string, unknown> = {};
    for (const [name, engine] of Object.entries(config.engines)) {
      if (engine.kind !== "llm" || engine.apiKey === undefined || isEnvReference(engine.apiKey)) {
        engines[name] = { ...engine };
        continue;
      }
      const { apiKey: _drop, ...rest } = engine;
      engines[name] = rest;
      if (engine.apiKey) stripped.push(`engines.${name}.apiKey`);
    }
    sanitized.engines = engines;
  }

  if (stripped.length > 0) {
    warn(
      `Config sanitizer dropped API key(s) before writing to disk:\n  - ${stripped.join("\n  - ")}\n\nakm does not persist API keys to config.json. Set the listed environment variables to provide them at runtime, or use \`\${VAR}\` references in your config to defer lookup. See docs/data-and-telemetry.md.`,
    );
  }

  return sanitized;
}

/** Matches the only 0.9 symbolic secret forms: `${VAR}` or `$VAR`. */
function isEnvReference(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function updateConfig(partial: Partial<AkmConfig>): AkmConfig {
  return mutateConfig((current) => deepMergeConfig(current, partial) as AkmConfig).config;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a single secret value by expanding `${VAR}` / `$VAR` references
 * against `process.env`. Use this at apiKey /
 * authorization-header consumption sites (LLM client, embedder, agent SDK
 * runner) — NOT on the load path. Non-string inputs pass through unchanged.
 *
 * Returns the input unchanged when no substitution markers are present, so
 * literal API key strings (already-resolved secrets) are zero-cost.
 *
 * Other config string values (URLs, endpoints, model names, prompts) are
 * preserved verbatim on read — only fields explicitly routed through this
 * helper are expanded.
 */
export function resolveSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  if (!value.includes("$")) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    return process.env[(braced ?? bare) as string] ?? "";
  });
}

/**
 * Read a per-pass {@link IndexPassConfig} entry from {@link IndexConfig},
 * filtering out the reserved feature-section keys so callers don't mistake
 * `metadataEnhance` / `stalenessDetection` for a pass.
 */
/**
 * Reserved well-known keys on IndexConfig that are NOT per-pass entries.
 * `stalenessDetection` is retired (10-Q3) but stays reserved so a leftover
 * config section is never misread as a pass entry.
 */
const INDEX_RESERVED_KEYS = new Set(["metadataEnhance", "stalenessDetection"]);

export function getIndexPassConfig(config: IndexConfig | undefined, passName: string): IndexPassConfig | undefined {
  if (!config) return undefined;
  if (INDEX_RESERVED_KEYS.has(passName)) return undefined;
  const entry = config[passName];
  if (!entry || typeof entry !== "object") return undefined;
  return entry as IndexPassConfig;
}

// Re-export source runtime helpers — implementation lives in config-sources.ts.
export { parseSourceSpec, resolveConfiguredSources } from "./config-sources";

/**
 * Merge a partial user-config override onto a base config. Used by
 * {@link loadUserConfig} (DEFAULT_CONFIG + on-disk) and {@link updateConfig}
 * (current config + partial patch). Sub-objects with named records (profiles,
 * defaults, etc.) shallow-merge; arrays override wholesale.
 */

/**
 * Walk cwd-ancestors looking for `.akm/config.json`. If one is found, emit a
 * one-time deprecation warning per path. The file's contents are NOT read —
 * multi-layer project config was removed in this release; the warning stays
 * for one cycle so users notice they have a now-dead file on disk and can
 * migrate its settings to the user-level config.
 */
const PROJECT_CONFIG_DEPRECATION_WARNED = new Set<string>();
function warnIfProjectConfigPresent(startDir: string): void {
  let currentDir = path.resolve(startDir);
  while (true) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_RELATIVE_PATH);
    if (isFile(configPath) && !PROJECT_CONFIG_DEPRECATION_WARNED.has(configPath)) {
      PROJECT_CONFIG_DEPRECATION_WARNED.add(configPath);
      warn(
        `[akm] DEPRECATED: project-level config file found at ${configPath}. ` +
          "Project-level config files are no longer merged (removed after 0.8.x deprecation). " +
          "Move any needed settings to ~/.config/akm/config.json; this file is ignored.",
      );
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
