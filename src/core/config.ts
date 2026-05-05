import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type AgentConfig, parseAgentConfig } from "../integrations/agent/config";
import type { InstalledStashEntry, KitSource } from "../registry/types";
import { filterNonEmptyStrings } from "./common";
import { ConfigError } from "./errors";
import { getConfigDir as _getConfigDir, getConfigPath as _getConfigPath } from "./paths";
import { warn } from "./warn";

export type { AgentConfig } from "../integrations/agent/config";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Fields shared by every OpenAI-compatible connection config (embedding +
 * LLM). Specialized configs extend this base. Pure type DRY — the on-disk
 * JSON schema is unchanged.
 */
export interface BaseConnectionConfig {
  /** Provider name for display (e.g. "openai", "anthropic", "ollama"). */
  provider?: string;
  /** OpenAI-compatible HTTP endpoint. */
  endpoint: string;
  /** Model name to use. */
  model: string;
  /** Optional API key for authenticated endpoints. */
  apiKey?: string;
}

export interface EmbeddingConnectionConfig extends BaseConnectionConfig {
  /** Optional output dimension for providers that support it */
  dimension?: number;
  /** Optional local transformer model name (e.g. "Xenova/bge-small-en-v1.5"). Overrides the default when using local embeddings. */
  localModel?: string;
  /** Max tokens per document chunk before splitting. */
  maxTokens?: number;
  /** Documents per embedding API batch (default 100). */
  batchSize?: number;
  /** Max characters per text chunk before splitting. */
  chunkSize?: number;
  /**
   * Context window size passed as `num_ctx` to Ollama's native `/api/embed` endpoint.
   * Has no effect on non-Ollama providers. Use when long documents produce 400 errors
   * from the embedding model's default context limit (e.g. set to 8192 for most models).
   */
  contextLength?: number;
  /**
   * Arbitrary options forwarded verbatim as the `options` field in the Ollama
   * native `/api/embed` request body. Takes precedence over `contextLength` when both
   * are set. Use this for Ollama-specific tunables not covered by first-class fields.
   * Example: `{ "num_ctx": 8192 }`
   */
  ollamaOptions?: { num_ctx?: number };
}

export interface LlmCapabilities {
  /** Model emits strict JSON reliably (probed during setup). */
  structuredOutput?: boolean;
}

export interface LlmConnectionConfig extends BaseConnectionConfig {
  /** Optional sampling temperature */
  temperature?: number;
  /** Optional response token limit */
  maxTokens?: number;
  /** Capability flags learned at setup time (e.g. structured-output support). */
  capabilities?: LlmCapabilities;
  /**
   * v1 spec §14 — bounded in-tree LLM feature gates. Each call site is
   * gated behind exactly one key. Unknown keys are warn-and-ignored at
   * config-load time. Currently only `memory_inference` is parsed by this
   * loader; remaining locked keys are accepted into the schema as later
   * issues wire them in.
   */
  features?: LlmFeatureFlags;
  /**
   * Arbitrary key-value pairs forwarded verbatim into every chat completions
   * request body. Use this for provider-specific parameters not covered by
   * first-class fields, e.g. `{ "reasoning_effort": "none" }` to disable
   * thinking on Ollama qwen3/qwen3.5 models.
   */
  extraParams?: Record<string, unknown>;
}

export interface LlmFeatureFlags {
  /** Gates the `akm index` memory-inference pass (#201). Default: true. */
  memory_inference?: boolean;
  /**
   * Gates the `akm index` graph-extraction pass (#207). Default: true (the
   * pass is still off by default unless `akm.llm` is configured AND
   * `index.graph.llm !== false`, per the orthogonal-gates rule in v1
   * spec §14). Set to `false` to block every graph_extraction call site
   * regardless of any per-pass setting.
   */
  graph_extraction?: boolean;
  /**
   * Gates the `akm curate` LLM-rerank pass (#227). Default: false.
   * When false (or absent) curate falls back to the deterministic pipeline.
   */
  curate_rerank?: boolean;
  /**
   * Gates `akm distill <ref>` (§14.5, #227). Default: false.
   * When false (or absent), `akm distill` is skipped as a no-op rather than
   * failing with `ConfigError`.
   */
  feedback_distillation?: boolean;
}

export interface RegistryConfigEntry {
  /** URL of the registry index */
  url: string;
  /** Human-friendly label for this registry */
  name?: string;
  /** Whether this registry is active. Default: true */
  enabled?: boolean;
  /** Provider type. Default: "static-index" (current behavior). */
  provider?: string;
  /** Arbitrary provider-specific options passed through to the provider. */
  options?: Record<string, unknown>;
}

/**
 * SourceSpec — discriminated union describing *where* a stash comes from.
 *
 * This is the canonical runtime model. The on-disk config keeps using the
 * flat `{ type, path, url, ... }` shape (see {@link SourceConfigEntry}); a
 * {@link SourceSpec} value is constructed from those fields by
 * {@link parseSourceSpec} at load time and attached to the runtime
 * {@link ConfiguredSource}. `SourceSpec` values are not serialized in this shape —
 * they are derived.
 */
export type SourceSpec =
  | { type: "filesystem"; path: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; ref?: string }
  | { type: "website"; url: string; maxPages?: number }
  | { type: "local"; path: string };

/**
 * ConfiguredSource — runtime representation of a configured stash.
 *
 * Unifies the four overlapping types this codebase used to carry
 * (`SourceConfigEntry`, `InstalledStashEntry`, `SourceEntry`, `SearchSource`)
 * into one value. Persisted on disk via {@link SourceConfigEntry}; the
 * `source` field is derived at load time and never written back out.
 *
 * Iteration order convention (see `resolveConfiguredSources()`):
 *   1. The entry marked `primary: true` (or, as a backwards-compat shim,
 *      a synthetic filesystem entry built from the top-level `stashDir`).
 *   2. Remaining `sources[]` entries in declared order.
 *   3. Legacy `installed[]` entries last.
 */
export interface ConfiguredSource {
  /** Stable identifier. Generated from `type+hash` when absent in legacy configs. */
  name: string;
  /** Provider type discriminator (mirrors `source.type`). */
  type: string;
  /** Internal derived field — not persisted to disk. */
  source: SourceSpec;
  /** Default true. When false, the entry is loaded but skipped at runtime. */
  enabled?: boolean;
  /** Whether the underlying repo accepts writes (e.g. git push). */
  writable?: boolean;
  /** Marks one entry in `sources[]` as the primary working stash. */
  primary?: boolean;
  /** Pass-through provider-specific options. */
  options?: Record<string, unknown>;
  /** If set, .md files in this stash are indexed as wiki pages under this name. */
  wikiName?: string;
}

/**
 * @deprecated Use {@link ConfiguredSource} (runtime) and let the loader derive
 * {@link SourceSpec} from the persisted fields. `SourceConfigEntry` describes
 * the on-disk JSON shape; new code should not reach for it directly.
 */
export interface SourceConfigEntry {
  /** Provider type (e.g. "filesystem", "git", "website", "npm") */
  type: string;
  /** Filesystem path (for type: "filesystem") */
  path?: string;
  /** URL (for remote providers like git or website) */
  url?: string;
  /** Human-friendly label */
  name?: string;
  /** Whether this stash is active. Default: true */
  enabled?: boolean;
  /** If true, the stash is a git repo the user can commit and push changes back to. */
  writable?: boolean;
  /** Marks this entry as the primary working stash (replaces top-level stashDir). */
  primary?: boolean;
  /** Arbitrary provider-specific options */
  options?: Record<string, unknown>;
  /** If set, all .md files in this stash are indexed as wiki pages under this wiki name */
  wikiName?: string;
}

export interface InstallAuditConfig {
  enabled?: boolean;
  blockOnCritical?: boolean;
  blockUnlistedRegistries?: boolean;
  registryAllowlist?: string[];
  registryWhitelist?: string[];
  allowedFindings?: InstallAuditAllowedFinding[];
}

export interface InstallAuditAllowedFinding {
  id: string;
  ref?: string;
  path?: string;
  reason?: string;
}

export interface SecurityConfig {
  installAudit?: InstallAuditConfig;
}

export interface AkmConfig {
  /** Path to the working stash directory. Resolved from env → config → default. */
  stashDir?: string;
  /** User preference for semantic search. "auto" means use semantic search whenever runtime prerequisites are healthy. */
  semanticSearchMode: "off" | "auto";
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @huggingface/transformers */
  embedding?: EmbeddingConnectionConfig;
  /** OpenAI-compatible LLM endpoint config for metadata generation. If not set, uses heuristic generation */
  llm?: LlmConnectionConfig;
  /**
   * Per-pass `akm index` configuration. See {@link IndexPassConfig}. Each
   * pass defaults to the top-level `akm.llm` block; setting
   * `index.<pass>.llm = false` opts a pass out. Per-pass alternative provider
   * configuration is intentionally not supported (#208).
   */
  index?: IndexConfig;
  /** Installed stashes (from npm, GitHub, git, or local sources) */
  installed?: InstalledStashEntry[];
  /**
   * Configured registries for stash discovery.
   * - `undefined` (field absent): use the built-in default registries.
   * - `[]` (explicit empty array): disable all registries (no registry search).
   * - `[...]` (non-empty array): use exactly the listed registries, overriding defaults.
   */
  registries?: RegistryConfigEntry[];
  /**
   * When set on a later config layer (typically project config), controls how
   * the layer's `stashes` interact with stashes inherited from earlier layers.
   * - `"merge"` (default): append the layer's stashes to the inherited list.
   * - `"replace"`: discard the inherited stashes before applying this layer's.
   */
  stashInheritance?: "merge" | "replace";
  /** Additional asset sources (filesystem paths and remote providers) */
  sources?: SourceConfigEntry[];
  /**
   * @deprecated Removed. The legacy `stashes[]` config key is no longer
   * loaded or persisted (one-cycle compat shim retired in #284). The field
   * is retained on the runtime type only as a structural placeholder for
   * defensive `config.sources ?? config.stashes ?? []` reads in downstream
   * call sites; it is never populated by the loader.
   */
  stashes?: SourceConfigEntry[];
  /** Security controls for install-time auditing and registry allowlists */
  security?: SecurityConfig;
  /** Output defaults for CLI rendering */
  output?: OutputConfig;
  /**
   * When true, the primary stash is treated as a writable git repo and
   * `akm save` will push after committing (if a remote is configured).
   */
  writable?: boolean;
  /**
   * Default destination for `akm remember` / `akm import` and any other write
   * helper that does not receive an explicit `--target`. Names a configured
   * source by `name`. Per locked decision 3 (v1 implementation plan §6) the
   * resolution order is: explicit `--target` → `defaultWriteTarget` →
   * `stashDir` → `ConfigError`. There is no implicit "first writable in
   * source-array order" fallback.
   */
  defaultWriteTarget?: string;
  /**
   * Optional agent CLI integration block (v1 spec §12). Configures
   * external agent CLIs that akm can shell out to. Missing block disables
   * agent commands; unknown nested keys are warn-and-ignored. Built-in
   * profiles ship for opencode, claude, codex, gemini, aider — users can
   * override or add profiles via `agent.profiles[<name>]`.
   */
  agent?: AgentConfig;
  /**
   * Search-specific tuning parameters.
   */
  search?: {
    /**
     * Minimum score floor for semantic-only hits (cosine-only, no FTS match).
     * Hits at or above this score are kept; hits below are dropped. FTS and
     * hybrid hits are never filtered. Default: 0.2. Set to 0 to disable.
     */
    minScore?: number;
  };
}

export interface OutputConfig {
  format?: "json" | "yaml" | "text";
  detail?: "brief" | "normal" | "full";
}

/**
 * Per-pass index configuration. Each named pass that uses an LLM defaults to
 * the top-level `akm.llm` block; setting `llm: false` opts a single pass out.
 *
 * v1 contract (#208): boolean opt-out only. Per-pass alternative provider
 * configuration is deliberately out of scope — any non-boolean value for
 * `llm`, or any other key, fails at config load with a `ConfigError`.
 */
export interface IndexPassConfig {
  /** When `false`, the pass skips its LLM call even if `akm.llm` is set. */
  llm?: boolean;
}

/**
 * Index-time configuration. The keys are pass names; values are
 * {@link IndexPassConfig}. Unknown pass names are accepted (so future passes
 * configure via the same shape) but their entries are validated for shape.
 */
export type IndexConfig = Record<string, IndexPassConfig>;

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

// ── Paths ───────────────────────────────────────────────────────────────────

export function getConfigDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return _getConfigDir(env, platform);
}

export function getConfigPath(): string {
  return _getConfigPath();
}

// ── Load / Save / Update ────────────────────────────────────────────────────

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".akm", "config.json");

let cachedConfig: { config: AkmConfig; signature: string } | undefined;
let cachedUserConfig: { config: AkmConfig; path: string; mtime: number; size: number; contentHash: string } | undefined;

export function resetConfigCache(): void {
  cachedConfig = undefined;
  cachedUserConfig = undefined;
}

function hashString(text: string): string {
  // Simple, fast non-cryptographic hash (FNV-1a 32-bit) — sufficient to detect
  // content changes between config writes when filesystem mtime resolution is
  // too coarse to reflect rapid back-to-back writes (common in tests).
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function loadUserConfig(): AkmConfig {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch {
    cachedUserConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
  }

  // Cache key combines mtimeMs + size + content hash. mtimeMs alone is unreliable
  // when tests write multiple times within the filesystem mtime resolution
  // window (often 1ms+). Reading + hashing on cache miss is cheap and ensures
  // we never serve stale config.
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    cachedUserConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
  }
  const contentHash = hashString(text);

  if (
    cachedUserConfig &&
    cachedUserConfig.path === configPath &&
    cachedUserConfig.mtime === stat.mtimeMs &&
    cachedUserConfig.size === stat.size &&
    cachedUserConfig.contentHash === contentHash
  ) {
    return cachedUserConfig.config;
  }

  const config = mergeLoadedConfig(DEFAULT_CONFIG, readNormalizedConfigFromText(text));
  const finalConfig = applyRuntimeEnvApiKeys(config);
  cachedUserConfig = {
    config: finalConfig,
    path: configPath,
    mtime: stat.mtimeMs,
    size: stat.size,
    contentHash,
  };
  return finalConfig;
}

export function loadConfig(): AkmConfig {
  const configPaths = getEffectiveConfigPaths();
  const signature = getConfigSignature(configPaths);
  if (cachedConfig && cachedConfig.signature === signature) {
    return cachedConfig.config;
  }

  let config = loadUserConfig();
  const userConfigPath = getConfigPath();
  for (const configPath of configPaths) {
    if (configPath === userConfigPath) continue;
    config = mergeLoadedConfig(config, readNormalizedConfig(configPath));
  }

  const finalConfig = applyRuntimeEnvApiKeys(config);
  cachedConfig = { config: finalConfig, signature };
  return finalConfig;
}

export function saveConfig(config: AkmConfig): void {
  cachedConfig = undefined;
  cachedUserConfig = undefined;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const sanitized = sanitizeConfigForWrite(config);
  writeConfigObject(configPath, sanitized);
}

/**
 * Strip apiKey fields before writing config to disk.
 * API keys should be provided via environment variables
 * AKM_EMBED_API_KEY and AKM_LLM_API_KEY.
 */
function sanitizeConfigForWrite(config: AkmConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  if (config.embedding) {
    const { apiKey, ...rest } = config.embedding;
    sanitized.embedding = rest;
  }
  if (config.llm) {
    const { apiKey, ...rest } = config.llm;
    sanitized.llm = rest;
  }
  // Drop empty keys to keep config clean
  return sanitized;
}

export function updateConfig(partial: Partial<AkmConfig>): AkmConfig {
  const current = loadUserConfig();
  // Shallow-merge for top-level scalar fields; deep-merge known object-type config keys.
  const merged: AkmConfig = { ...current, ...partial };
  // Deep-merge output — partial update should not wipe sibling keys
  if (current.output && partial.output && partial.output !== current.output) {
    merged.output = { ...current.output, ...partial.output };
  }
  // Deep-merge embedding — only when both sides are objects and partial does not intend to clear
  if (current.embedding && partial.embedding && partial.embedding !== current.embedding) {
    merged.embedding = { ...current.embedding, ...partial.embedding };
  }
  // Deep-merge llm — same pattern
  if (current.llm && partial.llm && partial.llm !== current.llm) {
    merged.llm = { ...current.llm, ...partial.llm };
  }
  // Deep-merge index per-pass entries so partial updates don't wipe siblings.
  if (current.index && partial.index && partial.index !== current.index) {
    const mergedIndex: IndexConfig = { ...current.index };
    for (const [passName, passOverride] of Object.entries(partial.index)) {
      mergedIndex[passName] = { ...(mergedIndex[passName] ?? {}), ...passOverride };
    }
    merged.index = mergedIndex;
  }
  if (current.security && partial.security && partial.security !== current.security) {
    merged.security = mergeSecurityConfig(current.security, partial.security);
  }
  saveConfig(merged);
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a raw config object into a sparse config layer containing only
 * recognized keys that were valid in the source object. This function does not
 * merge with DEFAULT_CONFIG; callers are responsible for layering defaults and
 * combining multiple config sources so project config files only override what
 * they set.
 */
function pickKnownKeys(raw: Record<string, unknown>): Partial<AkmConfig> {
  const config: Partial<AkmConfig> = {};

  if (Array.isArray(raw.stashes)) {
    throw new ConfigError(
      "The legacy `stashes[]` config key is no longer supported; rename it to `sources[]`.",
      "INVALID_CONFIG_FILE",
      `Edit ${_getConfigPath()} and replace \`stashes\` with \`sources\`.`,
    );
  }

  if (typeof raw.stashDir === "string" && raw.stashDir.trim()) {
    config.stashDir = raw.stashDir.trim();
  }

  // Backward compatibility: coerce legacy boolean values to string
  if (typeof raw.semanticSearchMode === "boolean") {
    config.semanticSearchMode = raw.semanticSearchMode ? "auto" : "off";
  } else if (raw.semanticSearchMode === "off" || raw.semanticSearchMode === "auto") {
    config.semanticSearchMode = raw.semanticSearchMode;
  }

  const embedding = parseEmbeddingConfig(raw.embedding);
  if (embedding) config.embedding = embedding;

  const llm = parseLlmConfig(raw.llm);
  if (llm) config.llm = llm;

  const index = parseIndexConfig(raw.index);
  if (index) config.index = index;

  const installed = parseInstalledEntries(raw.installed);
  if (installed) config.installed = installed;

  const registries = parseRegistriesConfig(raw.registries);
  if (registries) config.registries = registries;

  if (raw.stashInheritance === "replace" || raw.stashInheritance === "merge") {
    config.stashInheritance = raw.stashInheritance;
  }

  const sources = parseSourcesConfig(raw.sources);
  if (sources) {
    config.sources = sources;
  }

  const security = parseSecurityConfig(raw.security);
  if (security) config.security = security;

  const output = parseOutputConfig(raw.output);
  if (output) config.output = output;

  if (typeof raw.writable === "boolean") {
    config.writable = raw.writable;
  }

  if (typeof raw.defaultWriteTarget === "string" && raw.defaultWriteTarget.trim()) {
    config.defaultWriteTarget = raw.defaultWriteTarget.trim();
  }

  if ("agent" in raw) {
    const agent = parseAgentConfig(raw.agent);
    if (agent) config.agent = agent;
  }

  if (typeof raw.search === "object" && raw.search !== null && !Array.isArray(raw.search)) {
    const searchRaw = raw.search as Record<string, unknown>;
    const searchConfig: AkmConfig["search"] = {};
    if (typeof searchRaw.minScore === "number" && Number.isFinite(searchRaw.minScore) && searchRaw.minScore >= 0) {
      searchConfig.minScore = searchRaw.minScore;
    }
    if (Object.keys(searchConfig).length > 0) config.search = searchConfig;
  }

  return config;
}

function readNormalizedConfig(configPath: string): Partial<AkmConfig> | undefined {
  const raw = readConfigObject(configPath);
  const expanded = raw ? expandEnvVars(raw) : undefined;
  return expanded ? pickKnownKeys(expanded) : undefined;
}

function readNormalizedConfigFromText(text: string): Partial<AkmConfig> | undefined {
  const raw = parseConfigObjectFromText(text);
  if (!raw) return undefined;
  const expanded = expandEnvVars(raw);
  return pickKnownKeys(expanded);
}

function parseOutputConfig(value: unknown): OutputConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const output: OutputConfig = {};

  if (obj.format === "json" || obj.format === "yaml" || obj.format === "text") {
    output.format = obj.format;
  }

  if (obj.detail === "brief" || obj.detail === "normal" || obj.detail === "full") {
    output.detail = obj.detail;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Field names that hold URLs and must NOT have env var substitution applied.
 * Expanding ${VAR} inside a URL could leak secrets by redirecting requests to
 * an attacker-controlled server if the config file is world-readable.
 */
const URL_FIELD_NAMES = new Set(["url", "endpoint", "artifactUrl"]);

/**
 * Recursively expand `${VAR}` references in all string values.
 * Supports `${VAR}`, `${VAR:-default}`, and bare `$VAR` at the start of a value.
 * Non-string values pass through unchanged.
 *
 * URL-type fields (named `url`, `endpoint`, `artifactUrl`, or whose value starts
 * with `http://` / `https://`) are skipped to prevent secret injection into URLs.
 */
function expandEnvVars<T>(value: T, fieldName?: string): T {
  if (typeof value === "string") {
    // Skip URL-type fields by name or by value prefix, unless they contain ${VAR} syntax
    if (
      !value.includes("${") &&
      ((fieldName !== undefined && URL_FIELD_NAMES.has(fieldName)) ||
        value.startsWith("http://") ||
        value.startsWith("https://"))
    ) {
      return value;
    }
    return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
      if (braced) {
        const [name, ...rest] = braced.split(":-");
        const fallback = rest.join(":-");
        return process.env[name] ?? fallback ?? "";
      }
      return process.env[bare] ?? "";
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVars(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v, k);
    }
    return out as T;
  }
  return value;
}

function readConfigObject(configPath: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return parseConfigObjectFromText(text);
  } catch {
    return undefined;
  }
}

function parseConfigObjectFromText(text: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(stripJsonComments(text));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writeConfigObject(configPath: string, config: Record<string, unknown>): void {
  const tmpPath = `${configPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Strip JavaScript-style comments from a JSON string (JSONC support).
 * Handles // line comments and /* block comments while preserving
 * comment-like sequences inside quoted strings.
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i] + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    // JSON only uses double-quoted strings; single quotes are not valid JSON
    if (text[i] === '"') {
      inString = true;
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

function parseEmbeddingConfig(value: unknown): EmbeddingConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  // Extract localModel early — it's valid even without a remote endpoint
  const localModel = typeof obj.localModel === "string" && obj.localModel ? obj.localModel : undefined;

  // If no endpoint is provided, the config is only valid when localModel is set
  // (local-only embedding configuration).
  // Sentinel: { endpoint: "", model: "" } means "local-only" — use hasRemoteEndpoint()
  // (in embedder.ts) to distinguish from a real remote config. Do NOT check
  // endpoint/model directly in consuming code.
  if (typeof obj.endpoint !== "string" || !obj.endpoint) {
    if (localModel) {
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  if (!obj.endpoint.startsWith("http://") && !obj.endpoint.startsWith("https://")) {
    warn(`[akm] Ignoring embedding config: endpoint must start with http:// or https://, got "${obj.endpoint}"`);
    // Still return localModel-only config if localModel was set
    if (localModel) {
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  if (typeof obj.model !== "string" || !obj.model) {
    // No remote model, but localModel may still be valid
    if (localModel) {
      warn(
        `[akm] Embedding endpoint "${obj.endpoint as string}" ignored: model is required for remote embeddings. Using local model only.`,
      );
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  const result: EmbeddingConnectionConfig = {
    endpoint: obj.endpoint,
    model: obj.model,
  };
  if (typeof obj.provider === "string" && obj.provider) {
    result.provider = obj.provider;
  }
  if ("dimension" in obj) {
    if (
      typeof obj.dimension !== "number" ||
      !Number.isFinite(obj.dimension) ||
      !Number.isInteger(obj.dimension) ||
      obj.dimension <= 0
    ) {
      return undefined;
    }
    result.dimension = obj.dimension;
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey;
  }
  if (localModel) {
    result.localModel = localModel;
  }
  if ("contextLength" in obj) {
    if (
      typeof obj.contextLength !== "number" ||
      !Number.isFinite(obj.contextLength) ||
      !Number.isInteger(obj.contextLength) ||
      obj.contextLength <= 0
    ) {
      return undefined;
    }
    result.contextLength = obj.contextLength;
  }
  if (typeof obj.ollamaOptions === "object" && obj.ollamaOptions !== null && !Array.isArray(obj.ollamaOptions)) {
    const opts = obj.ollamaOptions as Record<string, unknown>;
    const parsed: EmbeddingConnectionConfig["ollamaOptions"] = {};
    if (
      typeof opts.num_ctx === "number" &&
      Number.isFinite(opts.num_ctx) &&
      Number.isInteger(opts.num_ctx) &&
      opts.num_ctx > 0
    ) {
      parsed.num_ctx = opts.num_ctx;
    }
    if (Object.keys(parsed).length > 0) {
      result.ollamaOptions = parsed;
    }
  }
  return result;
}

function parseLlmConfig(value: unknown): LlmConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined;
  if (!obj.endpoint.startsWith("http://") && !obj.endpoint.startsWith("https://")) {
    warn(`[akm] Ignoring llm config: endpoint must start with http:// or https://, got "${obj.endpoint}"`);
    return undefined;
  }
  const model = typeof obj.model === "string" ? obj.model : "";
  const result: LlmConnectionConfig = {
    endpoint: obj.endpoint,
    model,
  };
  if (typeof obj.provider === "string" && obj.provider) {
    result.provider = obj.provider;
  }
  if (typeof obj.temperature === "number" && Number.isFinite(obj.temperature)) {
    result.temperature = obj.temperature;
  }
  if ("maxTokens" in obj) {
    if (
      typeof obj.maxTokens !== "number" ||
      !Number.isFinite(obj.maxTokens) ||
      !Number.isInteger(obj.maxTokens) ||
      obj.maxTokens <= 0
    ) {
      return undefined;
    }
    result.maxTokens = obj.maxTokens;
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey;
  }
  if (typeof obj.capabilities === "object" && obj.capabilities !== null && !Array.isArray(obj.capabilities)) {
    const capsRaw = obj.capabilities as Record<string, unknown>;
    const caps: LlmConnectionConfig["capabilities"] = {};
    if (typeof capsRaw.structuredOutput === "boolean") caps.structuredOutput = capsRaw.structuredOutput;
    if (Object.keys(caps).length > 0) result.capabilities = caps;
  }
  if (typeof obj.features === "object" && obj.features !== null && !Array.isArray(obj.features)) {
    const features = parseLlmFeatures(obj.features as Record<string, unknown>);
    if (Object.keys(features).length > 0) result.features = features;
  }
  if (typeof obj.extraParams === "object" && obj.extraParams !== null && !Array.isArray(obj.extraParams)) {
    result.extraParams = obj.extraParams as Record<string, unknown>;
  }
  return result;
}

/**
 * v1 spec §14 — locked feature keys. Defined here so unknown keys can
 * be warn-and-ignored at load time (per spec §14.3 / §9.2). The set is
 * deliberately the *full* locked table even though only a subset has
 * runtime parsing today; this lets users author future-flagged configs
 * without spurious warnings.
 */
const LOCKED_LLM_FEATURE_KEYS: ReadonlySet<string> = new Set([
  "curate_rerank",
  "feedback_distillation",
  "memory_inference",
  "graph_extraction",
]);

function parseLlmFeatures(raw: Record<string, unknown>): LlmFeatureFlags {
  const out: LlmFeatureFlags = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LOCKED_LLM_FEATURE_KEYS.has(key)) {
      warn(`[akm] Ignoring unknown llm.features key "${key}".`);
      continue;
    }
    if (typeof value !== "boolean") {
      warn(`[akm] Ignoring llm.features.${key}: expected boolean, got ${typeof value}.`);
      continue;
    }
    switch (key) {
      case "memory_inference":
        out.memory_inference = value;
        break;
      case "graph_extraction":
        out.graph_extraction = value;
        break;
      case "curate_rerank":
        out.curate_rerank = value;
        break;
      case "feedback_distillation":
        out.feedback_distillation = value;
        break;
      // No default: LOCKED_LLM_FEATURE_KEYS is the source of truth for which
      // keys are accepted. Adding a new locked key requires an arm here AND a
      // field on LlmFeatureFlags above.
    }
  }
  return out;
}

/**
 * Keys that, if present anywhere under `index.<pass>`, indicate the user is
 * trying to supply a parallel LLM provider configuration. Per #208 this is
 * deliberately rejected at load time so there is exactly one place to
 * configure the LLM (`akm.llm`).
 */
const PROVIDER_CONFIG_KEYS = new Set([
  "endpoint",
  "model",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
]);

/**
 * Parse the `index` config block. Each entry is a pass name → small object
 * `{ llm?: boolean }`. Anything richer (a parallel provider config, unknown
 * keys, non-boolean `llm`) throws `ConfigError("INVALID_CONFIG_FILE")` at
 * load time so the failure is visible at startup, not on the next index run.
 */
function parseIndexConfig(value: unknown): IndexConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "enrichment": { "llm": false } }`).',
      "INVALID_CONFIG_FILE",
    );
  }

  const out: IndexConfig = {};
  for (const [passName, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError(
        `Invalid \`index.${passName}\` config: expected an object like \`{ "llm": false }\`.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const passRaw = raw as Record<string, unknown>;

    // Reject any provider-shaped key — there must be exactly one place to
    // configure the LLM (#208). This is the duplicate-provider guard.
    for (const key of Object.keys(passRaw)) {
      if (PROVIDER_CONFIG_KEYS.has(key)) {
        throw new ConfigError(
          `Duplicate LLM provider configuration: \`index.${passName}.${key}\` is not allowed. ` +
            "Configure provider/model/endpoint under top-level `llm` only; per-pass entries support `{ llm: false }` opt-out.",
          "INVALID_CONFIG_FILE",
          'Move provider settings to the top-level "llm" block, then set `index.<pass>.llm = false` to opt a single pass out.',
        );
      }
      if (key !== "llm") {
        throw new ConfigError(
          `Unknown key \`index.${passName}.${key}\`. Per-pass entries only support \`llm\` (boolean opt-out).`,
          "INVALID_CONFIG_FILE",
        );
      }
    }

    const passConfig: IndexPassConfig = {};
    if ("llm" in passRaw) {
      const llmFlag = passRaw.llm;
      if (typeof llmFlag !== "boolean") {
        throw new ConfigError(
          `Invalid \`index.${passName}.llm\`: expected a boolean (true to use \`akm.llm\`, false to opt out). Got ${typeof llmFlag}.`,
          "INVALID_CONFIG_FILE",
          "Per-pass alternative provider config is intentionally unsupported in v1 (#208). Use `false` to disable LLM for this pass.",
        );
      }
      passConfig.llm = llmFlag;
    }
    out[passName] = passConfig;
  }
  return out;
}

function parseInstalledEntries(value: unknown): InstalledStashEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseInstalledStashEntry(entry))
    .filter((entry): entry is InstalledStashEntry => entry !== undefined);

  return entries.length > 0 ? entries : undefined;
}

function parseInstalledStashEntry(value: unknown): InstalledStashEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const id = asNonEmptyString(obj.id);
  const source = asKitSource(obj.source);
  const ref = asNonEmptyString(obj.ref);
  const artifactUrl = asNonEmptyString(obj.artifactUrl);
  const stashRoot = asNonEmptyString(obj.stashRoot);
  const cacheDir = asNonEmptyString(obj.cacheDir);
  const installedAt = asNonEmptyString(obj.installedAt);
  if (!id || !source || !ref || !artifactUrl || !stashRoot || !cacheDir || !installedAt) return undefined;

  const entry: InstalledStashEntry = {
    id,
    source,
    ref,
    artifactUrl,
    stashRoot,
    cacheDir,
    installedAt,
  };
  if (typeof obj.writable === "boolean") entry.writable = obj.writable;
  if (entry.writable === true && entry.source !== "git") {
    throw new ConfigError(
      `writable: true is only supported on filesystem and git sources (got "${entry.source}" on installed entry "${entry.id}").`,
      "INVALID_CONFIG_FILE",
      "Remove `writable: true` from the installed entry or re-add it as a git source instead.",
    );
  }
  const resolvedVersion = asNonEmptyString(obj.resolvedVersion);
  if (resolvedVersion) entry.resolvedVersion = resolvedVersion;
  const resolvedRevision = asNonEmptyString(obj.resolvedRevision);
  if (resolvedRevision) entry.resolvedRevision = resolvedRevision;
  const wikiName = asNonEmptyString(obj.wikiName);
  if (wikiName) entry.wikiName = wikiName;
  return entry;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Validate a legacy lockfile/installed-entry source string.
 *
 * Restricted to the four kinds that the install pipeline produces
 * (`"npm" | "github" | "git" | "local"`). The full {@link KitSource} union is
 * wider, but persisted `installed[]` entries should never carry the runtime
 * provider kinds (`"filesystem" | "website"`).
 */
function asKitSource(value: unknown): KitSource | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value as KitSource;
  return undefined;
}

function parseRegistriesConfig(value: unknown): RegistryConfigEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseRegistryConfigEntry(entry))
    .filter((entry): entry is RegistryConfigEntry => entry !== undefined);

  // Return the array even if empty — an explicit empty array means "no registries"
  // which overrides the default. Only return undefined if the field was not an array.
  return entries;
}

function parseSourcesConfig(value: unknown): SourceConfigEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseSourceConfigEntry(entry))
    .filter((entry): entry is SourceConfigEntry => entry !== undefined);

  return entries;
}

function parseSecurityConfig(value: unknown): SecurityConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const installAudit = parseInstallAuditConfig(obj.installAudit);
  if (!installAudit) return undefined;
  return { installAudit };
}

function parseInstallAuditConfig(value: unknown): InstallAuditConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const config: InstallAuditConfig = {};
  if (typeof obj.enabled === "boolean") config.enabled = obj.enabled;
  if (typeof obj.blockOnCritical === "boolean") config.blockOnCritical = obj.blockOnCritical;
  if (typeof obj.blockUnlistedRegistries === "boolean") config.blockUnlistedRegistries = obj.blockUnlistedRegistries;
  const rawAllowlist = filterNonEmptyStrings(obj.registryAllowlist) ?? filterNonEmptyStrings(obj.registryWhitelist);
  if (rawAllowlist) {
    config.registryAllowlist = rawAllowlist;
  }
  const allowedFindings = parseInstallAuditAllowedFindings(obj.allowedFindings);
  if (allowedFindings) {
    config.allowedFindings = allowedFindings;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function parseInstallAuditAllowedFindings(value: unknown): InstallAuditAllowedFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const findings = value
    .map((entry) => parseInstallAuditAllowedFinding(entry))
    .filter((entry): entry is InstallAuditAllowedFinding => entry !== undefined);
  return findings.length > 0 ? findings : undefined;
}

function parseInstallAuditAllowedFinding(value: unknown): InstallAuditAllowedFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const id = asNonEmptyString(obj.id);
  if (!id) return undefined;
  const finding: InstallAuditAllowedFinding = { id };
  const ref = asNonEmptyString(obj.ref);
  if (ref) finding.ref = ref;
  const entryPath = asNonEmptyString(obj.path);
  if (entryPath) finding.path = entryPath;
  const reason = asNonEmptyString(obj.reason);
  if (reason) finding.reason = reason;
  return finding;
}

function parseSourceConfigEntry(value: unknown): SourceConfigEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const type = asNonEmptyString(obj.type);
  if (!type) return undefined;

  if (type === "openviking") {
    const name = asNonEmptyString(obj.name) ?? "unnamed";
    throw new ConfigError(
      `openviking is not supported in akm v1. API-backed sources will return as a\nseparate QuerySource tier post-v1. Remove the source named "${name}" from your config file\nor downgrade to 0.6.x. See docs/migration/v1.md.`,
      "INVALID_CONFIG_FILE",
      `Run \`akm remove ${name}\` then re-run, or edit your config file directly at ${_getConfigPath()} to remove the openviking entry.`,
    );
  }

  const entry: SourceConfigEntry = { type };
  const entryPath = asNonEmptyString(obj.path);
  if (entryPath) entry.path = entryPath;
  const url = asNonEmptyString(obj.url);
  if (url) entry.url = url;
  const name = asNonEmptyString(obj.name);
  if (name) entry.name = name;
  if (typeof obj.enabled === "boolean") entry.enabled = obj.enabled;
  if (typeof obj.writable === "boolean") entry.writable = obj.writable;
  if (typeof obj.primary === "boolean") entry.primary = obj.primary;
  // Locked decision 4 (§6 v1 implementation plan): reject writable: true on
  // website / npm sources at config load. The next sync() would clobber
  // writes — allowing this is a footgun, not a feature. Throw early so the
  // user sees the problem at `akm` startup, not when they try to write.
  if (entry.writable === true && (type === "website" || type === "npm")) {
    const label = entry.name ? ` "${entry.name}"` : "";
    throw new ConfigError(
      `writable: true is only supported on filesystem and git sources (got "${type}" on source${label}).`,
      "INVALID_CONFIG_FILE",
      "To author into a checked-out package, add the same path as a separate filesystem source.",
    );
  }
  if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
    entry.options = obj.options as Record<string, unknown>;
  }
  const wikiName = asNonEmptyString(obj.wikiName);
  if (wikiName) entry.wikiName = wikiName;
  return entry;
}

// ── ConfiguredSource runtime construction ─────────────────────────────────────────

/**
 * Synthesize a stable identifier when a {@link SourceConfigEntry} omits its
 * `name`. Uses a short hash of the discriminating fields so two equivalent
 * entries collapse to the same generated name.
 */
function deriveStashEntryName(entry: SourceConfigEntry): string {
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
 * {@link SourceSpec} discriminated union. Returns `undefined` when the
 * entry is missing the fields its provider type requires (e.g. a
 * `filesystem` entry with no `path`); callers should drop or warn for those.
 *
 * Unknown provider types fall back to `{ type: "filesystem", path: ... }` when
 * a `path` is supplied, so future provider types still produce a usable
 * runtime value.
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
      // Persisted `npm` stash entries are unusual but supported for symmetry.
      return entry.path ? { type: "npm", package: entry.path } : undefined;
    default:
      // Unknown provider — best-effort fallback so callers still get something.
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
  }
}

/**
 * Build the full ordered list of runtime {@link ConfiguredSource} values from a
 * loaded {@link AkmConfig}. Order is the canonical iteration order:
 *
 *   1. The entry marked `primary: true` (or, as a backwards-compat shim,
 *      a synthetic filesystem entry built from the top-level `stashDir`).
 *   2. Remaining `sources[]` entries in declared order.
 *   3. Legacy `installed[]` entries, mapped into runtime entries.
 *
 * Entries with `enabled: false` are still emitted — callers decide whether
 * to honour the flag (mirrors how `installed[]` entries have always been
 * unconditional). Entries that fail {@link parseSourceSpec} are
 * dropped silently.
 */
export function resolveConfiguredSources(config: AkmConfig): ConfiguredSource[] {
  const entries: ConfiguredSource[] = [];
  const sources = config.sources ?? [];

  // (1) Primary entry: explicit `primary: true` wins; fall back to top-level stashDir.
  let primary = sources.find((entry) => entry.primary === true);
  if (!primary && config.stashDir) {
    primary = { type: "filesystem", path: config.stashDir, primary: true };
  }
  if (primary) {
    const runtime = toConfiguredSource(primary, true);
    if (runtime) entries.push(runtime);
  }

  // (2) Declared sources (skip the primary entry — already added).
  for (const entry of sources) {
    if (entry === primary) continue;
    const runtime = toConfiguredSource(entry, false);
    if (runtime) entries.push(runtime);
  }

  // (3) Legacy installed[] entries.
  for (const installed of config.installed ?? []) {
    entries.push({
      name: installed.id,
      type: "filesystem",
      source: { type: "filesystem", path: installed.stashRoot },
      enabled: true,
      writable: installed.writable,
      ...(installed.wikiName ? { wikiName: installed.wikiName } : {}),
    });
  }

  return entries;
}

function toConfiguredSource(persisted: SourceConfigEntry, isPrimary: boolean): ConfiguredSource | undefined {
  const source = parseSourceSpec(persisted);
  if (!source) return undefined;
  return {
    name: deriveStashEntryName(persisted),
    type: persisted.type,
    source,
    ...(persisted.enabled !== undefined ? { enabled: persisted.enabled } : {}),
    ...(persisted.writable !== undefined ? { writable: persisted.writable } : {}),
    ...(isPrimary || persisted.primary ? { primary: true } : {}),
    ...(persisted.options ? { options: persisted.options } : {}),
    ...(persisted.wikiName ? { wikiName: persisted.wikiName } : {}),
  };
}

function parseRegistryConfigEntry(value: unknown): RegistryConfigEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const url = asNonEmptyString(obj.url);
  if (!url?.startsWith("http")) return undefined;

  const entry: RegistryConfigEntry = { url };
  const name = asNonEmptyString(obj.name);
  if (name) entry.name = name;
  if (typeof obj.enabled === "boolean") entry.enabled = obj.enabled;
  const provider = asNonEmptyString(obj.provider);
  if (provider) entry.provider = provider;
  if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
    entry.options = obj.options as Record<string, unknown>;
  }
  return entry;
}

function mergeAgentConfig(base: AgentConfig, override: AgentConfig): AgentConfig {
  const merged: AgentConfig = { ...base, ...override };
  const baseProfiles = base.profiles;
  const overrideProfiles = override.profiles;
  if (baseProfiles && overrideProfiles) {
    const profiles: NonNullable<AgentConfig["profiles"]> = { ...baseProfiles };
    for (const [name, entry] of Object.entries(overrideProfiles)) {
      const existing = baseProfiles[name];
      profiles[name] = existing ? { ...existing, ...entry } : entry;
    }
    merged.profiles = profiles;
  }
  return merged;
}

function mergeSecurityConfig(base?: SecurityConfig, override?: SecurityConfig): SecurityConfig | undefined {
  if (!base && !override) return undefined;
  const installAudit = mergeInstallAuditConfig(base?.installAudit, override?.installAudit);
  return installAudit ? { installAudit } : undefined;
}

function mergeInstallAuditConfig(
  base?: InstallAuditConfig,
  override?: InstallAuditConfig,
): InstallAuditConfig | undefined {
  if (!base && !override) return undefined;
  const merged: InstallAuditConfig = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

/**
 * Merge a normalized config layer into an accumulated config.
 *
 * Scalar fields follow normal override semantics. Known nested objects are
 * deep-merged so project config files can override individual fields without
 * clobbering sibling settings. `sources` are additive by default, but a later
 * layer can set `stashInheritance: "replace"` to drop inherited sources first.
 */
function mergeLoadedConfig(base: AkmConfig, override?: Partial<AkmConfig>): AkmConfig {
  if (!override) return { ...base };

  const merged: AkmConfig = {
    ...base,
    ...override,
  };

  if (base.output && override.output) {
    merged.output = { ...base.output, ...override.output };
  }
  if (base.embedding && override.embedding) {
    merged.embedding = { ...base.embedding, ...override.embedding };
  }
  if (base.llm && override.llm) {
    merged.llm = { ...base.llm, ...override.llm };
  }
  if (base.index || override.index) {
    // Deep-merge per-pass entries so a project layer can opt one pass out
    // without dropping siblings configured in user config.
    const mergedIndex: IndexConfig = { ...(base.index ?? {}) };
    for (const [passName, passOverride] of Object.entries(override.index ?? {})) {
      mergedIndex[passName] = { ...(mergedIndex[passName] ?? {}), ...passOverride };
    }
    if (Object.keys(mergedIndex).length > 0) merged.index = mergedIndex;
  }
  if (base.security && override.security) {
    merged.security = mergeSecurityConfig(base.security, override.security);
  }
  if (base.agent && override.agent) {
    merged.agent = mergeAgentConfig(base.agent, override.agent);
  }
  const replaceSources = override.stashInheritance === "replace";
  const overrideSources = override.sources ?? [];
  const baseSources = base.sources ?? [];
  if (replaceSources) {
    merged.sources = [...overrideSources];
  } else if (overrideSources.length > 0) {
    merged.sources = [...baseSources, ...overrideSources];
  } else if (baseSources.length > 0) {
    merged.sources = [...baseSources];
  }

  return merged;
}

function applyRuntimeEnvApiKeys(config: AkmConfig): AkmConfig {
  const next = { ...config };

  if (next.embedding && !next.embedding.apiKey) {
    const envKey = process.env.AKM_EMBED_API_KEY?.trim();
    if (envKey) next.embedding = { ...next.embedding, apiKey: envKey };
  }
  if (next.llm && !next.llm.apiKey) {
    const envKey = process.env.AKM_LLM_API_KEY?.trim();
    if (envKey) next.llm = { ...next.llm, apiKey: envKey };
  }

  return next;
}

/**
 * Return config file paths in merge order: user config first, then project
 * config files from the outermost parent directory down to the current working
 * directory. Later entries have higher precedence when merged.
 */
function getEffectiveConfigPaths(): string[] {
  const configPath = getConfigPath();
  const paths: string[] = [];
  if (isFile(configPath)) {
    paths.push(configPath);
  }
  return [...paths, ...discoverProjectConfigPaths(process.cwd())];
}

/**
 * Walk from `startDir` up to the filesystem root and collect `.akm/config.json`
 * files. Paths are returned from outermost parent to innermost directory so
 * nearer project directories override broader project settings.
 */
function discoverProjectConfigPaths(startDir: string): string[] {
  const paths: string[] = [];
  let currentDir = path.resolve(startDir);

  while (true) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_RELATIVE_PATH);
    if (isFile(configPath)) {
      paths.unshift(configPath);
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return paths;
}

function getConfigSignature(configPaths: string[]): string {
  if (configPaths.length === 0) return "defaults";
  return configPaths.map((configPath) => `${configPath}:${getFileSignatureToken(configPath)}`).join("|");
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getFileSignatureToken(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    // mtimeMs alone is unreliable on filesystems with low-resolution mtime
    // (HFS+, some network FS, or very fast back-to-back writes in tests).
    // Combine mtime + size + content hash so the signature actually changes
    // when content does.
    let contentHash = "";
    try {
      contentHash = hashString(fs.readFileSync(filePath, "utf8"));
    } catch {
      // ignore — fall back to stat-only signature
    }
    return `${stat.mtimeMs}:${stat.size}:${contentHash}`;
  } catch {
    return "missing";
  }
}
