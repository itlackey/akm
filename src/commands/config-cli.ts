/**
 * Config CLI commands — `akm config get/set/unset/list`.
 *
 * Thin wrappers around the schema walker in `core/config-walker.ts`. Adding a
 * new config field is one line of Zod schema in `core/config-schema.ts` and
 * zero lines here — the walker handles get/set/unset/coercion uniformly.
 *
 * Legacy behaviour preserved:
 *   - `akm config set llm.<x>` writes to `profiles.llm.<defaults.llm>` (or
 *     auto-creates a "default" profile), mirroring the pre-rewrite shim.
 *   - `akm config set embedding.ollamaOptions.numCtx` is sugar for
 *     `embedding.ollamaOptions.num_ctx` (camelCase ↔ snake_case bridge).
 *   - `parseConfigValue` returns a Partial<AkmConfig> so it can be merged with
 *     the runtime config object via `mergeConfigValue`.
 */
import { type AkmConfig, DEFAULT_CONFIG, getSources } from "../core/config";
import { configGet, configSet, configUnset, unknownKeyHint } from "../core/config-walker";
import { UsageError } from "../core/errors";

// ── Legacy `llm.*` → `profiles.llm.<default>.*` aliasing ────────────────────

/**
 * Map a legacy top-level `llm.<sub>` path onto the actual schema path. The
 * default profile name is "default" when `defaults.llm` is unset.
 */
function rewriteLegacyLlmPath(config: AkmConfig, key: string): string {
  if (key !== "llm" && !key.startsWith("llm.")) return key;
  const sub = key === "llm" ? "" : key.slice("llm.".length);
  const profileName = config.defaults?.llm ?? "default";
  return sub ? `profiles.llm.${profileName}.${sub}` : `profiles.llm.${profileName}`;
}

/**
 * Translate the legacy `embedding.ollamaOptions.numCtx` to the actual schema
 * key `embedding.ollamaOptions.num_ctx`.
 */
function rewriteEmbeddingPath(key: string): string {
  if (key === "embedding.ollamaOptions.numCtx") return "embedding.ollamaOptions.num_ctx";
  return key;
}

/**
 * Translate the deprecated `stashes` alias for `sources` (one-way: both read
 * and write go through `sources`).
 */
function rewriteSourcesAlias(key: string): string {
  if (key === "stashes") return "sources";
  if (key.startsWith("stashes.")) return `sources.${key.slice("stashes.".length)}`;
  return key;
}

/**
 * Translate the legacy `security.installAudit.registryWhitelist` alias.
 */
function rewriteSecurityAlias(key: string): string {
  if (key === "security.installAudit.registryWhitelist") {
    return "security.installAudit.registryAllowlist";
  }
  return key;
}

function rewriteKey(config: AkmConfig, key: string): string {
  let k = rewriteLegacyLlmPath(config, key);
  k = rewriteEmbeddingPath(k);
  k = rewriteSourcesAlias(k);
  k = rewriteSecurityAlias(k);
  return k;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getConfigValue(config: AkmConfig, key: string): unknown {
  const k = rewriteKey(config, key);
  return configGet(config as unknown as Record<string, unknown>, k);
}

export function setConfigValue(config: AkmConfig, key: string, rawValue: string): AkmConfig {
  // #454: reject the legacy aliases up front so the error message names the
  // env var the user typed (AKM_LLM_API_KEY) rather than the rewritten profile
  // env var (AKM_PROFILE_DEFAULT_API_KEY) — both work at runtime, but the
  // shorter name matches the user's mental model.
  if (key === "llm.apiKey") {
    throw new UsageError(
      "apiKey cannot be persisted in config; export AKM_LLM_API_KEY instead. (key: llm.apiKey)",
      "INVALID_FLAG_VALUE",
      "Storing API keys in config.json leaks them through backups, logs, and version control. " +
        "Use the corresponding environment variable. AKM reads it at request time.",
    );
  }
  if (key === "embedding.apiKey") {
    throw new UsageError(
      "apiKey cannot be persisted in config; export AKM_EMBED_API_KEY instead. (key: embedding.apiKey)",
      "INVALID_FLAG_VALUE",
      "Storing API keys in config.json leaks them through backups, logs, and version control. " +
        "Use the corresponding environment variable. AKM reads it at request time.",
    );
  }

  const k = rewriteKey(config, key);
  // Legacy ergonomic: `akm config set semanticSearchMode true|false`
  let coerced = rawValue;
  if (k === "semanticSearchMode") {
    if (rawValue === "true") coerced = "auto";
    else if (rawValue === "false") coerced = "off";
  }
  let next = configSet(config as unknown as Record<string, unknown>, k, coerced) as unknown as AkmConfig;

  // Legacy ergonomic shim: when the user sets `llm.<field>` and no
  // `defaults.llm` is set, point it at the freshly-created profile so the
  // value actually takes effect at runtime.
  if (key === "llm" || key.startsWith("llm.")) {
    if (!next.defaults?.llm) {
      next = {
        ...next,
        defaults: { ...(next.defaults ?? {}), llm: "default" },
      };
    }
  }

  return next;
}

export function unsetConfigValue(config: AkmConfig, key: string): AkmConfig {
  const k = rewriteKey(config, key);
  return configUnset(config as unknown as Record<string, unknown>, k) as unknown as AkmConfig;
}

/**
 * Compatibility shim: returns a `Partial<AkmConfig>` containing just the
 * change. Older code merged this onto the live config — new code should call
 * `setConfigValue` directly (which returns the full merged config).
 */
export function parseConfigValue(key: string, value: string): Partial<AkmConfig> {
  // Use a "marker" base so we can detect which top-level fields actually got
  // touched by the set call. Anything still equal to the marker is untouched.
  const SENTINEL = Symbol("untouched");
  const base: Record<string, unknown> = { semanticSearchMode: SENTINEL };
  const next = setConfigValue(base as unknown as AkmConfig, key, value) as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(next)) {
    if (next[k] !== SENTINEL) {
      patch[k] = next[k];
    }
  }
  return patch as Partial<AkmConfig>;
}

export function listConfig(config: AkmConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {
    semanticSearchMode: config.semanticSearchMode,
    registries: config.registries ?? DEFAULT_CONFIG.registries ?? [],
    output: { ...(DEFAULT_CONFIG.output ?? {}), ...(config.output ?? {}) },
    stashDir: config.stashDir ?? null,
    installed: config.installed ?? [],
    sources: getSources(config),
  };
  if (config.defaultWriteTarget) result.defaultWriteTarget = config.defaultWriteTarget;
  if (config.embedding) result.embedding = config.embedding;
  if (config.profiles) result.profiles = config.profiles;
  if (config.defaults) result.defaults = config.defaults;
  if (config.security) result.security = config.security;
  if (config.search) result.search = config.search;
  if (config.index) result.index = config.index;
  if (config.feedback) result.feedback = config.feedback;
  if (config.improve) result.improve = config.improve;
  if (config.archiveRetentionDays !== undefined) result.archiveRetentionDays = config.archiveRetentionDays;
  if (config.configVersion !== undefined) result.configVersion = config.configVersion;
  return result;
}

export { unknownKeyHint };
