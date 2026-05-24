/**
 * Zod schema for AkmConfig — the single source of truth for the on-disk shape.
 *
 * The runtime `AkmConfig` type (in `./config.ts`) is gradually being replaced by
 * `z.infer<typeof AkmConfigSchema>` from this file. During the 0.8.0 rewrite
 * both shapes coexist; the schema lives here so we can iterate on it without
 * touching the legacy parser yet.
 *
 * Design rules:
 * - Top-level `AkmConfigSchema` uses `.passthrough()` so unknown keys round-trip
 *   intact (matches the historical loader's "warn-and-ignore" semantics for
 *   future-format fields).
 * - Nested sub-objects use `.strict()` where unknown keys would be a footgun
 *   (registries[], sources[], improve.utilityDecay, etc.). This is enforced
 *   per Issue #462.
 * - Validation errors are structured (`{ path, message }`) so the CLI can
 *   render them in a list.
 */
import { z } from "zod";

// ── Reusable atomic schemas ─────────────────────────────────────────────────

/** Positive integer (used for tokens, timeouts, batch sizes). */
const positiveInt = z.number().int().positive();

/** Non-negative finite number (used for scores, weights, days). */
const nonNegativeNumber = z.number().finite().min(0);

/** Non-empty string (rejects "" and whitespace-only). */
const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, { message: "expected a non-empty string" });

/** HTTP(S) URL string. */
const httpUrl = z.string().refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
  message: "endpoint must start with http:// or https://",
});

// ── Feedback failure modes ──────────────────────────────────────────────────

export const FEEDBACK_FAILURE_MODES = ["incorrect", "outdated", "dangerous", "incomplete", "redundant"] as const;

// ── Connection configs (LLM / embedding) ────────────────────────────────────

const LlmCapabilitiesSchema = z
  .object({
    structuredOutput: z.boolean().optional(),
  })
  .strict();

export const LlmConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string(),
    model: z.string(),
    apiKey: z.string().optional(),
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    timeoutMs: positiveInt.optional(),
    concurrency: positiveInt.optional(),
    capabilities: LlmCapabilitiesSchema.optional(),
    extraParams: z.record(z.unknown()).optional(),
    contextLength: positiveInt.optional(),
    judgeModel: z.string().min(1).optional(),
  })
  .strict();

export const LlmProfileConfigSchema = LlmConnectionConfigSchema.extend({
  supportsJsonSchema: z.boolean().optional(),
}).strict();

const EmbeddingOllamaOptionsSchema = z
  .object({
    num_ctx: positiveInt.optional(),
  })
  .strict();

export const EmbeddingConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string(),
    model: z.string(),
    apiKey: z.string().optional(),
    dimension: positiveInt.optional(),
    localModel: z.string().min(1).optional(),
    maxTokens: positiveInt.optional(),
    batchSize: positiveInt.optional(),
    chunkSize: positiveInt.optional(),
    contextLength: positiveInt.optional(),
    ollamaOptions: EmbeddingOllamaOptionsSchema.optional(),
  })
  .strict();

// ── Agent profiles ──────────────────────────────────────────────────────────

const AgentPlatformSchema = z.enum(["opencode", "claude", "opencode-sdk"]);

export const AgentProfileConfigSchema = z
  .object({
    platform: AgentPlatformSchema,
    bin: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    workspace: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

// ── Improve profile / process ──────────────────────────────────────────────

export const ImproveProcessConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["llm", "agent", "sdk"]).optional(),
    profile: z.string().min(1).optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    allowedTypes: z.array(z.string().min(1)).optional(),
    cooldownByType: z.record(z.string(), nonNegativeNumber).optional(),
    cooldownDays: nonNegativeNumber.optional(),
    qualityGate: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    contradictionDetection: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict();

const ImproveProfileProcessesSchema = z
  .object({
    reflect: ImproveProcessConfigSchema.optional(),
    distill: ImproveProcessConfigSchema.optional(),
    consolidate: ImproveProcessConfigSchema.optional(),
    memoryInference: ImproveProcessConfigSchema.optional(),
    graphExtraction: ImproveProcessConfigSchema.optional(),
    feedbackDistillation: ImproveProcessConfigSchema.optional(),
    validation: ImproveProcessConfigSchema.optional(),
  })
  .strict();

export const ImproveProfileConfigSchema = z
  .object({
    description: z.string().min(1).optional(),
    processes: ImproveProfileProcessesSchema.optional(),
    autoAccept: nonNegativeNumber.optional(),
    limit: positiveInt.optional(),
  })
  .strict();

// ── Profiles / defaults ────────────────────────────────────────────────────

export const ProfilesSchema = z
  .object({
    llm: z.record(z.string(), LlmProfileConfigSchema).optional(),
    agent: z.record(z.string(), AgentProfileConfigSchema).optional(),
    improve: z.record(z.string(), ImproveProfileConfigSchema).optional(),
  })
  .strict();

export const DefaultsSchema = z
  .object({
    llm: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    improve: z.string().min(1).optional(),
  })
  .strict();

// ── Sources / registries / installed ────────────────────────────────────────

const SourceConfigEntryOptionsSchema = z
  .object({
    pushOnCommit: z.boolean().optional(),
  })
  .passthrough();

export const SourceConfigEntrySchema = z
  .object({
    type: nonEmptyString,
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    writable: z.boolean().optional(),
    primary: z.boolean().optional(),
    options: SourceConfigEntryOptionsSchema.optional(),
    wikiName: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.writable === true && (entry.type === "website" || entry.type === "npm")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `writable: true is only supported on filesystem and git sources (got "${entry.type}"` +
          (entry.name ? ` on source "${entry.name}"` : "") +
          ").",
      });
    }
  });

export const RegistryConfigEntrySchema = z
  .object({
    url: httpUrl,
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    provider: z.string().min(1).optional(),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

const KitSourceSchema = z.enum(["npm", "github", "git", "local"]);

export const InstalledStashEntrySchema = z
  .object({
    id: nonEmptyString,
    source: KitSourceSchema,
    ref: nonEmptyString,
    artifactUrl: nonEmptyString,
    stashRoot: nonEmptyString,
    cacheDir: nonEmptyString,
    installedAt: nonEmptyString,
    writable: z.boolean().optional(),
    resolvedVersion: z.string().min(1).optional(),
    resolvedRevision: z.string().min(1).optional(),
    wikiName: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.writable === true && entry.source !== "git") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `writable: true is only supported on filesystem and git sources (got "${entry.source}" on installed entry "${entry.id}").`,
      });
    }
  });

// ── Security / install audit ────────────────────────────────────────────────

const InstallAuditAllowedFindingSchema = z
  .object({
    id: nonEmptyString,
    ref: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const InstallAuditConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    blockOnCritical: z.boolean().optional(),
    blockUnlistedRegistries: z.boolean().optional(),
    registryAllowlist: z.array(nonEmptyString).optional(),
    registryWhitelist: z.array(nonEmptyString).optional(),
    allowedFindings: z.array(InstallAuditAllowedFindingSchema).optional(),
  })
  .strict();

export const SecurityConfigSchema = z
  .object({
    installAudit: InstallAuditConfigSchema.optional(),
  })
  .strict();

// ── Output ──────────────────────────────────────────────────────────────────

export const OutputConfigSchema = z
  .object({
    format: z.enum(["json", "yaml", "text"]).optional(),
    detail: z.enum(["brief", "normal", "full"]).optional(),
  })
  .strict();

// ── Search ──────────────────────────────────────────────────────────────────

const SearchGraphBoostSchema = z
  .object({
    directBoostPerEntity: nonNegativeNumber.optional(),
    directBoostCap: nonNegativeNumber.optional(),
    hopBoostPerEntity: nonNegativeNumber.optional(),
    hopBoostCap: nonNegativeNumber.optional(),
    maxHops: positiveInt.max(3).optional(),
    confidenceMode: z.enum(["off", "blend", "multiply"]).optional(),
    confidenceWeight: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const SearchConfigSchema = z
  .object({
    minScore: nonNegativeNumber.optional(),
    curateRerank: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    graphBoost: SearchGraphBoostSchema.optional(),
  })
  .strict();

// ── Feedback ────────────────────────────────────────────────────────────────

export const FeedbackConfigSchema = z
  .object({
    requireReason: z.boolean().optional(),
    allowedFailureModes: z.array(nonEmptyString).optional(),
  })
  .strict();

// ── Improve top-level (utility decay, event retention) ─────────────────────

const ImproveUtilityDecaySchema = z
  .object({
    halfLifeDays: z.number().finite().min(0.1).optional(),
    feedbackStabilityBoost: z.number().finite().min(1).optional(),
  })
  .strict();

export const ImproveConfigSchema = z
  .object({
    utilityDecay: ImproveUtilityDecaySchema.optional(),
    eventRetentionDays: nonNegativeNumber.optional(),
  })
  .strict();

// ── Index / per-pass ────────────────────────────────────────────────────────

const GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED = [
  "memory",
  "knowledge",
  "skill",
  "command",
  "agent",
  "workflow",
  "lesson",
  "task",
  "wiki",
] as const;

export const IndexPassConfigSchema = z
  .object({
    llm: z.boolean().optional(),
    graphExtractionBatchSize: positiveInt.optional(),
    graphExtractionIncludeTypes: z.array(z.enum(GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED)).nonempty().optional(),
    memoryInferenceBatchSize: positiveInt.optional(),
  })
  .strict();

const MetadataEnhanceSchema = z.object({ enabled: z.boolean().optional() }).strict();

const StalenessDetectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdDays: positiveInt.optional(),
  })
  .strict();

/**
 * Index config is a union of reserved feature sections and per-pass entries.
 * Passthrough so per-pass entries (keyed by arbitrary pass names like `graph`,
 * `enrichment`) can live next to the reserved keys.
 */
export const IndexConfigSchema = z
  .object({
    metadataEnhance: MetadataEnhanceSchema.optional(),
    stalenessDetection: StalenessDetectionSchema.optional(),
  })
  .catchall(IndexPassConfigSchema);

// ── Top-level AkmConfig ────────────────────────────────────────────────────

/**
 * Base object schema used both as the top-level shape and as the source of
 * truth for {@link listTopLevelConfigKeys}. {@link AkmConfigSchema} wraps this
 * with cross-field refinements (`.superRefine()`).
 */
export const AkmConfigShape = {
  configVersion: z.union([z.string().min(1), z.number()]).optional(),
  profiles: ProfilesSchema.optional(),
  defaults: DefaultsSchema.optional(),
  stashDir: nonEmptyString.optional(),
  semanticSearchMode: z.enum(["off", "auto"]).default("auto"),
  embedding: EmbeddingConnectionConfigSchema.optional(),
  index: IndexConfigSchema.optional(),
  installed: z.array(InstalledStashEntrySchema).optional(),
  registries: z.array(RegistryConfigEntrySchema).optional(),
  stashInheritance: z.enum(["merge", "replace"]).optional(),
  sources: z.array(SourceConfigEntrySchema).optional(),
  security: SecurityConfigSchema.optional(),
  output: OutputConfigSchema.optional(),
  writable: z.boolean().optional(),
  defaultWriteTarget: nonEmptyString.optional(),
  search: SearchConfigSchema.optional(),
  feedback: FeedbackConfigSchema.optional(),
  archiveRetentionDays: nonNegativeNumber.optional(),
  improve: ImproveConfigSchema.optional(),
} as const;

export const AkmConfigBaseSchema = z.object(AkmConfigShape).passthrough();

export const AkmConfigSchema = AkmConfigBaseSchema.superRefine((config, ctx) => {
  // #464.a: defaultWriteTarget must name a configured source when sources
  // are present. With no sources configured, error out instead of silently
  // accepting (no implicit "first writable" fallback — see locked decision 3).
  if (config.defaultWriteTarget !== undefined) {
    const knownNames = (config.sources ?? [])
      .map((s) => s.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (knownNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWriteTarget"],
        message:
          `defaultWriteTarget "${config.defaultWriteTarget}" cannot be resolved: no sources configured. ` +
          "Add at least one entry to `sources` with a matching `name` first.",
      });
    } else if (!knownNames.includes(config.defaultWriteTarget)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWriteTarget"],
        message: `defaultWriteTarget "${config.defaultWriteTarget}" does not match any configured source name: ${knownNames.map((n) => `"${n}"`).join(", ")}.`,
      });
    }
  }
});

/** Canonical inferred type. Mirrors the runtime `AkmConfig` shape. */
export type AkmConfigInput = z.input<typeof AkmConfigSchema>;
export type AkmConfigParsed = z.output<typeof AkmConfigSchema>;

// ── Validation helpers ──────────────────────────────────────────────────────

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate a raw object against {@link AkmConfigSchema}. Returns a structured
 * result so callers can render errors as a list (instead of throwing on the
 * first issue).
 */
export function validateConfigShape(
  raw: unknown,
): { ok: true; value: AkmConfigParsed; errors: [] } | { ok: false; errors: ConfigValidationIssue[] } {
  const result = AkmConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data, errors: [] };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

// ── Top-level key listing (for hint messages) ───────────────────────────────

/**
 * Return the sorted list of top-level config keys recognized by the schema.
 * Used by error hints so the list stays in sync with the schema automatically
 * (#460).
 */
export function listTopLevelConfigKeys(): string[] {
  return Object.keys(AkmConfigShape).sort();
}
