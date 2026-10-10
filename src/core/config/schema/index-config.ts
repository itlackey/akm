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

/** Engine settings a pass once carried inline; the loader drops them (the unknown-key warning names each). */
const INDEX_PASS_DROPPED_KEYS = [
  "endpoint",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
];

/**
 * Per-pass `index.<pass>` entry. The inline engine settings above are dropped
 * from the loaded config, and the config loader's schema walk names each once
 * as an unknown key. Any other unknown key is kept and named the same way.
 */
export const IndexPassConfigSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw; // z.object below reports the type error
    const cleaned = { ...(raw as Record<string, unknown>) };
    for (const key of INDEX_PASS_DROPPED_KEYS) delete cleaned[key];
    return cleaned;
  },
  z
    .object({
      engine: engineName.optional(),
      model: nonEmptyString.optional(),
      timeoutMs: z.union([positiveInt, z.null()]).optional(),
      enabled: z.boolean().optional(),
      llm: LlmInvocationOverridesSchema.optional(),
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
  memory?: z.infer<typeof IndexPassConfigSchema>;
};

/**
 * Index config is a union of reserved feature sections and per-pass entries.
 * Passthrough so per-pass entries (keyed by arbitrary pass names like
 * `memory`, or a retired one like `graph`) can live next to the reserved keys.
 * The outer preprocess emits the legacy parser's actionable error messages
 * for the two most common type-shape mistakes:
 *   - An array at the `index` block.
 *   - A non-object at `index.<passName>`.
 * Inner field validation (invocation overrides, provider-key rejection) is
 * delegated to {@link IndexPassConfigSchema}.
 */
const IndexConfigRuntimeSchema = z.preprocess(
  (raw, ctx) => {
    if (raw === undefined || raw === null) return raw;
    if (Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "memory": { "enabled": false } }`).',
      });
      return raw;
    }
    if (typeof raw !== "object") return raw;
    for (const [passName, value] of Object.entries(raw as Record<string, unknown>)) {
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
    })
    .catchall(IndexPassConfigSchema),
);

// The runtime catchall correctly validates arbitrary pass objects, but its
// inferred string index signature also covers reserved scalar keys. Publish a
// precise output type while retaining the stricter runtime and JSON schemas.
export const IndexConfigSchema = IndexConfigRuntimeSchema as z.ZodType<IndexConfigOutput>;
