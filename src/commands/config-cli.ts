import {
  type AkmConfig,
  DEFAULT_CONFIG,
  type EmbeddingConnectionConfig,
  type InstallAuditConfig,
  type LlmConnectionConfig,
  type OutputConfig,
  type RegistryConfigEntry,
  type SecurityConfig,
  type SourceConfigEntry,
} from "../core/config";
import { UsageError } from "../core/errors";

export function parseConfigValue(key: string, value: string): Partial<AkmConfig> {
  switch (key) {
    case "stashDir":
      return { stashDir: requireNonEmptyString(value, key) };
    case "semanticSearchMode":
      // Accept legacy boolean-style strings from CLI
      if (value === "true") return { semanticSearchMode: "auto" };
      if (value === "false") return { semanticSearchMode: "off" };
      if (value !== "off" && value !== "auto") {
        throw new UsageError(`Invalid value for semanticSearchMode: expected "off" or "auto"`);
      }
      return { semanticSearchMode: value };
    case "embedding":
      return { embedding: parseEmbeddingConnectionValue(value) };
    case "llm":
      return { llm: parseLlmConnectionValue(value) };
    case "registries":
      return { registries: parseRegistriesValue(value) };
    case "sources":
    case "stashes":
      // "stashes" is kept as an alias for backwards-compat; both write to `sources`.
      return { sources: parseStashesValue(value) };
    case "output.format":
      return { output: { format: parseOutputFormat(value) } };
    case "output.detail":
      return { output: { detail: parseOutputDetail(value) } };
    case "security.installAudit.enabled":
      return { security: { installAudit: { enabled: parseBooleanValue(value, key) } } };
    case "security.installAudit.blockOnCritical":
      return { security: { installAudit: { blockOnCritical: parseBooleanValue(value, key) } } };
    case "security.installAudit.blockUnlistedRegistries":
      return { security: { installAudit: { blockUnlistedRegistries: parseBooleanValue(value, key) } } };
    case "security.installAudit.registryAllowlist":
      return { security: { installAudit: { registryAllowlist: parseStringArrayValue(value, key) } } };
    case "security.installAudit.registryWhitelist":
      return { security: { installAudit: { registryAllowlist: parseStringArrayValue(value, key) } } };
    case "security.installAudit.allowedFindings":
      return { security: { installAudit: { allowedFindings: parseAllowedFindingsValue(value, key) } } };
    default:
      throw new UsageError(`Unknown config key: ${key}`);
  }
}

export function getConfigValue(config: AkmConfig, key: string): unknown {
  switch (key) {
    case "stashDir":
      return config.stashDir ?? null;
    case "semanticSearchMode":
      return config.semanticSearchMode;
    case "embedding":
      return config.embedding ?? null;
    case "llm":
      return config.llm ?? null;
    case "registries":
      return config.registries ?? DEFAULT_CONFIG.registries ?? [];
    case "sources":
    case "stashes":
      // "stashes" is an alias for "sources" for backwards-compat.
      return config.sources ?? config.stashes ?? [];
    case "output.format":
      return config.output?.format ?? null;
    case "output.detail":
      return config.output?.detail ?? null;
    case "security":
      return config.security ?? null;
    case "security.installAudit.enabled":
      return config.security?.installAudit?.enabled ?? null;
    case "security.installAudit.blockOnCritical":
      return config.security?.installAudit?.blockOnCritical ?? null;
    case "security.installAudit.blockUnlistedRegistries":
      return config.security?.installAudit?.blockUnlistedRegistries ?? null;
    case "security.installAudit.registryAllowlist":
      return getInstallAuditAllowlist(config);
    case "security.installAudit.registryWhitelist":
      return getInstallAuditAllowlist(config);
    case "security.installAudit.allowedFindings":
      return config.security?.installAudit?.allowedFindings ?? null;
    default:
      throw new UsageError(`Unknown config key: ${key}`);
  }
}

export function setConfigValue(config: AkmConfig, key: string, rawValue: string): AkmConfig {
  switch (key) {
    case "stashDir":
    case "semanticSearchMode":
    case "embedding":
    case "llm":
    case "registries":
    case "sources":
    case "stashes":
    case "output.format":
    case "output.detail":
    case "security.installAudit.enabled":
    case "security.installAudit.blockOnCritical":
    case "security.installAudit.blockUnlistedRegistries":
    case "security.installAudit.registryAllowlist":
    case "security.installAudit.registryWhitelist":
    case "security.installAudit.allowedFindings":
      return mergeConfigValue(config, parseConfigValue(key, rawValue));
    default:
      throw new UsageError(`Unknown config key: ${key}`);
  }
}

export function unsetConfigValue(config: AkmConfig, key: string): AkmConfig {
  switch (key) {
    case "stashDir":
      return { ...config, stashDir: undefined };
    case "embedding":
      return { ...config, embedding: undefined };
    case "llm":
      return { ...config, llm: undefined };
    case "registries":
      return { ...config, registries: undefined };
    case "sources":
    case "stashes":
      // "stashes" is kept as an alias for backwards-compat; both clear `sources`.
      return { ...config, sources: undefined, stashes: undefined };
    case "output.format":
      return { ...config, output: mergeOutputConfig(config.output, { format: undefined }) };
    case "output.detail":
      return { ...config, output: mergeOutputConfig(config.output, { detail: undefined }) };
    case "security":
      return { ...config, security: undefined };
    case "security.installAudit.enabled":
      return { ...config, security: mergeSecurityConfig(config.security, { installAudit: { enabled: undefined } }) };
    case "security.installAudit.blockOnCritical":
      return {
        ...config,
        security: mergeSecurityConfig(config.security, { installAudit: { blockOnCritical: undefined } }),
      };
    case "security.installAudit.blockUnlistedRegistries":
      return {
        ...config,
        security: mergeSecurityConfig(config.security, { installAudit: { blockUnlistedRegistries: undefined } }),
      };
    case "security.installAudit.registryAllowlist":
    case "security.installAudit.registryWhitelist":
      return {
        ...config,
        security: mergeSecurityConfig(config.security, {
          installAudit: { registryAllowlist: undefined, registryWhitelist: undefined },
        }),
      };
    case "security.installAudit.allowedFindings":
      return {
        ...config,
        security: mergeSecurityConfig(config.security, {
          installAudit: { allowedFindings: undefined },
        }),
      };
    default:
      throw new UsageError(`Unknown or unsupported unset key: ${key}`);
  }
}

export function listConfig(config: AkmConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {
    semanticSearchMode: config.semanticSearchMode,
    registries: config.registries ?? DEFAULT_CONFIG.registries ?? [],
    output: mergeOutputConfig(DEFAULT_CONFIG.output, config.output) ?? null,
    stashDir: config.stashDir ?? null,
    installed: config.installed ?? [],
    sources: config.sources ?? config.stashes ?? [],
  };
  if (config.embedding) result.embedding = config.embedding;
  if (config.llm) result.llm = config.llm;
  if (config.security) result.security = config.security;
  return result;
}

function mergeConfigValue(config: AkmConfig, partial: Partial<AkmConfig>): AkmConfig {
  return {
    ...config,
    ...partial,
    output: mergeOutputConfig(config.output, partial.output),
    security: mergeSecurityConfig(config.security, partial.security),
  };
}

function mergeOutputConfig(base?: OutputConfig, override?: OutputConfig): OutputConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return merged.format || merged.detail ? merged : undefined;
}

function mergeSecurityConfig(base?: SecurityConfig, override?: SecurityConfig): SecurityConfig | undefined {
  const mergedInstallAudit = mergeInstallAuditConfig(base?.installAudit, override?.installAudit);
  return mergedInstallAudit ? { installAudit: mergedInstallAudit } : undefined;
}

function mergeInstallAuditConfig(
  base?: InstallAuditConfig,
  override?: InstallAuditConfig,
): InstallAuditConfig | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  const hasValue = Object.values(merged).some((value) => value !== undefined);
  return hasValue ? merged : undefined;
}

function parseOutputFormat(value: string): OutputConfig["format"] {
  if (value === "json" || value === "yaml" || value === "text") return value;
  throw new UsageError(`Invalid value for output.format: expected one of json|yaml|text`);
}

function parseOutputDetail(value: string): OutputConfig["detail"] {
  if (value === "brief" || value === "normal" || value === "full") return value;
  throw new UsageError(`Invalid value for output.detail: expected one of brief|normal|full`);
}

function parseBooleanValue(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`Invalid value for ${key}: expected true or false`);
}

function parseStringArrayValue(value: string, key: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(`Invalid value for ${key}: expected a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new UsageError(`Invalid value for ${key}: expected a JSON array of strings`);
  }
  return parsed;
}

function getInstallAuditAllowlist(config: AkmConfig): string[] | null {
  return config.security?.installAudit?.registryAllowlist ?? config.security?.installAudit?.registryWhitelist ?? null;
}

function parseAllowedFindingsValue(value: string, key: string): InstallAuditConfig["allowedFindings"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError(`Invalid value for ${key}: expected a JSON array of {id, ref?, path?, reason?} objects`);
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(`Invalid value for ${key}: expected a JSON array`);
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UsageError(`Invalid value for ${key}[${i}]: expected an object with an "id" field`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id) {
      throw new UsageError(`Invalid value for ${key}[${i}]: "id" is required`);
    }
    const result: NonNullable<InstallAuditConfig["allowedFindings"]>[number] = { id: obj.id };
    if (typeof obj.ref === "string" && obj.ref) result.ref = obj.ref;
    if (typeof obj.path === "string" && obj.path) result.path = obj.path;
    if (typeof obj.reason === "string" && obj.reason) result.reason = obj.reason;
    return result;
  });
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
  const localModel = typeof parsed.localModel === "string" && parsed.localModel ? parsed.localModel : undefined;
  const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
  if (!endpoint) {
    if (!localModel) {
      throw new UsageError(
        `Invalid value for embedding: endpoint/model are required for remote embeddings, or provide localModel`,
      );
    }
    const localOnly: EmbeddingConnectionConfig = { endpoint: "", model: "", localModel };
    if (typeof parsed.provider === "string" && parsed.provider) localOnly.provider = parsed.provider;
    return localOnly;
  }
  const result: EmbeddingConnectionConfig = {
    endpoint: asRequiredString(parsed.endpoint, "embedding", "endpoint"),
    model: asRequiredString(parsed.model, "embedding", "model"),
  };
  if (typeof parsed.provider === "string" && parsed.provider) result.provider = parsed.provider;
  if (parsed.dimension !== undefined)
    result.dimension = parseUnknownPositiveInteger(parsed.dimension, "embedding.dimension");
  if (typeof parsed.apiKey === "string" && parsed.apiKey) result.apiKey = parsed.apiKey;
  if (localModel) result.localModel = localModel;
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
      "INVALID_JSON_CONFIG_VALUE",
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

function parseStashesValue(value: string): SourceConfigEntry[] | undefined {
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
    const result: SourceConfigEntry = { type: obj.type };
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
