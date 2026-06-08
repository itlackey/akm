// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors";
import { backupExistingConfig, parseConfigText, withConfigLock, writeConfigAtomic } from "./config-io";
import { CURRENT_CONFIG_VERSION, compareConfigVersion, migrateConfigShape } from "./config-migration";
import { AkmConfigSchema } from "./config-schema";
import type {
  AkmConfig,
  IndexConfig,
  IndexPassConfig,
  LlmConnectionConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
} from "./config-types";

export { stripJsonComments } from "./config-io";

import { getCacheDir, getConfigPath } from "../paths";
import { warn } from "../warn";

// Re-export the AgentConfig alias (now `= AkmConfig`) for source-compat with
// pre-0.8.0 callers that imported it from this module.
export type { AgentConfig } from "../../integrations/agent/config";
// Re-export type surface from config-types.ts so call sites don't need to
// move (the runtime values live here; the types are documentation-only).
export type {
  AgentProfileConfigV2,
  AkmConfig,
  BaseConnectionConfig,
  ConfiguredSource,
  EmbeddingConnectionConfig,
  HarnessId,
  ImproveConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  IndexConfig,
  IndexConfigReservedKeys,
  IndexPassConfig,
  LlmCapabilities,
  LlmConnectionConfig,
  LlmProfileConfig,
  OutputConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
  SourceConfigEntryOptions,
  SourceSpec,
} from "./config-types";
// Canonical harness-id source of truth (#565) — runtime value re-export.
export { VALID_HARNESS_IDS } from "./config-types";

// ── Feedback failure-mode constants (F-3 / #384) ────────────────────────────

/**
 * Curated taxonomy of failure modes for negative feedback.
 *
 * Structured failure modes enable aggregation across feedback events so the
 * distill pipeline can detect that "5 assets failed for the same reason" and
 * act on it — free-text strings about the same issue are not aggregatable.
 */
export const FEEDBACK_FAILURE_MODES = [
  "incorrect", // Factually wrong or logically flawed content
  "outdated", // Correct at some point but now stale
  "dangerous", // Could cause harm if followed (security, safety)
  "incomplete", // Missing key steps, context, or caveats
  "redundant", // Duplicates another asset without adding value
] as const;

/** Union of the curated failure-mode values. */
export type FeedbackFailureMode = (typeof FEEDBACK_FAILURE_MODES)[number];

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
  } catch {
    cachedConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
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
  } catch {
    cachedConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
  }

  // Auto-migration: rewrite legacy shapes to disk on cache miss so the schema
  // sees canonical input. AKM_NO_AUTO_MIGRATE=1 skips the disk rewrite (still
  // applies in-memory).
  text = maybeAutoMigrateConfigFile(configPath, text);

  const finalConfig = applyRuntimeEnvApiKeys(parseAndValidate(text, configPath));

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
 * Parse raw config text, run the legacy-shape migration
 * ({@link migrateConfigShape}), then validate via Zod
 * ({@link AkmConfigSchema}). Returns the merged-with-defaults AkmConfig.
 *
 * The migration handles all one-time 0.7→0.8 transforms (legacy keys,
 * boolean→string coercions, openviking rename); the schema then validates
 * the canonical shape and throws on anything it doesn't recognise.
 */
function parseAndValidate(text: string, sourcePath?: string): AkmConfig {
  // Migration absorbs 0.7→0.8 input transforms (semanticSearchMode bool→string,
  // stashes[] → sources[], openviking removal); the schema then sees a
  // canonical shape. Migration is idempotent on already-migrated input.
  const migrated = migrateConfigShape(parseConfigText(text, sourcePath)).result;
  const parsed = AkmConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    const where = sourcePath ? ` at ${sourcePath}` : "";
    throw new ConfigError(`Invalid config${where}:\n${lines}`, "INVALID_CONFIG_FILE");
  }
  return mergeLoadedConfig(DEFAULT_CONFIG, parsed.data as Partial<AkmConfig>);
}

export function getSources(config: AkmConfig): SourceConfigEntry[] {
  return config.sources ?? [];
}

export function getEffectiveRegistries(config: AkmConfig): RegistryConfigEntry[] {
  return config.registries ?? DEFAULT_CONFIG.registries ?? [];
}

/**
 * Resolve the name of the default LLM profile.
 *
 * Resolution order:
 *   1. `defaults.llm` — explicit pointer set by the user.
 *   2. A profile literally named `default` under `profiles.llm` — implicit
 *      fallback. The convention "name your default profile `default`" is
 *      what `akm setup` produces, so an unset `defaults.llm` next to a
 *      `profiles.llm.default` block is overwhelmingly a config-rewrite
 *      casualty (see [[project_akm_config_clobber_trap]]) rather than
 *      intent. Treating that shape as configured avoids the silent
 *      `getDefaultLlmConfig → undefined → pass-returns-zero` failure mode
 *      that produced 18h of no-op memory-inference runs on 2026-05-23.
 *
 * Returns `undefined` when neither path resolves to a profile name.
 */
function resolveDefaultLlmProfileName(config: AkmConfig): string | undefined {
  const explicit = config.defaults?.llm;
  if (explicit) return explicit;
  if (config.profiles?.llm?.default) return "default";
  return undefined;
}

/**
 * Resolve the default LLM connection from `profiles.llm[defaults.llm]`.
 *
 * Throws {@link ConfigError} when no default profile can be resolved (neither
 * `defaults.llm` nor an implicit `profiles.llm.default`) or when the named
 * profile does not exist under `profiles.llm`. Use this in code paths that
 * must have an LLM configured (per-pass index calls, distill, consolidate,
 * etc).
 */
export function requireLlmConfig(config: AkmConfig): LlmConnectionConfig {
  const defaultName = resolveDefaultLlmProfileName(config);
  if (!defaultName) {
    throw new ConfigError(
      "LLM is not configured. Run `akm setup` or set `defaults.llm` to a profile defined in `profiles.llm`.",
      "LLM_NOT_CONFIGURED",
    );
  }
  const profile = config.profiles?.llm?.[defaultName];
  if (!profile) {
    throw new ConfigError(
      `LLM default profile "${defaultName}" not found in profiles.llm.`,
      "LLM_NOT_CONFIGURED",
      `Available profiles: ${Object.keys(config.profiles?.llm ?? {}).join(", ") || "none"}. Run \`akm setup\` to configure.`,
    );
  }
  return profile;
}

/**
 * Like {@link requireLlmConfig} but returns `undefined` instead of throwing
 * when no LLM is configured. Use in code paths where the LLM is optional.
 */
export function getDefaultLlmConfig(config: AkmConfig): LlmConnectionConfig | undefined {
  const defaultName = resolveDefaultLlmProfileName(config);
  if (!defaultName) return undefined;
  return config.profiles?.llm?.[defaultName];
}

/**
 * Run `migrateConfigShape` on the raw text and — unless `AKM_NO_AUTO_MIGRATE=1`
 * is set — persist the migrated result. Returns the (possibly migrated) text
 * for the caller to feed into `parseAndValidate`.
 *
 * If the on-disk config is newer than this binary's known version, the bytes
 * are left untouched (we won't silently strip fields on downgrade).
 */
function maybeAutoMigrateConfigFile(configPath: string, text: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = parseConfigText(text);
  } catch {
    return text; // Malformed JSON — let parseAndValidate surface the error.
  }
  if (compareConfigVersion(obj.configVersion as string | number | undefined, CURRENT_CONFIG_VERSION) === 1) {
    return text;
  }

  const { changed, result } = migrateConfigShape(obj);
  if (!changed) return text;

  const migratedText = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.AKM_NO_AUTO_MIGRATE === "1") return migratedText;

  try {
    withConfigLock(() => {
      backupExistingConfig(configPath);
      writeConfigAtomic(configPath, result);
    });
    const newVersion = typeof result.configVersion === "string" ? result.configVersion : "0.8.0";
    const backupDir = `${getCacheDir()}/config-backups`;
    // WS-2: emit a loud banner to BOTH stderr and stdout so pipelines and
    // interactive terminals both see it. Include the backup path (resolved,
    // not ~/...), opt-out env var, and preview diff command.
    const banner = [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `  akm: auto-migrated config → ${newVersion} format`,
      `  file:   ${configPath}`,
      `  backup: ${backupDir}/config-<timestamp>.json`,
      "  to opt out of future auto-migration: AKM_NO_AUTO_MIGRATE=1",
      "  to preview a dry-run diff:            akm config migrate --dry-run --print-diff",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");
    process.stderr.write(`${banner}\n`);
    process.stdout.write(`${banner}\n`);
  } catch (err) {
    // #461: never return migrated bytes when disk write fails — that triggers
    // an infinite re-migrate loop on every load. Hard-error so the user
    // notices and either fixes the disk issue or sets AKM_NO_AUTO_MIGRATE=1.
    throw new ConfigError(
      `Failed to write migrated config to ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_CONFIG_FILE",
      "Check filesystem permissions, free space, and disk health. To skip auto-migration, set AKM_NO_AUTO_MIGRATE=1.",
    );
  }
  return migratedText;
}

export function loadConfig(): AkmConfig {
  // Single-layer load: only the user-level config file is read. Project-level
  // .akm/config.json files discovered under cwd-ancestors emit a one-time
  // deprecation warning (#457) but are NOT merged.
  warnIfProjectConfigPresent(process.cwd());
  return loadUserConfig();
}

export function saveConfig(config: AkmConfig): void {
  cachedConfig = undefined;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const sanitized = sanitizeConfigForWrite(config);

  // Final validation gate before bytes hit disk. Catches schema violations
  // (unknown keys in registries[] / sources[] / profiles.*; out-of-range
  // numbers; etc. — closes #462) before we corrupt the user's config.
  const parseResult = AkmConfigSchema.safeParse(sanitized);
  if (!parseResult.success) {
    const lines = parseResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(
      `Refusing to save invalid config:\n${lines}`,
      "INVALID_CONFIG_FILE",
      "Fix the listed fields, or undo the offending `akm config set`. " +
        "If this looks like an akm bug, re-run with --debug to attach the traceback.",
    );
  }

  // WS-3: acquire the config write lock so concurrent `akm config set`
  // invocations do not interleave their backup+atomic-write cycles.
  withConfigLock(() => {
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, sanitized);
  });
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

  if (config.profiles?.llm) {
    const llmProfiles: Record<string, unknown> = {};
    for (const [name, profile] of Object.entries(config.profiles.llm)) {
      if (profile.apiKey !== undefined) {
        if (isEnvReference(profile.apiKey)) {
          llmProfiles[name] = { ...profile };
        } else {
          const { apiKey: _drop, ...rest } = profile;
          llmProfiles[name] = rest;
          if (profile.apiKey) {
            const envVar = `AKM_PROFILE_${name.toUpperCase().replace(/-/g, "_")}_API_KEY`;
            stripped.push(`profiles.llm.${name}.apiKey (set ${envVar} to provide at runtime)`);
          }
        }
      } else {
        llmProfiles[name] = { ...profile };
      }
    }
    sanitized.profiles = {
      ...((sanitized.profiles as Record<string, unknown> | undefined) ?? {}),
      llm: llmProfiles,
    };
  }

  if (stripped.length > 0) {
    warn(
      `Config sanitizer dropped API key(s) before writing to disk:\n  - ${stripped.join("\n  - ")}\n\nakm does not persist API keys to config.json. Set the listed environment variables to provide them at runtime, or use \`\${VAR}\` references in your config to defer lookup. See docs/data-and-telemetry.md.`,
    );
  }

  return sanitized;
}

/** Matches `${VAR}`, `${VAR:-default}`, or `$VAR`. */
function isEnvReference(value: string): boolean {
  return /^\$\{[^}]+\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function updateConfig(partial: Partial<AkmConfig>): AkmConfig {
  const current = loadUserConfig();
  const merged = mergeLoadedConfig(current, partial);
  saveConfig(merged);
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a single secret value by expanding `${VAR}` / `$VAR` /
 * `${VAR:-default}` references against `process.env`. Use this at apiKey /
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
  return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    if (braced) {
      const [name, ...rest] = (braced as string).split(":-");
      const fallback = rest.join(":-");
      return process.env[name] ?? fallback ?? "";
    }
    return process.env[bare as string] ?? "";
  });
}

/**
 * Read a per-pass {@link IndexPassConfig} entry from {@link IndexConfig},
 * filtering out the reserved feature-section keys so callers don't mistake
 * `metadataEnhance` / `stalenessDetection` for a pass.
 */
/** Reserved well-known keys on IndexConfig that are NOT per-pass entries. */
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
function mergeLoadedConfig(base: AkmConfig, override?: Partial<AkmConfig>): AkmConfig {
  if (!override) return { ...base };
  const merged: AkmConfig = { ...base, ...override };

  // Shallow-merge sub-objects so a partial update to e.g. `output.format`
  // doesn't drop the existing `output.detail`.
  for (const key of ["output", "embedding", "index", "defaults"] as const) {
    if (base[key] && override[key]) {
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous structural merge
      (merged as any)[key] = { ...base[key], ...override[key] };
    }
  }

  if (base.profiles && override.profiles) {
    const next: NonNullable<AkmConfig["profiles"]> = { ...base.profiles };
    for (const k of ["llm", "agent", "improve"] as const) {
      const ovr = override.profiles[k];
      if (ovr) next[k] = { ...(next[k] ?? {}), ...ovr } as never;
    }
    merged.profiles = next;
  }

  return merged;
}

function applyRuntimeEnvApiKeys(config: AkmConfig): AkmConfig {
  const next = { ...config };

  if (next.embedding && !next.embedding.apiKey) {
    const envKey = process.env.AKM_EMBED_API_KEY?.trim();
    if (envKey) next.embedding = { ...next.embedding, apiKey: envKey };
  }

  // LLM profile keys: AKM_LLM_API_KEY for the default profile, then
  // AKM_PROFILE_<UPPER>_API_KEY for any profile (per-profile wins).
  const defaultProfile = next.defaults?.llm;
  if (next.profiles?.llm) {
    const updated = { ...next.profiles.llm };
    let changed = false;
    for (const [name, profile] of Object.entries(updated)) {
      if (profile.apiKey) continue;
      const perProfile = process.env[`AKM_PROFILE_${name.toUpperCase().replace(/-/g, "_")}_API_KEY`]?.trim();
      const fallback = name === defaultProfile ? process.env.AKM_LLM_API_KEY?.trim() : undefined;
      const envKey = perProfile || fallback;
      if (envKey) {
        updated[name] = { ...profile, apiKey: envKey };
        changed = true;
      }
    }
    if (changed) next.profiles = { ...next.profiles, llm: updated };
  }

  return next;
}

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
