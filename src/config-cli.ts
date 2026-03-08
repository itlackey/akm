import {
  DEFAULT_CONFIG,
  type AgentikitConfig,
  type EmbeddingConnectionConfig,
  type LlmConnectionConfig,
} from "./config"
import { EMBEDDING_DIM } from "./db"

export type ConfigProviderScope = "embedding" | "llm"

interface ProviderPreset<TConfig> {
  name: string
  description: string
  config?: TConfig
}

const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2"
const DEFAULT_LLM_TEMPERATURE = 0.3
const DEFAULT_LLM_MAX_TOKENS = 512

const EMBEDDING_PROVIDER_PRESETS: Record<string, ProviderPreset<EmbeddingConnectionConfig>> = {
  local: {
    name: "local",
    description: "Built-in local embeddings via @xenova/transformers.",
  },
  ollama: {
    name: "ollama",
    description: "Local Ollama embedding endpoint.",
    config: {
      provider: "ollama",
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
      dimension: EMBEDDING_DIM,
    },
  },
  openai: {
    name: "openai",
    description: "OpenAI-compatible embeddings API.",
    config: {
      provider: "openai",
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimension: EMBEDDING_DIM,
    },
  },
}

const LLM_PROVIDER_PRESETS: Record<string, ProviderPreset<LlmConnectionConfig>> = {
  disabled: {
    name: "disabled",
    description: "Disable LLM metadata enhancement.",
  },
  ollama: {
    name: "ollama",
    description: "Local Ollama chat completions endpoint.",
    config: {
      provider: "ollama",
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
    },
  },
  openai: {
    name: "openai",
    description: "OpenAI-compatible chat completions API.",
    config: {
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
    },
  },
}

export function parseConfigValue(key: string, value: string): Partial<AgentikitConfig> {
  switch (key) {
    case "semanticSearch":
      if (value !== "true" && value !== "false") {
        throw new Error(`Invalid value for semanticSearch: expected "true" or "false"`)
      }
      return { semanticSearch: value === "true" }
    case "additionalStashDirs":
      try {
        const parsed = JSON.parse(value)
        if (!Array.isArray(parsed)) throw new Error("expected JSON array")
        return { additionalStashDirs: parsed.filter((d: unknown): d is string => typeof d === "string") }
      } catch {
        throw new Error(`Invalid value for additionalStashDirs: expected JSON array (e.g. '["/path/a","/path/b"]')`)
      }
    case "embedding":
      return { embedding: parseEmbeddingConnectionValue(value) }
    case "llm":
      return { llm: parseLlmConnectionValue(value) }
    default:
      throw new Error(`Unknown config key: ${key}`)
  }
}

export function getConfigValue(config: AgentikitConfig, key: string): unknown {
  switch (key) {
    case "semanticSearch":
      return config.semanticSearch
    case "additionalStashDirs":
      return [...config.additionalStashDirs]
    case "embedding":
      return maskSecrets(getEmbeddingDisplayConfig(config))
    case "embedding.provider":
      return getEmbeddingProvider(config)
    case "embedding.endpoint":
      return getEmbeddingDisplayConfig(config).endpoint ?? null
    case "embedding.model":
      return getEmbeddingDisplayConfig(config).model ?? null
    case "embedding.dimension":
      return getEmbeddingDisplayConfig(config).dimension ?? null
    case "embedding.apiKey":
      return maskSecret(getEmbeddingDisplayConfig(config).apiKey)
    case "llm":
      return maskSecrets(getLlmDisplayConfig(config))
    case "llm.provider":
      return getLlmProvider(config)
    case "llm.endpoint":
      return getLlmDisplayConfig(config).endpoint ?? null
    case "llm.model":
      return getLlmDisplayConfig(config).model ?? null
    case "llm.temperature":
      return getLlmDisplayConfig(config).temperature ?? null
    case "llm.maxTokens":
      return getLlmDisplayConfig(config).maxTokens ?? null
    case "llm.apiKey":
      return maskSecret(getLlmDisplayConfig(config).apiKey)
    default:
      throw new Error(`Unknown config key: ${key}`)
  }
}

export function setConfigValue(config: AgentikitConfig, key: string, rawValue: string): AgentikitConfig {
  switch (key) {
    case "semanticSearch":
    case "additionalStashDirs":
    case "embedding":
    case "llm":
      return { ...config, ...parseConfigValue(key, rawValue) }
    case "embedding.provider":
      return useProvider(config, "embedding", rawValue)
    case "embedding.endpoint":
      return {
        ...config,
        embedding: {
          ...requireEmbeddingConfig(config),
          endpoint: requireNonEmptyString(rawValue, key),
        },
      }
    case "embedding.model":
      return {
        ...config,
        embedding: {
          ...requireEmbeddingConfig(config),
          model: requireNonEmptyString(rawValue, key),
        },
      }
    case "embedding.dimension":
      return {
        ...config,
        embedding: {
          ...requireEmbeddingConfig(config),
          dimension: parsePositiveInteger(rawValue, key),
        },
      }
    case "embedding.apiKey":
      return {
        ...config,
        embedding: {
          ...requireEmbeddingConfig(config),
          apiKey: requireNonEmptyString(rawValue, key),
        },
      }
    case "llm.provider":
      return useProvider(config, "llm", rawValue)
    case "llm.endpoint":
      return {
        ...config,
        llm: {
          ...requireLlmConfig(config),
          endpoint: requireNonEmptyString(rawValue, key),
        },
      }
    case "llm.model":
      return {
        ...config,
        llm: {
          ...requireLlmConfig(config),
          model: requireNonEmptyString(rawValue, key),
        },
      }
    case "llm.temperature":
      return {
        ...config,
        llm: {
          ...requireLlmConfig(config),
          temperature: parseNumber(rawValue, key),
        },
      }
    case "llm.maxTokens":
      return {
        ...config,
        llm: {
          ...requireLlmConfig(config),
          maxTokens: parsePositiveInteger(rawValue, key),
        },
      }
    case "llm.apiKey":
      return {
        ...config,
        llm: {
          ...requireLlmConfig(config),
          apiKey: requireNonEmptyString(rawValue, key),
        },
      }
    default:
      throw new Error(`Unknown config key: ${key}`)
  }
}

export function unsetConfigValue(config: AgentikitConfig, key: string): AgentikitConfig {
  switch (key) {
    case "embedding":
      return { ...config, embedding: undefined }
    case "embedding.apiKey":
      if (!config.embedding) return config
      return { ...config, embedding: omitKey(config.embedding, "apiKey") }
    case "embedding.dimension":
      if (!config.embedding) return config
      return { ...config, embedding: omitKey(config.embedding, "dimension") }
    case "embedding.provider":
      if (!config.embedding) return config
      return { ...config, embedding: omitKey(config.embedding, "provider") }
    case "llm":
      return { ...config, llm: undefined }
    case "llm.apiKey":
      if (!config.llm) return config
      return { ...config, llm: omitKey(config.llm, "apiKey") }
    case "llm.temperature":
      if (!config.llm) return config
      return { ...config, llm: omitKey(config.llm, "temperature") }
    case "llm.maxTokens":
      if (!config.llm) return config
      return { ...config, llm: omitKey(config.llm, "maxTokens") }
    case "llm.provider":
      if (!config.llm) return config
      return { ...config, llm: omitKey(config.llm, "provider") }
    default:
      throw new Error(`Unknown or unsupported unset key: ${key}`)
  }
}

export function listConfig(config: AgentikitConfig): Record<string, unknown> {
  return {
    ...DEFAULT_CONFIG,
    ...maskSecrets(config),
    embedding: maskSecrets(getEmbeddingDisplayConfig(config)),
    llm: maskSecrets(getLlmDisplayConfig(config)),
  }
}

export function listProviders(scope: ConfigProviderScope, config: AgentikitConfig): Array<Record<string, unknown>> {
  const currentProvider = scope === "embedding" ? getEmbeddingProvider(config) : getLlmProvider(config)
  const presets = scope === "embedding" ? EMBEDDING_PROVIDER_PRESETS : LLM_PROVIDER_PRESETS
  return Object.values(presets).map((preset) => ({
    name: preset.name,
    description: preset.description,
    current: preset.name === currentProvider,
    ...(preset.config ? maskSecrets(preset.config) : {}),
  }))
}

export function useProvider(config: AgentikitConfig, scope: ConfigProviderScope, providerName: string): AgentikitConfig {
  if (scope === "embedding") {
    const preset = EMBEDDING_PROVIDER_PRESETS[providerName]
    if (!preset) {
      throw new Error(`Unknown embedding provider: ${providerName}`)
    }
    if (!preset.config) {
      return { ...config, embedding: undefined }
    }
    return { ...config, embedding: { ...preset.config } }
  }

  const preset = LLM_PROVIDER_PRESETS[providerName]
  if (!preset) {
    throw new Error(`Unknown llm provider: ${providerName}`)
  }
  if (!preset.config) {
    return { ...config, llm: undefined }
  }
  return { ...config, llm: { ...preset.config } }
}

function getEmbeddingProvider(config: AgentikitConfig): string {
  if (!config.embedding) return "local"
  if (config.embedding.provider) return config.embedding.provider
  if (matchesPreset(config.embedding, EMBEDDING_PROVIDER_PRESETS.ollama.config)) return "ollama"
  if (matchesPreset(config.embedding, EMBEDDING_PROVIDER_PRESETS.openai.config)) return "openai"
  return "custom"
}

function getLlmProvider(config: AgentikitConfig): string {
  if (!config.llm) return "disabled"
  if (config.llm.provider) return config.llm.provider
  if (matchesPreset(config.llm, LLM_PROVIDER_PRESETS.ollama.config)) return "ollama"
  if (matchesPreset(config.llm, LLM_PROVIDER_PRESETS.openai.config)) return "openai"
  return "custom"
}

function getEmbeddingDisplayConfig(config: AgentikitConfig): Record<string, unknown> {
  if (!config.embedding) {
    return {
      provider: "local",
      model: LOCAL_EMBEDDING_MODEL,
      dimension: EMBEDDING_DIM,
    }
  }
  return {
    provider: getEmbeddingProvider(config),
    endpoint: config.embedding.endpoint,
    model: config.embedding.model,
    dimension: config.embedding.dimension,
    apiKey: config.embedding.apiKey,
  }
}

function getLlmDisplayConfig(config: AgentikitConfig): Record<string, unknown> {
  if (!config.llm) {
    return {
      provider: "disabled",
    }
  }
  return {
    provider: getLlmProvider(config),
    endpoint: config.llm.endpoint,
    model: config.llm.model,
    temperature: config.llm.temperature ?? DEFAULT_LLM_TEMPERATURE,
    maxTokens: config.llm.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    apiKey: config.llm.apiKey,
  }
}

function parseEmbeddingConnectionValue(value: string): EmbeddingConnectionConfig | undefined {
  if (value === "null" || value === "") return undefined
  const parsed = parseJsonObject(value, "embedding", {
    endpoint: "http://localhost:11434/v1/embeddings",
    model: "nomic-embed-text",
  })
  const result: EmbeddingConnectionConfig = {
    endpoint: asRequiredString(parsed.endpoint, "embedding", "endpoint"),
    model: asRequiredString(parsed.model, "embedding", "model"),
  }
  if (typeof parsed.provider === "string" && parsed.provider) result.provider = parsed.provider
  if (parsed.dimension !== undefined) result.dimension = parseUnknownPositiveInteger(parsed.dimension, "embedding.dimension")
  if (typeof parsed.apiKey === "string" && parsed.apiKey) result.apiKey = parsed.apiKey
  return result
}

function parseLlmConnectionValue(value: string): LlmConnectionConfig | undefined {
  if (value === "null" || value === "") return undefined
  const parsed = parseJsonObject(value, "llm", {
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.2",
  })
  const result: LlmConnectionConfig = {
    endpoint: asRequiredString(parsed.endpoint, "llm", "endpoint"),
    model: asRequiredString(parsed.model, "llm", "model"),
  }
  if (typeof parsed.provider === "string" && parsed.provider) result.provider = parsed.provider
  if (parsed.temperature !== undefined) result.temperature = parseUnknownNumber(parsed.temperature, "llm.temperature")
  if (parsed.maxTokens !== undefined) result.maxTokens = parseUnknownPositiveInteger(parsed.maxTokens, "llm.maxTokens")
  if (typeof parsed.apiKey === "string" && parsed.apiKey) result.apiKey = parsed.apiKey
  return result
}

function parseJsonObject(
  value: string,
  key: string,
  example: { endpoint: string; model: string },
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(
      `Invalid value for ${key}: expected JSON object with endpoint and model`
      + ` (e.g. '{"endpoint":"${example.endpoint}","model":"${example.model}"}')`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid value for ${key}: expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function asRequiredString(value: unknown, key: string, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid value for ${key}: "${field}" is a required string field`)
  }
  return value
}

function requireEmbeddingConfig(config: AgentikitConfig): EmbeddingConnectionConfig {
  if (!config.embedding) {
    throw new Error("Embedding provider is using the built-in local default. Run `akm config use embedding <provider>` first.")
  }
  return config.embedding
}

function requireLlmConfig(config: AgentikitConfig): LlmConnectionConfig {
  if (!config.llm) {
    throw new Error("LLM provider is disabled. Run `akm config use llm <provider>` first.")
  }
  return config.llm
}

function requireNonEmptyString(value: string, key: string): string {
  if (!value) {
    throw new Error(`Invalid value for ${key}: expected a non-empty string`)
  }
  return value
}

function parseNumber(value: string, key: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${key}: expected a number`)
  }
  return parsed
}

function parsePositiveInteger(value: string, key: string): number {
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid value for ${key}: expected a positive integer`)
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${key}: expected a positive integer`)
  }
  return parsed
}

function parseUnknownNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid value for ${key}: expected a number`)
  }
  return value
}

function parseUnknownPositiveInteger(value: unknown, key: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(`Invalid value for ${key}: expected a positive integer`)
  }
  return value
}

function matchesPreset<TConfig extends { endpoint: string; model: string }>(
  current: TConfig,
  preset?: TConfig,
): boolean {
  if (!preset) return false
  return current.endpoint === preset.endpoint && current.model === preset.model
}

function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

function maskSecret(value: unknown): unknown {
  return typeof value === "string" && value ? "***" : value
}

function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item)) as T
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = key === "apiKey" ? maskSecret(entry) : maskSecrets(entry)
    }
    return result as T
  }
  return value
}
