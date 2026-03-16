import fs from "node:fs";
import path from "node:path";
import { getConfigDir as _getConfigDir, getConfigPath as _getConfigPath } from "./paths";
import type { InstalledKitEntry, KitSource } from "./registry-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingConnectionConfig {
  /** Provider name for display (e.g. "openai", "ollama") */
  provider?: string;
  /** OpenAI-compatible embeddings endpoint (e.g. "http://localhost:11434/v1/embeddings") */
  endpoint: string;
  /** Model name to use for embeddings (e.g. "nomic-embed-text") */
  model: string;
  /** Optional output dimension for providers that support it */
  dimension?: number;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
}

export interface LlmConnectionConfig {
  /** Provider name for display (e.g. "openai", "ollama") */
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
  /** Provider type (e.g. "filesystem", "openviking") */
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

export interface AgentikitConfig {
  /** Path to the working stash directory. Resolved from env → config → default. */
  stashDir?: string;
  /** Whether semantic search is enabled. Default: true */
  semanticSearch: boolean;
  /** User-configured additional stash directories to search */
  searchPaths: string[];
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @xenova/transformers */
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
   * @deprecated Use stashes instead. Legacy remote stash sources.
   * Typed as StashConfigEntry[] because the migration reads them as stash entries.
   * Will be removed after one release cycle.
   */
  remoteStashSources?: StashConfigEntry[];
  /** Additional stash sources (filesystem paths and remote providers) */
  stashes?: StashConfigEntry[];
  /** Output defaults for CLI rendering */
  output?: OutputConfig;
}

export interface OutputConfig {
  format?: "json" | "yaml" | "text";
  detail?: "brief" | "normal" | "full";
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AgentikitConfig = {
  semanticSearch: true,
  searchPaths: [],
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

let cachedConfig: { config: AgentikitConfig; path: string; mtime: number } | undefined;

export function loadConfig(opts?: { readOnly?: boolean }): AgentikitConfig {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
    if (cachedConfig && cachedConfig.path === configPath && cachedConfig.mtime === stat.mtimeMs) {
      return cachedConfig.config;
    }
  } catch {
    // File doesn't exist — return defaults below
    cachedConfig = undefined;
    return { ...DEFAULT_CONFIG };
  }

  const raw = readConfigObject(configPath);
  const expanded = raw ? expandEnvVars(raw) : undefined;
  const config = expanded ? pickKnownKeys(expanded) : { ...DEFAULT_CONFIG };

  // Legacy: inject API keys from well-known env vars when not set via ${} substitution
  if (config.embedding && !config.embedding.apiKey) {
    const envKey = process.env.AKM_EMBED_API_KEY?.trim();
    if (envKey) config.embedding.apiKey = envKey;
  }
  if (config.llm && !config.llm.apiKey) {
    const envKey = process.env.AKM_LLM_API_KEY?.trim();
    if (envKey) config.llm.apiKey = envKey;
  }

  if (!opts?.readOnly) {
    // Migrate installed[source: "local"] → stashes[type: "filesystem"]
    try {
      migrateLocalInstalledToStashes(config);
    } catch (err) {
      console.warn(
        "[agentikit] Warning: config migration (local→stashes) failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Migrate remoteStashSources → stashes[]
    try {
      migrateRemoteStashSourcesToStashes(config);
    } catch (err) {
      console.warn(
        "[agentikit] Warning: config migration (remoteStashSources→stashes) failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Cache the parsed config with its path and mtime for subsequent calls.
  // Reuse the stat already obtained above (avoids a second syscall + TOCTOU gap).
  cachedConfig = { config, path: configPath, mtime: stat.mtimeMs };

  return config;
}

/**
 * Migrate installed entries with source "local" to stashes[] as filesystem entries.
 * Local directories are search paths, not registry kits — they don't need version
 * tracking, cache management, or update support.
 *
 * Mutates the config in place and persists to disk if any entries are migrated.
 */
function migrateLocalInstalledToStashes(config: AgentikitConfig): void {
  const installed = config.installed;
  if (!installed) return;

  const localEntries = installed.filter((e) => e.source === "local");
  if (localEntries.length === 0) return;

  const stashes = [...(config.stashes ?? [])];
  const existingPaths = new Set(
    stashes.filter((s): s is StashConfigEntry & { path: string } => !!s.path).map((s) => path.resolve(s.path)),
  );

  let migrated = 0;
  for (const entry of localEntries) {
    const resolved = path.resolve(entry.stashRoot);
    if (existingPaths.has(resolved)) continue;
    stashes.push({
      type: "filesystem",
      path: resolved,
      name: entry.id,
    });
    existingPaths.add(resolved);
    migrated++;
  }

  if (migrated === 0) return;

  // Remove local entries from installed, add to stashes
  config.installed = installed.filter((e) => e.source !== "local");
  config.stashes = stashes;
  saveConfig(config);
}

/**
 * Migrate remoteStashSources[] to stashes[] entries.
 * Each remote source becomes a typed stash entry (e.g. type: "openviking").
 *
 * Mutates the config in place and persists to disk if any entries are migrated.
 */
function migrateRemoteStashSourcesToStashes(config: AgentikitConfig): void {
  const remoteSources = config.remoteStashSources;
  if (!remoteSources || remoteSources.length === 0) return;

  const stashes = [...(config.stashes ?? [])];
  const existingUrls = new Set(
    stashes.filter((s): s is StashConfigEntry & { url: string } => !!s.url).map((s) => s.url),
  );

  let migrated = 0;
  for (const entry of remoteSources) {
    if (!entry.url || existingUrls.has(entry.url)) continue;
    stashes.push({
      type: entry.type ?? "openviking",
      url: entry.url,
      name: entry.name,
      options: entry.options,
    });
    existingUrls.add(entry.url);
    migrated++;
  }

  if (migrated === 0) return;

  config.stashes = stashes;
  config.remoteStashSources = undefined;
  saveConfig(config);
}

export function saveConfig(config: AgentikitConfig): void {
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
function sanitizeConfigForWrite(config: AgentikitConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  if (config.embedding) {
    const { apiKey, ...rest } = config.embedding;
    sanitized.embedding = rest;
  }
  if (config.llm) {
    const { apiKey, ...rest } = config.llm;
    sanitized.llm = rest;
  }
  // Drop empty/migrated keys to keep config clean
  if (!config.searchPaths?.length) delete sanitized.searchPaths;
  if (!config.remoteStashSources?.length) delete sanitized.remoteStashSources;
  return sanitized;
}

export function updateConfig(partial: Partial<AgentikitConfig>): AgentikitConfig {
  const current = loadConfig();
  // Shallow-merge for top-level scalar fields; deep-merge known object-type config keys.
  const merged: AgentikitConfig = { ...current, ...partial };
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
  saveConfig(merged);
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickKnownKeys(raw: Record<string, unknown>): AgentikitConfig {
  const config: AgentikitConfig = { ...DEFAULT_CONFIG };

  if (typeof raw.stashDir === "string" && raw.stashDir.trim()) {
    config.stashDir = raw.stashDir.trim();
  }

  if (typeof raw.semanticSearch === "boolean") {
    config.semanticSearch = raw.semanticSearch;
  }

  if (Array.isArray(raw.searchPaths)) {
    config.searchPaths = raw.searchPaths.filter((d): d is string => typeof d === "string");
  }

  const embedding = parseEmbeddingConfig(raw.embedding);
  if (embedding) config.embedding = embedding;

  const llm = parseLlmConfig(raw.llm);
  if (llm) config.llm = llm;

  const installed = parseInstalledEntries(raw.installed);
  if (installed) config.installed = installed;

  const registries = parseRegistriesConfig(raw.registries);
  if (registries) config.registries = registries;

  const remoteStash = parseStashesConfig(raw.remoteStashSources);
  if (remoteStash) config.remoteStashSources = remoteStash;

  const stashes = parseStashesConfig(raw.stashes);
  if (stashes) config.stashes = stashes;

  const output = parseOutputConfig(raw.output);
  if (output) config.output = output;

  return config;
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
    // Skip URL-type fields by name or by value prefix
    if (
      (fieldName !== undefined && URL_FIELD_NAMES.has(fieldName)) ||
      value.startsWith("http://") ||
      value.startsWith("https://")
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
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined;
  if (!obj.endpoint.startsWith("http://") && !obj.endpoint.startsWith("https://")) {
    console.warn(
      `[agentikit] Ignoring embedding config: endpoint must start with http:// or https://, got "${obj.endpoint}"`,
    );
    return undefined;
  }
  if (typeof obj.model !== "string" || !obj.model) return undefined;
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
  return result;
}

function parseLlmConfig(value: unknown): LlmConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined;
  if (!obj.endpoint.startsWith("http://") && !obj.endpoint.startsWith("https://")) {
    console.warn(
      `[agentikit] Ignoring llm config: endpoint must start with http:// or https://, got "${obj.endpoint}"`,
    );
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
  if (!url || !url.startsWith("http")) return undefined;

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
