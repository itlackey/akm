// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index` config: reserved feature sections + arbitrary per-pass entries.
 * Extracted verbatim from the former `config-schema.ts` monolith — no behavior
 * change.
 */
import { z } from "zod";
import { engineName, LlmInvocationOverridesSchema, nonEmptyString, positiveInt } from "./primitives";

// ── Index / per-pass ────────────────────────────────────────────────────────
//
// WI-9.6c: `graphExtractionIncludeTypes` is no longer validated against a
// hardcoded allowlist (the prior GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED,
// which included a stale `wiki` entry and was already missing `fact` from the
// runtime consumer's own list — the schema-level allowlist had drifted from
// reality). Accept-any until Chunk 2 sources a real type list from adapter
// metadata: the field is now an array of arbitrary non-empty strings.
// Runtime consumers already handle unknown/unsupported type strings
// gracefully — src/indexer/graph/graph-extraction.ts's
// `SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES` set (and `collectEligibleFiles`)
// silently skips any type it doesn't recognize (no placement entry ⇒ zero
// eligible files for that type; no crash). This is a permissive-direction
// behavior change: configs with a previously-rejected type string now parse.

const INDEX_PASS_RETIRED_KEYS = new Set([
  "endpoint",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
]);

const INDEX_PASS_KNOWN_KEYS = new Set([
  "engine",
  "model",
  "timeoutMs",
  "enabled",
  "llm",
  "graphExtractionBatchSize",
  "graphExtractionIncludeTypes",
  "lazyGraphExtraction",
]);

/**
 * Per-pass `index.<pass>` entry. Uses preprocess + manual validation so we can
 * emit targeted error messages ("Retired or misplaced engine setting",
 * "Unknown key `index.<pass>.<key>`")
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
      if (INDEX_PASS_RETIRED_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Retired or misplaced engine setting: \`${[...(ctx.path ?? []), key].join(".")}\` is not allowed. ` +
            "Select a named engine and use typed invocation fields instead.",
        });
        return raw;
      }
      if (!INDEX_PASS_KNOWN_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Unknown key \`${[...(ctx.path ?? []), key].join(".")}\`. Per-pass entries support ` +
            "`engine`, `model`, `timeoutMs`, `enabled`, `llm`, `graphExtractionBatchSize`, " +
            "`graphExtractionIncludeTypes`, and `lazyGraphExtraction`.",
        });
        return raw;
      }
    }
    return raw;
  },
  z
    .object({
      engine: engineName.optional(),
      model: nonEmptyString.optional(),
      timeoutMs: z.union([positiveInt, z.null()]).optional(),
      enabled: z.boolean().optional(),
      llm: LlmInvocationOverridesSchema.optional(),
      graphExtractionBatchSize: positiveInt.optional(),
      // Accept-any until Chunk 2 (WI-9.6c) — no longer enum-restricted.
      graphExtractionIncludeTypes: z.array(z.string().min(1)).nonempty().optional(),
      lazyGraphExtraction: z.boolean().optional(),
    })
    .passthrough(),
);

const MetadataEnhanceSchema = z.object({ enabled: z.boolean().optional() }).passthrough();

/**
 * RETIRED (meta-review 10-Q3): the staleness-detect pass was deleted; nothing
 * reads this section anymore. The key stays TOLERATED here so configs that
 * still carry `index.stalenessDetection` (written by 0.8.x migrations) do not
 * fail validation — deleting the key would route it into the per-pass
 * catchall, which rejects its `enabled`/`thresholdDays` fields.
 */
const StalenessDetectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdDays: positiveInt.optional(),
  })
  .passthrough();

const IndexDefaultsSchema = z
  .object({
    engine: engineName.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    llm: LlmInvocationOverridesSchema.optional(),
  })
  .passthrough();

type IndexConfigOutput = {
  [key: string]: unknown;
  defaults?: z.infer<typeof IndexDefaultsSchema>;
  metadataEnhance?: z.infer<typeof MetadataEnhanceSchema>;
  stalenessDetection?: z.infer<typeof StalenessDetectionSchema>;
  graph?: z.infer<typeof IndexPassConfigSchema>;
  memory?: z.infer<typeof IndexPassConfigSchema>;
  enrichment?: z.infer<typeof IndexPassConfigSchema>;
  indexBodyOpening?: boolean;
};

/**
 * Index config is a union of reserved feature sections and per-pass entries.
 * Passthrough so per-pass entries (keyed by arbitrary pass names like `graph`,
 * `enrichment`) can live next to the reserved keys.
 *
 * Reserved scalar key `indexBodyOpening` (stash-conventions SPEC-8, default
 * false): when true, the metadata pass captures the first prose paragraph of
 * each markdown asset body into `entry.bodyOpening`, which folds into the
 * lowest-weight `content` FTS column and the embedding text. It is a boolean,
 * not a per-pass object — the preprocess below exempts it from the
 * object-shape check so it never routes into the per-pass catchall.
 *
 * The outer preprocess emits the legacy parser's actionable error messages
 * for the two most common type-shape mistakes:
 *   - An array at the `index` block.
 *   - A non-object at `index.<passName>`.
 * Inner field validation (graphExtractionIncludeTypes shape, invocation
 * overrides, provider-key rejection) is delegated to {@link IndexPassConfigSchema}.
 * `graphExtractionIncludeTypes` accepts arbitrary non-empty strings
 * (WI-9.6c — no hardcoded type allowlist; accept-any until Chunk 2).
 */
const IndexConfigRuntimeSchema = z.preprocess(
  (raw, ctx) => {
    if (raw === undefined || raw === null) return raw;
    if (Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "enrichment": { "enabled": false } }`).',
      });
      return raw;
    }
    if (typeof raw !== "object") return raw;
    for (const [passName, value] of Object.entries(raw as Record<string, unknown>)) {
      if (passName === "indexBodyOpening") {
        if (typeof value !== "boolean") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Invalid `index.indexBodyOpening`: expected a boolean (true to index the first body paragraph " +
              `of markdown assets into search). Got ${Array.isArray(value) ? "array" : typeof value}.`,
          });
          return raw;
        }
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid \`index.${passName}\` config: expected an object like \`{ "enabled": false }\`.`,
        });
        return raw;
      }
    }
    return raw;
  },
  z
    .object({
      defaults: IndexDefaultsSchema.optional(),
      metadataEnhance: MetadataEnhanceSchema.optional(),
      stalenessDetection: StalenessDetectionSchema.optional(),
      indexBodyOpening: z
        .boolean()
        .optional()
        .describe(
          "Index the first prose paragraph of each markdown asset body (capped at 280 chars) into the " +
            "lowest-weight `content` search column and the embedding text (default false). Secret/env files " +
            "and session-kind memories are never captured. Toggling the flag changes indexed text: run " +
            "`akm index --full` afterwards to re-extract every entry and regenerate embeddings, and re-mint " +
            "collapse-detector canary baselines via `akm improve canary --refresh`.",
        ),
    })
    .catchall(IndexPassConfigSchema),
);

// The runtime catchall correctly validates arbitrary pass objects, but its
// inferred string index signature also covers reserved scalar keys. Publish a
// precise output type while retaining the stricter runtime and JSON schemas.
export const IndexConfigSchema = IndexConfigRuntimeSchema as z.ZodType<IndexConfigOutput>;
