import fs from "node:fs"
import path from "node:path"
import type { RegistryInstalledEntry, RegistrySource } from "./registry-types"

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
  /** Whether semantic search is enabled. Default: true */
  semanticSearch: boolean
  /** Additional stash directories to search alongside the primary one */
  additionalStashDirs: string[]
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @xenova/transformers */
  embedding?: EmbeddingConnectionConfig
  /** OpenAI-compatible LLM endpoint config for metadata generation. If not set, uses heuristic generation */
  llm?: LlmConnectionConfig
  /** Installed registry sources and local cache metadata */
  registry?: RegistryConfig
}

export interface RegistryConfig {
  installed: RegistryInstalledEntry[]
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AgentikitConfig = {
  semanticSearch: true,
  additionalStashDirs: [],
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim()
    if (appData) return path.join(appData, "agentikit")

    const userProfile = env.USERPROFILE?.trim()
    if (!userProfile) {
      throw new Error("Unable to determine config directory. Set APPDATA or USERPROFILE.")
    }
    return path.join(userProfile, "AppData", "Roaming", "agentikit")
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) return path.join(xdgConfigHome, "agentikit")

  const home = env.HOME?.trim()
  if (!home) {
    throw new Error("Unable to determine config directory. Set XDG_CONFIG_HOME or HOME.")
  }
  return path.join(home, ".config", "agentikit")
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json")
}

// ── Load / Save / Update ────────────────────────────────────────────────────

export function loadConfig(): AgentikitConfig {
  const configPath = getConfigPath()
  const raw = readConfigObject(configPath)
  if (raw) return pickKnownKeys(raw)

  return { ...DEFAULT_CONFIG }
}

export function saveConfig(config: AgentikitConfig): void {
  const configPath = getConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
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

  if (typeof raw.semanticSearch === "boolean") {
    config.semanticSearch = raw.semanticSearch
  }

  if (Array.isArray(raw.additionalStashDirs)) {
    config.additionalStashDirs = raw.additionalStashDirs.filter(
      (d): d is string => typeof d === "string",
    )
  }

  const embedding = parseEmbeddingConfig(raw.embedding)
  if (embedding) config.embedding = embedding

  const llm = parseLlmConfig(raw.llm)
  if (llm) config.llm = llm

  const registry = parseRegistryConfig(raw.registry)
  if (registry) config.registry = registry

  return config
}

function readConfigObject(configPath: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
    return raw
  } catch {
    return undefined
  }
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
  return value === "npm" || value === "github" || value === "git" ? value : undefined
}
