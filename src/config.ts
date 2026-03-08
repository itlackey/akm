import fs from "node:fs"
import path from "node:path"
import { resolveStashDir } from "./common"
import type { RegistryInstalledEntry, RegistrySource } from "./registry-types"

// ── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingConnectionConfig {
  /** OpenAI-compatible embeddings endpoint (e.g. "http://localhost:11434/v1/embeddings") */
  endpoint: string
  /** Model name to use for embeddings (e.g. "nomic-embed-text") */
  model: string
  /** Optional API key for authenticated endpoints */
  apiKey?: string
}

export interface LlmConnectionConfig {
  /** OpenAI-compatible chat completions endpoint (e.g. "http://localhost:11434/v1/chat/completions") */
  endpoint: string
  /** Model name to use (e.g. "llama3.2") */
  model: string
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

export function getConfigPath(stashDir: string): string {
  return path.join(stashDir, "config.json")
}

// ── Load / Save / Update ────────────────────────────────────────────────────

export function loadConfig(stashDir?: string): AgentikitConfig {
  const dir = stashDir ?? resolveStashDir()
  const configPath = getConfigPath(dir)

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ...DEFAULT_CONFIG }
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }

  return pickKnownKeys(raw)
}

export function saveConfig(config: AgentikitConfig, stashDir?: string): void {
  const dir = stashDir ?? resolveStashDir()
  const configPath = getConfigPath(dir)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
}

export function updateConfig(
  partial: Partial<AgentikitConfig>,
  stashDir?: string,
): AgentikitConfig {
  const dir = stashDir ?? resolveStashDir()
  const current = loadConfig(dir)
  const merged: AgentikitConfig = { ...current, ...partial }
  saveConfig(merged, dir)
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

  const embedding = parseConnectionConfig(raw.embedding)
  if (embedding) config.embedding = embedding

  const llm = parseConnectionConfig(raw.llm)
  if (llm) config.llm = llm

  const registry = parseRegistryConfig(raw.registry)
  if (registry) config.registry = registry

  return config
}

function parseConnectionConfig(
  value: unknown,
): EmbeddingConnectionConfig | LlmConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined
  if (typeof obj.model !== "string" || !obj.model) return undefined
  const result: { endpoint: string; model: string; apiKey?: string } = {
    endpoint: obj.endpoint,
    model: obj.model,
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
