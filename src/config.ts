import fs from "node:fs"
import path from "node:path"
import type { RegistryInstalledEntry, RegistrySource } from "./registry-types"
import { getConfigDir as _getConfigDir, getConfigPath as _getConfigPath } from "./paths"

// ── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingConnectionConfig {
  /** Provider name for display/CLI switching (e.g. "openai", "ollama") */
  provider?: string
  /** OpenAI-compatible embeddings endpoint (e.g. "http://localhost:11434/v1/embeddings") */
  endpoint: string
  /** Model name to use for embeddings (e.g. "nomic-embed-text") */
  model: string
  /** Optional output dimension for providers that support it */
  dimension?: number
  /** Optional API key for authenticated endpoints */
  apiKey?: string
}

export interface LlmConnectionConfig {
  /** Provider name for display/CLI switching (e.g. "openai", "ollama") */
  provider?: string
  /** OpenAI-compatible chat completions endpoint (e.g. "http://localhost:11434/v1/chat/completions") */
  endpoint: string
  /** Model name to use (e.g. "llama3.2") */
  model: string
  /** Optional sampling temperature */
  temperature?: number
  /** Optional response token limit */
  maxTokens?: number
  /** Optional API key for authenticated endpoints */
  apiKey?: string
}

export interface AgentikitConfig {
  /** Path to the working stash directory. Resolved from env → config → default. */
  stashDir?: string
  /** Whether semantic search is enabled. Default: true */
  semanticSearch: boolean
  /** User-configured additional stash directories to search */
  searchPaths: string[]
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @xenova/transformers */
  embedding?: EmbeddingConnectionConfig
  /** OpenAI-compatible LLM endpoint config for metadata generation. If not set, uses heuristic generation */
  llm?: LlmConnectionConfig
  /** Installed registry sources and local cache metadata */
  registry?: RegistryConfig
  /** Registry index URLs for kit discovery. Default: official agentikit-registry on GitHub */
  registryUrls?: string[]
}

export interface RegistryConfig {
  installed: RegistryInstalledEntry[]
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AgentikitConfig = {
  semanticSearch: true,
  searchPaths: [],
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getConfigDir(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string {
  return _getConfigDir(env, platform)
}

export function getConfigPath(): string {
  return _getConfigPath()
}

// ── Load / Save / Update ────────────────────────────────────────────────────

let cachedConfig: { config: AgentikitConfig; path: string; mtime: number } | undefined

export function loadConfig(): AgentikitConfig {
  const configPath = getConfigPath()

  try {
    const stat = fs.statSync(configPath)
    if (cachedConfig && cachedConfig.path === configPath && cachedConfig.mtime === stat.mtimeMs) {
      return cachedConfig.config
    }
  } catch {
    // File doesn't exist — return defaults below
    cachedConfig = undefined
    return { ...DEFAULT_CONFIG }
  }

  const raw = readConfigObject(configPath)
  const config = raw ? pickKnownKeys(raw) : { ...DEFAULT_CONFIG }

  // Inject API keys from environment variables.
  // API keys should be provided via AKM_EMBED_API_KEY and AKM_LLM_API_KEY
  // rather than stored in the config file.
  if (config.embedding && !config.embedding.apiKey) {
    const envKey = process.env.AKM_EMBED_API_KEY?.trim()
    if (envKey) config.embedding.apiKey = envKey
  }
  if (config.llm && !config.llm.apiKey) {
    const envKey = process.env.AKM_LLM_API_KEY?.trim()
    if (envKey) config.llm.apiKey = envKey
  }

  // Cache the parsed config with its path and mtime for subsequent calls
  try {
    const stat = fs.statSync(configPath)
    cachedConfig = { config, path: configPath, mtime: stat.mtimeMs }
  } catch {
    // If we can't stat (unlikely since we just read it), skip caching
  }

  return config
}

export function saveConfig(config: AgentikitConfig): void {
  cachedConfig = undefined
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  const sanitized = sanitizeConfigForWrite(config)
  const tmpPath = configPath + `.tmp.${process.pid}`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(sanitized, null, 2) + "\n", "utf8")
    fs.renameSync(tmpPath, configPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}

/**
 * Strip apiKey fields before writing config to disk.
 * API keys should be provided via environment variables
 * AKM_EMBED_API_KEY and AKM_LLM_API_KEY.
 */
function sanitizeConfigForWrite(config: AgentikitConfig): AgentikitConfig {
  const sanitized = { ...config }
  if (sanitized.embedding) {
    const { apiKey, ...rest } = sanitized.embedding
    sanitized.embedding = rest as EmbeddingConnectionConfig
  }
  if (sanitized.llm) {
    const { apiKey, ...rest } = sanitized.llm
    sanitized.llm = rest as LlmConnectionConfig
  }
  return sanitized
}

export function updateConfig(partial: Partial<AgentikitConfig>): AgentikitConfig {
  const current = loadConfig()
  const merged: AgentikitConfig = { ...current, ...partial }
  saveConfig(merged)
  return merged
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickKnownKeys(raw: Record<string, unknown>): AgentikitConfig {
  const config: AgentikitConfig = { ...DEFAULT_CONFIG }

  if (typeof raw.stashDir === "string" && raw.stashDir.trim()) {
    config.stashDir = raw.stashDir.trim()
  }

  if (typeof raw.semanticSearch === "boolean") {
    config.semanticSearch = raw.semanticSearch
  }

  if (Array.isArray(raw.searchPaths)) {
    config.searchPaths = raw.searchPaths.filter(
      (d): d is string => typeof d === "string",
    )
  }

  // Backward compat: merge legacy mountedStashDirs into searchPaths
  if (Array.isArray(raw.mountedStashDirs)) {
    const legacy = raw.mountedStashDirs.filter(
      (d): d is string => typeof d === "string",
    )
    const existing = new Set(config.searchPaths)
    for (const d of legacy) {
      if (!existing.has(d)) config.searchPaths.push(d)
    }
  }

  const embedding = parseEmbeddingConfig(raw.embedding)
  if (embedding) config.embedding = embedding

  const llm = parseLlmConfig(raw.llm)
  if (llm) config.llm = llm

  const registry = parseRegistryConfig(raw.registry)
  if (registry) config.registry = registry

  if (Array.isArray(raw.registryUrls)) {
    config.registryUrls = raw.registryUrls.filter(
      (u): u is string => typeof u === "string" && u.startsWith("http"),
    )
  }

  return config
}

function readConfigObject(configPath: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(configPath, "utf8")
    const raw = JSON.parse(stripJsonComments(text))
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
    return raw
  } catch {
    return undefined
  }
}

/**
 * Strip JavaScript-style comments from a JSON string (JSONC support).
 * Handles // line comments and /* block comments while preserving
 * comment-like sequences inside quoted strings.
 */
export function stripJsonComments(text: string): string {
  let result = ""
  let i = 0
  let inString = false
  let stringChar = ""
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i] + (text[i + 1] ?? "")
        i += 2
        continue
      }
      if (text[i] === stringChar) {
        inString = false
      }
      result += text[i]
      i++
      continue
    }
    if (text[i] === '"' || text[i] === "'") {
      inString = true
      stringChar = text[i]
      result += text[i]
      i++
      continue
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    result += text[i]
    i++
  }
  return result
}

function parseEmbeddingConfig(value: unknown): EmbeddingConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined
  if (typeof obj.model !== "string" || !obj.model) return undefined
  const result: EmbeddingConnectionConfig = {
    endpoint: obj.endpoint,
    model: obj.model,
  }
  if (typeof obj.provider === "string" && obj.provider) {
    result.provider = obj.provider
  }
  if ("dimension" in obj) {
    if (
      typeof obj.dimension !== "number" ||
      !Number.isFinite(obj.dimension) ||
      !Number.isInteger(obj.dimension) ||
      obj.dimension <= 0
    ) {
      return undefined
    }
    result.dimension = obj.dimension
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey
  }
  return result
}

function parseLlmConfig(value: unknown): LlmConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined
  if (typeof obj.model !== "string" || !obj.model) return undefined
  const result: LlmConnectionConfig = {
    endpoint: obj.endpoint,
    model: obj.model,
  }
  if (typeof obj.provider === "string" && obj.provider) {
    result.provider = obj.provider
  }
  if (typeof obj.temperature === "number" && Number.isFinite(obj.temperature)) {
    result.temperature = obj.temperature
  }
  if ("maxTokens" in obj) {
    if (
      typeof obj.maxTokens !== "number" ||
      !Number.isFinite(obj.maxTokens) ||
      !Number.isInteger(obj.maxTokens) ||
      obj.maxTokens <= 0
    ) {
      return undefined
    }
    result.maxTokens = obj.maxTokens
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey
  }
  return result
}

function parseRegistryConfig(value: unknown): RegistryConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (!Array.isArray(obj.installed)) return undefined

  const installed = obj.installed
    .map((entry) => parseRegistryInstalledEntry(entry))
    .filter((entry): entry is RegistryInstalledEntry => entry !== undefined)

  return { installed }
}

function parseRegistryInstalledEntry(value: unknown): RegistryInstalledEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>

  const id = asNonEmptyString(obj.id)
  const source = asRegistrySource(obj.source)
  const ref = asNonEmptyString(obj.ref)
  const artifactUrl = asNonEmptyString(obj.artifactUrl)
  const stashRoot = asNonEmptyString(obj.stashRoot)
  const cacheDir = asNonEmptyString(obj.cacheDir)
  const installedAt = asNonEmptyString(obj.installedAt)
  if (!id || !source || !ref || !artifactUrl || !stashRoot || !cacheDir || !installedAt) return undefined

  const entry: RegistryInstalledEntry = {
    id,
    source,
    ref,
    artifactUrl,
    stashRoot,
    cacheDir,
    installedAt,
  }
  const resolvedVersion = asNonEmptyString(obj.resolvedVersion)
  if (resolvedVersion) entry.resolvedVersion = resolvedVersion
  const resolvedRevision = asNonEmptyString(obj.resolvedRevision)
  if (resolvedRevision) entry.resolvedRevision = resolvedRevision
  return entry
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function asRegistrySource(value: unknown): RegistrySource | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value as RegistrySource
  return undefined
}
