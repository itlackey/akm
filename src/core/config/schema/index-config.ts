// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index` config: reserved feature sections + arbitrary per-pass entries.
 * Extracted verbatim from the former `config-schema.ts` monolith — no behavior
 * change.
 */
import { z } from "zod";
import { warnOnce } from "../../warn";
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

/**
 * Per-pass `index.<pass>` entry. The preprocess names and drops the retired
 * engine settings above with a targeted message. Any other unknown key is kept
 * and named once by the config loader's schema walk, like an unknown key
 * anywhere else in config.
 */
export const IndexPassConfigSchema = z.preprocess(
  (raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return raw; // let z.object below produce the type error
    }
    const obj = raw as Record<string, unknown>;
    let cleaned: Record<string, unknown> | undefined;
    for (const key of Object.keys(obj)) {
      const dotted = [...(ctx.path ?? []), key].join(".");
      if (INDEX_PASS_RETIRED_KEYS.has(key)) {
        warnOnce(
          `index-pass:retired:${dotted}`,
          `\`${dotted}\` is a retired engine setting and is ignored; select a named engine and use typed invocation fields instead.`,
        );
        cleaned ??= { ...obj };
        delete cleaned[key];
      }
    }
    return cleaned ?? raw;
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
    })
    .passthrough(),
);

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
  graph?: z.infer<typeof IndexPassConfigSchema>;
  memory?: z.infer<typeof IndexPassConfigSchema>;
  enrichment?: z.infer<typeof IndexPassConfigSchema>;
};

/**
 * Index config is a union of reserved feature sections and per-pass entries.
 * Passthrough so per-pass entries (keyed by arbitrary pass names like `graph`,
 * `enrichment`) can live next to the reserved keys.
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
    let cleaned: Record<string, unknown> | undefined;
    for (const [passName, value] of Object.entries(raw as Record<string, unknown>)) {
      if (passName === "stalenessDetection") {
        warnOnce("index:stalenessDetection", "`index.stalenessDetection` is a retired pass and is ignored.");
        cleaned ??= { ...(raw as Record<string, unknown>) };
        delete cleaned.stalenessDetection;
        continue;
      }
      if (passName === "metadataEnhance") {
        warnOnce("index:metadataEnhance", "`index.metadataEnhance` is retired and is ignored.");
        cleaned ??= { ...(raw as Record<string, unknown>) };
        delete cleaned.metadataEnhance;
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
    return cleaned ?? raw;
  },
  z
    .object({
      defaults: IndexDefaultsSchema.optional(),
    })
    .catchall(IndexPassConfigSchema),
);

// The runtime catchall correctly validates arbitrary pass objects, but its
// inferred string index signature also covers reserved scalar keys. Publish a
// precise output type while retaining the stricter runtime and JSON schemas.
export const IndexConfigSchema = IndexConfigRuntimeSchema as z.ZodType<IndexConfigOutput>;
