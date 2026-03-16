import {
  type AgentikitConfig,
  DEFAULT_CONFIG,
  type EmbeddingConnectionConfig,
  type LlmConnectionConfig,
  type OutputConfig,
  type RegistryConfigEntry,
  type StashConfigEntry,
} from "./config";
import { UsageError } from "./errors";

export function parseConfigValue(key: string, value: string): Partial<AgentikitConfig> {
  switch (key) {
    case "stashDir":
      return { stashDir: requireNonEmptyString(value, key) };
    case "semanticSearch":
      if (value !== "true" && value !== "false") {
        throw new UsageError(`Invalid value for semanticSearch: expected "true" or "false"`);
      }
      return { semanticSearch: value === "true" };
    case "searchPaths":
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) throw new UsageError("expected JSON array");
        return { searchPaths: parsed.filter((d: unknown): d is string => typeof d === "string") };
      } catch {
        throw new UsageError(`Invalid value for searchPaths: expected JSON array (e.g. '["/path/a","/path/b"]')`);
      }
    case "embedding":
      return { embedding: parseEmbeddingConnectionValue(value) };
    case "llm":
      return { llm: parseLlmConnectionValue(value) };
    case "registries":
      return { registries: parseRegistriesValue(value) };
    case "remoteStashSources":
      return { remoteStashSources: parseStashesValue(value) };
    case "stashes":
      return { stashes: parseStashesValue(value) };
    case "output.format":
      return { output: { format: parseOutputFormat(value) } };
    case "output.detail":
      return { output: { detail: parseOutputDetail(value) } };
    default:
      throw new UsageError(`Unknown config key: ${key}`);
  }
}

export function getConfigValue(config: AgentikitConfig, key: string): unknown {
  switch (key) {
    case "stashDir":
      return config.stashDir ?? null;
    case "semanticSearch":
      return config.semanticSearch;
    case "searchPaths":
      return [...config.searchPaths];
    case "embedding":
      return config.embedding ?? null;
    case "llm":
      return config.llm ?? null;
    case "registries":
      return config.registries ?? DEFAULT_CONFIG.registries ?? [];
    case "remoteStashSources":
      return config.remoteStashSources ?? [];
    case "stashes":
      return config.stashes ?? [];
    case "output.format":
      return config.output?.format ?? null;
    case "output.detail":
      return config.output?.detail ?? null;
    default:
      throw new UsageError(`Unknown config key: ${key}`);
  }
}

export function setConfigValue(config: AgentikitConfig, key: string, rawValue: string): AgentikitConfig {
  switch (key) {
    case "stashDir":
    case "semanticSearch":
    case "searchPaths":
    case "embedding":
    case "llm":
    case "registries":
    case "remoteStashSources":
    case "stashes":
    case "output.format":
    case "output.detail":
      return mergeConfigValue(config, parseConfigValue(key, rawValue));
    default:
      throw new UsageError(`Unknown config key: ${key}`);
  }
}

export function unsetConfigValue(config: AgentikitConfig, key: string): AgentikitConfig {
  switch (key) {
    case "stashDir":
      return { ...config, stashDir: undefined };
    case "embedding":
      return { ...config, embedding: undefined };
    case "llm":
      return { ...config, llm: undefined };
    case "registries":
      return { ...config, registries: undefined };
    case "remoteStashSources":
      return { ...config, remoteStashSources: undefined };
    case "stashes":
      return { ...config, stashes: undefined };
    case "output.format":
      return { ...config, output: mergeOutputConfig(config.output, { format: undefined }) };
    case "output.detail":
      return { ...config, output: mergeOutputConfig(config.output, { detail: undefined }) };
    default:
      throw new UsageError(`Unknown or unsupported unset key: ${key}`);
  }
}

export function listConfig(config: AgentikitConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {
    semanticSearch: config.semanticSearch,
    registries: config.registries ?? DEFAULT_CONFIG.registries ?? [],
    output: mergeOutputConfig(DEFAULT_CONFIG.output, config.output) ?? null,
    stashDir: config.stashDir ?? null,
    installed: config.installed ?? [],
    stashes: config.stashes ?? [],
  };
  if (config.embedding) result.embedding = config.embedding;
  if (config.llm) result.llm = config.llm;
  // Show legacy keys only if they still have content
  if (config.searchPaths?.length) result.searchPaths = config.searchPaths;
  if (config.remoteStashSources?.length) result.remoteStashSources = config.remoteStashSources;
  return result;
}

function mergeConfigValue(config: AgentikitConfig, partial: Partial<AgentikitConfig>): AgentikitConfig {
  return {
    ...config,
    ...partial,
    output: mergeOutputConfig(config.output, partial.output),
  };
}

function mergeOutputConfig(base?: OutputConfig, override?: OutputConfig): OutputConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return merged.format || merged.detail ? merged : undefined;
}

function parseOutputFormat(value: string): OutputConfig["format"] {
  if (value === "json" || value === "yaml" || value === "text") return value;
  throw new UsageError(`Invalid value for output.format: expected one of json|yaml|text`);
}

function parseOutputDetail(value: string): OutputConfig["detail"] {
  if (value === "brief" || value === "normal" || value === "full") return value;
  throw new UsageError(`Invalid value for output.detail: expected one of brief|normal|full`);
}

function parseRegistriesValue(value: string): RegistryConfigEntry[] | undefined {
  if (value === "null" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(
      `Invalid value for registries: expected JSON array of {url, name?, enabled?, provider?, options?} objects` +
        ` (e.g. '[{"url":"https://example.com/index.json","name":"my-registry"}]')`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(`Invalid value for registries: expected a JSON array`);
  }
  return parsed.map((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UsageError(`Invalid value for registries[${i}]: expected an object with a "url" field`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.url !== "string" || !obj.url) {
      throw new UsageError(`Invalid value for registries[${i}]: "url" is required`);
    }
    const result: RegistryConfigEntry = { url: obj.url };
    if (typeof obj.name === "string" && obj.name) result.name = obj.name;
    if (typeof obj.enabled === "boolean") result.enabled = obj.enabled;
    if (typeof obj.provider === "string" && obj.provider) result.provider = obj.provider;
    if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
      result.options = obj.options as Record<string, unknown>;
    }
    return result;
  });
}

function parseEmbeddingConnectionValue(value: string): EmbeddingConnectionConfig | undefined {
  if (value === "null" || value === "") return undefined;
  const parsed = parseJsonObject(value, "embedding", {
    endpoint: "http://localhost:11434/v1/embeddings",
    model: "nomic-embed-text",
  });
  const result: EmbeddingConnectionConfig = {
    endpoint: asRequiredString(parsed.endpoint, "embedding", "endpoint"),
    model: asRequiredString(parsed.model, "embedding", "model"),
  };
  if (typeof parsed.provider === "string" && parsed.provider) result.provider = parsed.provider;
  if (parsed.dimension !== undefined)
    result.dimension = parseUnknownPositiveInteger(parsed.dimension, "embedding.dimension");
  if (typeof parsed.apiKey === "string" && parsed.apiKey) result.apiKey = parsed.apiKey;
  return result;
}

function parseLlmConnectionValue(value: string): LlmConnectionConfig | undefined {
  if (value === "null" || value === "") return undefined;
  const parsed = parseJsonObject(value, "llm", {
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.2",
  });
  const result: LlmConnectionConfig = {
    endpoint: asRequiredString(parsed.endpoint, "llm", "endpoint"),
    model: asRequiredString(parsed.model, "llm", "model"),
  };
  if (typeof parsed.provider === "string" && parsed.provider) result.provider = parsed.provider;
  if (parsed.temperature !== undefined) result.temperature = parseUnknownNumber(parsed.temperature, "llm.temperature");
  if (parsed.maxTokens !== undefined) result.maxTokens = parseUnknownPositiveInteger(parsed.maxTokens, "llm.maxTokens");
  if (typeof parsed.apiKey === "string" && parsed.apiKey) result.apiKey = parsed.apiKey;
  return result;
}

function parseJsonObject(
  value: string,
  key: string,
  example: { endpoint: string; model: string },
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(
      `Invalid value for ${key}: expected JSON object with endpoint and model` +
        ` (e.g. '{"endpoint":"${example.endpoint}","model":"${example.model}"}')`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`Invalid value for ${key}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function asRequiredString(value: unknown, key: string, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new UsageError(`Invalid value for ${key}: "${field}" is a required string field`);
  }
  return value;
}

function requireNonEmptyString(value: string, key: string): string {
  if (!value) {
    throw new UsageError(`Invalid value for ${key}: expected a non-empty string`);
  }
  return value;
}

function parseUnknownNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UsageError(`Invalid value for ${key}: expected a number`);
  }
  return value;
}

function parseUnknownPositiveInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new UsageError(`Invalid value for ${key}: expected a positive integer`);
  }
  return value;
}

function parseStashesValue(value: string): StashConfigEntry[] | undefined {
  if (value === "null" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(
      `Invalid value for stashes: expected JSON array of {type, path?, url?, name?, enabled?, options?} objects`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(`Invalid value for stashes: expected a JSON array`);
  }
  return parsed.map((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UsageError(`Invalid value for stashes[${i}]: expected an object with a "type" field`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.type !== "string" || !obj.type) {
      throw new UsageError(`Invalid value for stashes[${i}]: "type" is required`);
    }
    const result: StashConfigEntry = { type: obj.type };
    if (typeof obj.path === "string" && obj.path) result.path = obj.path;
    if (typeof obj.url === "string" && obj.url) result.url = obj.url;
    if (typeof obj.name === "string" && obj.name) result.name = obj.name;
    if (typeof obj.enabled === "boolean") result.enabled = obj.enabled;
    if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
      result.options = obj.options as Record<string, unknown>;
    }
    return result;
  });
}
