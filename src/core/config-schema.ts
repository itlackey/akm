/**
 * Zod schema for AkmConfig — the single source of truth for the on-disk shape.
 *
 * Two responsibilities:
 * 1. **Validate + transform** the raw JSON-parsed config object into the runtime
 *    `AkmConfig` shape consumed by the rest of the codebase. Replaces the
 *    ~1.4k LOC of legacy per-shape parsers (parseLlmConfig, parseEmbeddingConfig,
 *    parseIndexConfig, etc.) — see `loadConfig` in `./config.ts`.
 * 2. **Reject hard-errored values** (openviking source type, legacy
 *    `stashes[]` key) at load time via `superRefine`.
 *
 * Design rules:
 * - Top-level uses `.passthrough()` so unknown future keys round-trip intact on
 *   read; `sanitizeConfigForWrite` decides what to persist.
 * - Most nested sub-objects use `.catch(undefined)` so malformed entries are
 *   silently dropped (matches the legacy parser's warn-and-ignore semantics for
 *   field-level shape errors — keeps cold-start working when a user has a
 *   typo in their config).
 * - Two exceptions (hard-rejected): openviking source type and legacy
 *   `stashes[]` key. Both have explicit migration paths; silently dropping
 *   would mask user data loss.
 * - `.strict()` walls still gate `registries[]`, `sources[]`, `profiles.*`
 *   sub-shapes so typos in those structured records are caught (#462).
 * - `defaultWriteTarget` resolution and similar cross-field invariants are
 *   enforced at save time via `superRefine` on the top-level schema.
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

/**
 * Connection config used for both top-level `llm` (after migration) and
 * `profiles.llm[*]`. `model` is required at schema level — partial entries
 * created by `akm config set llm.endpoint <url>` (where model is left absent)
 * are normalized to `model: ""` *before* Zod sees them by the load-time
 * pre-Zod migrator hook, so this strict shape gates CLI writes without
 * breaking legacy load-time partial configs.
 */
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

/**
 * Embedding connection config. Two modes:
 *   - Remote: `endpoint` (http/https) + `model` are both required.
 *   - Local-only: `localModel` set; endpoint/model degrade to "" sentinels
 *     so downstream `hasRemoteEndpoint()` callers can detect the local path.
 *
 * Pre-Zod preprocess synthesizes the local-only sentinel shape when the user
 * supplied only `localModel`, or when the remote endpoint is unusable but a
 * localModel fallback is available — matches the legacy parser's behaviour
 * (tested at tests/embedding-model-config.test.ts).
 */
export const EmbeddingConnectionConfigSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const obj = { ...(raw as Record<string, unknown>) };
    const localModel = typeof obj.localModel === "string" && obj.localModel ? obj.localModel : undefined;
    const endpoint = typeof obj.endpoint === "string" ? obj.endpoint : undefined;
    const model = typeof obj.model === "string" ? obj.model : undefined;
    const isValidHttpUrl = endpoint && (endpoint.startsWith("http://") || endpoint.startsWith("https://"));
    // Pure local-only: only localModel is meaningful. Force sentinel empty
    // endpoint+model so the strict object below validates.
    if (!endpoint || !isValidHttpUrl || !model) {
      if (localModel) {
        return { ...obj, endpoint: "", model: "", localModel };
      }
    }
    return obj;
  },
  z
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
    .strict(),
);

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

/**
 * Wrap a record schema so individual entries that fail validation are dropped
 * instead of rejecting the whole record. Used for profiles.{llm,agent,improve}
 * — a single typoed profile should not nullify all profiles.
 */
function looseRecord<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.preprocess((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const parsed = valueSchema.safeParse(v);
      if (parsed.success) out[k] = parsed.data;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, z.record(z.string(), valueSchema).optional());
}

export const ProfilesSchema = z
  .object({
    llm: looseRecord(LlmProfileConfigSchema),
    agent: looseRecord(AgentProfileConfigSchema),
    improve: looseRecord(ImproveProfileConfigSchema),
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

/**
 * Output config is forgiving — invalid `format` or `detail` values are
 * silently stripped before validation (legacy parser ignored them; tests at
 * config.test.ts:530 lock this in).
 */
export const OutputConfigSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (obj.format === "json" || obj.format === "yaml" || obj.format === "text") out.format = obj.format;
    if (obj.detail === "brief" || obj.detail === "normal" || obj.detail === "full") out.detail = obj.detail;
    return Object.keys(out).length > 0 ? out : undefined;
  },
  z
    .object({
      format: z.enum(["json", "yaml", "text"]).optional(),
      detail: z.enum(["brief", "normal", "full"]).optional(),
    })
    .strict()
    .optional(),
);

// ── Search ──────────────────────────────────────────────────────────────────

const SearchGraphBoostSchema = z.preprocess(
  (raw) => {
    // Pre-Zod: silently clamp maxHops to 3 and confidenceWeight to [0, 1] to
    // preserve the legacy parser's hard-cap semantics without rejecting the
    // whole graphBoost block on out-of-range user values.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const obj = { ...(raw as Record<string, unknown>) };
    if (typeof obj.maxHops === "number" && Number.isFinite(obj.maxHops) && obj.maxHops > 3) {
      obj.maxHops = 3;
    }
    if (typeof obj.confidenceWeight === "number" && Number.isFinite(obj.confidenceWeight) && obj.confidenceWeight > 1) {
      obj.confidenceWeight = 1;
    }
    return obj;
  },
  z
    .object({
      directBoostPerEntity: nonNegativeNumber.optional(),
      directBoostCap: nonNegativeNumber.optional(),
      hopBoostPerEntity: nonNegativeNumber.optional(),
      hopBoostCap: nonNegativeNumber.optional(),
      maxHops: positiveInt.max(3).optional(),
      confidenceMode: z.enum(["off", "blend", "multiply"]).default("blend").optional(),
      confidenceWeight: z.number().finite().min(0).max(1).default(0.2).optional(),
    })
    .passthrough(), // legacy parser warns-and-ignores unknown nested keys
);

export const SearchConfigSchema = z
  .object({
    minScore: nonNegativeNumber.optional(),
    curateRerank: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    graphBoost: SearchGraphBoostSchema.optional(),
  })
  .passthrough(); // legacy parser warns-and-ignores unknown top-level keys

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

const INDEX_PASS_PROVIDER_KEYS = new Set([
  "endpoint",
  "model",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
]);

const INDEX_PASS_KNOWN_KEYS = new Set([
  "llm",
  "graphExtractionBatchSize",
  "graphExtractionIncludeTypes",
  "memoryInferenceBatchSize",
]);

/**
 * Per-pass `index.<pass>` entry. Uses preprocess + manual validation so we can
 * emit the legacy parser's targeted error messages ("Duplicate LLM provider
 * configuration", "Unknown key `index.<pass>.<key>`", "expected a boolean")
 * instead of Zod's generic `Unrecognized key` / `Expected boolean, received
 * string` strings — keeps `akm` startup errors actionable.
 */
export const IndexPassConfigSchema = z.preprocess(
  (raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return raw; // let z.object below produce the type error
    }
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (INDEX_PASS_PROVIDER_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Duplicate LLM provider configuration: \`${[...(ctx.path ?? []), key].join(".")}\` is not allowed. ` +
            "Configure provider/model/endpoint under `profiles.llm` only; per-pass entries support `{ llm: false }` opt-out.",
        });
        return raw;
      }
      if (!INDEX_PASS_KNOWN_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Unknown key \`${[...(ctx.path ?? []), key].join(".")}\`. Per-pass entries support \`llm\` ` +
            "(boolean opt-out), `graphExtractionBatchSize`, `graphExtractionIncludeTypes`, and " +
            "`memoryInferenceBatchSize`.",
        });
        return raw;
      }
    }
    if ("llm" in obj && typeof obj.llm !== "boolean") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid \`${[...(ctx.path ?? []), "llm"].join(".")}\`: expected a boolean (true to use the default LLM profile, false to opt out). Got ${typeof obj.llm}.`,
      });
      return raw;
    }
    return raw;
  },
  z
    .object({
      llm: z.boolean().optional(),
      graphExtractionBatchSize: positiveInt.optional(),
      graphExtractionIncludeTypes: z.array(z.enum(GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED)).nonempty().optional(),
      memoryInferenceBatchSize: positiveInt.optional(),
    })
    .passthrough(),
);

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
 *
 * The outer preprocess emits the legacy parser's actionable error messages
 * for the two most common type-shape mistakes:
 *   - An array at the `index` block.
 *   - A non-object at `index.<passName>`.
 * Inner field validation (graphExtractionIncludeTypes enum, llm boolean,
 * provider-key rejection) is delegated to {@link IndexPassConfigSchema}.
 */
export const IndexConfigSchema = z.preprocess(
  (raw, ctx) => {
    if (raw === undefined || raw === null) return raw;
    if (Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "enrichment": { "llm": false } }`).',
      });
      return raw;
    }
    if (typeof raw !== "object") return raw;
    for (const [passName, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid \`index.${passName}\` config: expected an object like \`{ "llm": false }\`.`,
        });
        return raw;
      }
      if (
        passName !== "metadataEnhance" &&
        passName !== "stalenessDetection" &&
        Array.isArray((value as Record<string, unknown>).graphExtractionIncludeTypes)
      ) {
        const arr = (value as Record<string, unknown>).graphExtractionIncludeTypes as unknown[];
        const invalid: string[] = [];
        for (const t of arr) {
          if (
            typeof t === "string" &&
            !GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED.includes(
              t.toLowerCase() as (typeof GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED)[number],
            )
          ) {
            invalid.push(t);
          }
        }
        if (invalid.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid \`index.${passName}.graphExtractionIncludeTypes\`: unsupported type(s): ${invalid.join(", ")}.`,
          });
          return raw;
        }
      }
    }
    return raw;
  },
  z
    .object({
      metadataEnhance: MetadataEnhanceSchema.optional(),
      stalenessDetection: StalenessDetectionSchema.optional(),
    })
    .catchall(IndexPassConfigSchema),
);

// ── Top-level AkmConfig ────────────────────────────────────────────────────

/**
 * Coerce `semanticSearchMode` to the runtime enum. Accepts the legacy boolean
 * form (true → "auto", false → "off") and falls back to "auto" for any other
 * value type. Matches the legacy parser's tolerant behaviour.
 */
const semanticSearchModeSchema = z
  .preprocess(
    (v) => {
      if (typeof v === "boolean") return v ? "auto" : "off";
      if (v === "auto" || v === "off") return v;
      return "auto";
    },
    z.enum(["off", "auto"]),
  )
  .default("auto");

/**
 * Optional sub-object that drops to undefined on validation failure. Wrap any
 * schema where the legacy parser silently ignored a malformed value.
 */
function lossy<T extends z.ZodTypeAny>(schema: T) {
  return schema.optional().catch(() => undefined);
}

/**
 * Optional array that drops individual items that fail validation instead of
 * rejecting the whole array. Use for arrays where the legacy parser used a
 * "filter undefined results" pattern (e.g. registries[]).
 */
function tolerantArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.preprocess((raw) => {
    if (!Array.isArray(raw)) return undefined;
    const out: unknown[] = [];
    for (const item of raw) {
      const parsed = itemSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }, z.array(itemSchema).optional());
}

/**
 * Like {@link tolerantArray} but issues from `superRefine` (custom messages
 * like "writable: true is only supported on filesystem and git sources") are
 * propagated as hard errors instead of dropping the item. Use for arrays where
 * the legacy parser had `throw new ConfigError(...)` policy gates.
 */
function installedArrayWithRefineEscalation<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.preprocess((raw, ctx) => {
    if (!Array.isArray(raw)) return undefined;
    const out: unknown[] = [];
    for (const item of raw) {
      const parsed = itemSchema.safeParse(item);
      if (parsed.success) {
        out.push(parsed.data);
        continue;
      }
      // Escalate `superRefine` issues (z.ZodIssueCode.custom) to the parent
      // context — these are policy violations that should fail-fast. Other
      // issues (missing fields, wrong types) drop silently.
      const customIssues = parsed.error.issues.filter((i) => i.code === z.ZodIssueCode.custom);
      for (const issue of customIssues) {
        ctx.addIssue(issue);
      }
    }
    return out;
  }, z.array(itemSchema).optional());
}

/**
 * Base object schema used both as the top-level shape and as the source of
 * truth for {@link listTopLevelConfigKeys}. {@link AkmConfigSchema} wraps this
 * with cross-field refinements (`.superRefine()`).
 */
export const AkmConfigShape = {
  configVersion: z.union([z.string().min(1), z.number()]).optional(),
  profiles: lossy(ProfilesSchema),
  defaults: lossy(DefaultsSchema),
  stashDir: z
    .preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : undefined), nonEmptyString.optional())
    .optional(),
  semanticSearchMode: semanticSearchModeSchema,
  embedding: lossy(EmbeddingConnectionConfigSchema),
  // `index` is intentionally strict — unknown keys, non-boolean `llm`, etc.
  // hard-error at load time so users see typos at startup, not at index time.
  // Legacy parser also threw ConfigError here.
  index: IndexConfigSchema.optional(),
  // installed[]: per-item tolerant — entries with unrecognised `source` types
  // (e.g. "filesystem" — only the four KitSource kinds are accepted) drop
  // silently. The writable+non-git superRefine violation still propagates as
  // a hard ConfigError because Zod's preprocess wrapper surfaces refinement
  // failures distinctly from shape failures.
  installed: installedArrayWithRefineEscalation(InstalledStashEntrySchema),
  // registries: per-item tolerant — bad entries (missing/empty URL, non-object)
  // are dropped silently, keeping valid neighbors. Empty array means "no
  // registries" (overrides defaults).
  registries: tolerantArray(RegistryConfigEntrySchema),
  // sources[]: per-item shape errors drop silently, but explicit policy
  // violations (writable+npm/website) escalate to a hard ConfigError. The
  // pre-Zod rejectHardErrors hook in config.ts also catches openviking up
  // front for a more actionable message.
  sources: installedArrayWithRefineEscalation(SourceConfigEntrySchema),
  security: lossy(SecurityConfigSchema),
  output: lossy(OutputConfigSchema),
  writable: z.boolean().optional(),
  defaultWriteTarget: nonEmptyString.optional(),
  search: lossy(SearchConfigSchema),
  feedback: lossy(FeedbackConfigSchema),
  archiveRetentionDays: nonNegativeNumber.optional(),
  improve: lossy(ImproveConfigSchema),
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
