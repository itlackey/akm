import fs from "node:fs";
import path from "node:path";
import { filterNonEmptyStrings } from "./common";
import { getConfigDir as _getConfigDir, getConfigPath as _getConfigPath } from "./paths";
import type { InstalledKitEntry, KitSource } from "./registry-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingConnectionConfig {
  /** Provider name for display (e.g. "openai", "ollama") */
  provider?: string;
  /** OpenAI-compatible embeddings endpoint (e.g. "http://localhost:11434/v1/embeddings") */
  endpoint: string;
  /** Model name to use for remote embeddings (e.g. "nomic-embed-text") */
  model: string;
  /** Optional output dimension for providers that support it */
  dimension?: number;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Optional local transformer model name (e.g. "Xenova/bge-small-en-v1.5"). Overrides the default when using local embeddings. */
  localModel?: string;
}

export interface LlmCapabilities {
  /** Model emits strict JSON reliably (probed during setup). */
  structuredOutput?: boolean;
  /** Model handles long-context inputs (>32k tokens). */
  longContext?: boolean;
  /** Model supports tool/function calling. */
  toolUse?: boolean;
}

export interface LlmConnectionConfig {
  /** Provider name for display (e.g. "openai", "anthropic", "google", "ollama") */
  provider?: string;
  /** OpenAI-compatible chat completions endpoint (e.g. "http://localhost:11434/v1/chat/completions") */
  endpoint: string;
  /** Model name to use (e.g. "llama3.2") */
  model: string;
  /** Optional sampling temperature */
  temperature?: number;
  /** Optional response token limit */
  maxTokens?: number;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Approximate context window in tokens. Used to size ingest/lint chunks. */
  contextWindow?: number;
  /** Capability flags learned at setup time; consumed by knowledge-wiki ingest/lint. */
  capabilities?: LlmCapabilities;
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

export interface StashConfigEntry {
  /** Provider type (e.g. "filesystem", "openviking", "context-hub") */
  type: string;
  /** Filesystem path (for type: "filesystem") */
  path?: string;
  /** URL (for remote providers like openviking) */
  url?: string;
  /** Human-friendly label */
  name?: string;
  /** Whether this stash is active. Default: true */
  enabled?: boolean;
  /** Arbitrary provider-specific options */
  options?: Record<string, unknown>;
}

export interface InstallAuditConfig {
  enabled?: boolean;
  blockOnCritical?: boolean;
  blockUnlistedRegistries?: boolean;
  registryAllowlist?: string[];
  registryWhitelist?: string[];
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
  /** Installed kits (from npm, GitHub, git, or local sources) */
  installed?: InstalledKitEntry[];
  /**
   * Configured registries for kit discovery.
   * - `undefined` (field absent): use the built-in default registries.
   * - `[]` (explicit empty array): disable all registries (no registry search).
   * - `[...]` (non-empty array): use exactly the listed registries, overriding defaults.
   */
  registries?: RegistryConfigEntry[];
  /**
   * When true on a later config layer (typically project config), discard
   * inherited stashes from earlier layers before applying `stashes`.
   */
  disableGlobalStashes?: boolean;
  /** Additional stash sources (filesystem paths and remote providers) */
  stashes?: StashConfigEntry[];
  /** Security controls for install-time auditing and registry allowlists */
  security?: SecurityConfig;
  /** Output defaults for CLI rendering */
  output?: OutputConfig;
}

export interface OutputConfig {
  format?: "json" | "yaml" | "text";
  detail?: "brief" | "normal" | "full";
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AkmConfig = {
  semanticSearchMode: "auto",
  registries: [
    { url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", name: "official" },
    { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh" },
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
let cachedUserConfig: { config: AkmConfig; path: string; mtime: number } | undefined;

export function resetConfigCache(): void {
  cachedConfig = undefined;
  cachedUserConfig = undefined;
}

export function loadUserConfig(): AkmConfig {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
    if (cachedUserConfig && cachedUserConfig.path === configPath && cachedUserConfig.mtime === stat.mtimeMs) {
      return cachedUserConfig.config;
    }
  } catch {
    cachedUserConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
  }

  const config = mergeLoadedConfig(DEFAULT_CONFIG, readNormalizedConfig(configPath));
  const finalConfig = applyRuntimeEnvApiKeys(config);
  cachedUserConfig = { config: finalConfig, path: configPath, mtime: stat.mtimeMs };
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
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const sanitized = sanitizeConfigForWrite(config);
  const tmpPath = `${configPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
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

  if (typeof raw.stashDir === "string" && raw.stashDir.trim()) {
    config.stashDir = raw.stashDir.trim();
  }

  // Backward compatibility: coerce legacy boolean values to string
  if (typeof raw.semanticSearchMode === "boolean") {
    config.semanticSearchMode = raw.semanticSearchMode ? "auto" : "off";
  } else if (raw.semanticSearchMode === "off" || raw.semanticSearchMode === "auto") {
    config.semanticSearchMode = raw.semanticSearchMode;
  } else if (typeof (raw as { semanticSearch?: unknown }).semanticSearch === "boolean") {
    // Legacy config: older versions used `semanticSearch` (boolean) instead of `semanticSearchMode`
    const legacySemanticSearch = (raw as { semanticSearch: boolean }).semanticSearch;
    config.semanticSearchMode = legacySemanticSearch ? "auto" : "off";
  }

  // Migrate legacy searchPaths into stashes
  if (Array.isArray(raw.searchPaths)) {
    const legacyPaths = raw.searchPaths.filter((d): d is string => typeof d === "string");
    if (legacyPaths.length > 0) {
      const existing = config.stashes ?? [];
      const migrated: StashConfigEntry[] = legacyPaths
        .filter((p) => !existing.some((s) => s.type === "filesystem" && s.path === p))
        .map((p) => ({ type: "filesystem", path: p }));
      if (migrated.length > 0) {
        config.stashes = [...existing, ...migrated];
      }
    }
  }

  const embedding = parseEmbeddingConfig(raw.embedding);
  if (embedding) config.embedding = embedding;

  const llm = parseLlmConfig(raw.llm);
  if (llm) config.llm = llm;

  const installed = parseInstalledEntries(raw.installed);
  if (installed) config.installed = installed;

  const registries = parseRegistriesConfig(raw.registries);
  if (registries) config.registries = registries;

  if (typeof raw.disableGlobalStashes === "boolean") {
    config.disableGlobalStashes = raw.disableGlobalStashes;
  }

  const stashes = parseStashesConfig(raw.stashes);
  if (stashes) config.stashes = stashes;

  const security = parseSecurityConfig(raw.security);
  if (security) config.security = security;

  const output = parseOutputConfig(raw.output);
  if (output) config.output = output;

  return config;
}

function readNormalizedConfig(configPath: string): Partial<AkmConfig> | undefined {
  const raw = readConfigObject(configPath);
  const expanded = raw ? expandEnvVars(raw) : undefined;
  return expanded ? pickKnownKeys(expanded) : undefined;
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
    const raw = JSON.parse(stripJsonComments(text));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
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
    console.warn(
      `[akm] Ignoring embedding config: endpoint must start with http:// or https://, got "${obj.endpoint}"`,
    );
    // Still return localModel-only config if localModel was set
    if (localModel) {
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  if (typeof obj.model !== "string" || !obj.model) {
    // No remote model, but localModel may still be valid
    if (localModel) {
      console.warn(
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
  return result;
}

function parseLlmConfig(value: unknown): LlmConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined;
  if (!obj.endpoint.startsWith("http://") && !obj.endpoint.startsWith("https://")) {
    console.warn(`[akm] Ignoring llm config: endpoint must start with http:// or https://, got "${obj.endpoint}"`);
    return undefined;
  }
  if (typeof obj.model !== "string" || !obj.model) return undefined;
  const result: LlmConnectionConfig = {
    endpoint: obj.endpoint,
    model: obj.model,
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
  if (
    typeof obj.contextWindow === "number" &&
    Number.isFinite(obj.contextWindow) &&
    Number.isInteger(obj.contextWindow) &&
    obj.contextWindow > 0
  ) {
    result.contextWindow = obj.contextWindow;
  }
  if (typeof obj.capabilities === "object" && obj.capabilities !== null && !Array.isArray(obj.capabilities)) {
    const capsRaw = obj.capabilities as Record<string, unknown>;
    const caps: LlmConnectionConfig["capabilities"] = {};
    if (typeof capsRaw.structuredOutput === "boolean") caps.structuredOutput = capsRaw.structuredOutput;
    if (typeof capsRaw.longContext === "boolean") caps.longContext = capsRaw.longContext;
    if (typeof capsRaw.toolUse === "boolean") caps.toolUse = capsRaw.toolUse;
    if (Object.keys(caps).length > 0) result.capabilities = caps;
  }
  return result;
}

function parseInstalledEntries(value: unknown): InstalledKitEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseInstalledKitEntry(entry))
    .filter((entry): entry is InstalledKitEntry => entry !== undefined);

  return entries.length > 0 ? entries : undefined;
}

function parseInstalledKitEntry(value: unknown): InstalledKitEntry | undefined {
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

  const entry: InstalledKitEntry = {
    id,
    source,
    ref,
    artifactUrl,
    stashRoot,
    cacheDir,
    installedAt,
  };
  const resolvedVersion = asNonEmptyString(obj.resolvedVersion);
  if (resolvedVersion) entry.resolvedVersion = resolvedVersion;
  const resolvedRevision = asNonEmptyString(obj.resolvedRevision);
  if (resolvedRevision) entry.resolvedRevision = resolvedRevision;
  return entry;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

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

function parseStashesConfig(value: unknown): StashConfigEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseStashConfigEntry(entry))
    .filter((entry): entry is StashConfigEntry => entry !== undefined);

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
  return Object.keys(config).length > 0 ? config : undefined;
}

function parseStashConfigEntry(value: unknown): StashConfigEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const type = asNonEmptyString(obj.type);
  if (!type) return undefined;

  const entry: StashConfigEntry = { type };
  const entryPath = asNonEmptyString(obj.path);
  if (entryPath) entry.path = entryPath;
  const url = asNonEmptyString(obj.url);
  if (url) entry.url = url;
  const name = asNonEmptyString(obj.name);
  if (name) entry.name = name;
  if (typeof obj.enabled === "boolean") entry.enabled = obj.enabled;
  if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
    entry.options = obj.options as Record<string, unknown>;
  }
  return entry;
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
 * clobbering sibling settings. `stashes` are additive by default, but a later
 * layer can set `disableGlobalStashes: true` to drop inherited stashes first.
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
  if (base.security && override.security) {
    merged.security = mergeSecurityConfig(base.security, override.security);
  }
  if (override.disableGlobalStashes) {
    merged.stashes = [...(override.stashes ?? [])];
  } else if (override.stashes) {
    merged.stashes = [...(base.stashes ?? []), ...override.stashes];
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
    return String(fs.statSync(filePath).mtimeMs);
  } catch {
    return "missing";
  }
}
