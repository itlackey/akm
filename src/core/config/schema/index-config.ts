// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index` config: the index-wide model-work settings + arbitrary per-pass entries.
 */
import { z } from "zod";
import { engineName, LlmInvocationOverridesSchema, nonEmptyString, positiveInt } from "./primitives";

// ── Index / per-pass ────────────────────────────────────────────────────────

/**
 * Per-pass `index.<pass>` entry. Unknown keys (including inline connection
 * settings an earlier release carried) are kept and named by the config
 * loader's schema walk like any other unknown key.
 */
export const IndexPassConfigSchema = z
  .object({
    connection: engineName.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    enabled: z.boolean().optional(),
    llm: LlmInvocationOverridesSchema.optional(),
  })
  .passthrough();

/** The keys that are settings for every pass, not a pass of their own. */
const INDEX_WIDE_KEYS = ["connection", "model", "timeoutMs", "llm"] as const;

type IndexConfigOutput = {
  [key: string]: unknown;
  connection?: string;
  model?: string;
  timeoutMs?: number | null;
  llm?: z.infer<typeof LlmInvocationOverridesSchema>;
  memory?: z.infer<typeof IndexPassConfigSchema>;
};

/**
 * Index config is the index-wide model-work settings (`connection`, `model`,
 * `timeoutMs`, `llm`) plus per-pass entries keyed by pass name. Passthrough so
 * per-pass entries (keyed by arbitrary pass names like `memory`, or a retired
 * one like `graph`) can live next to the index-wide keys. The outer preprocess
 * emits the legacy parser's actionable error messages for the two most common
 * type-shape mistakes:
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
      if ((INDEX_WIDE_KEYS as readonly string[]).includes(passName)) continue;
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
      connection: engineName.optional(),
      model: nonEmptyString.optional(),
      timeoutMs: z.union([positiveInt, z.null()]).optional(),
      llm: LlmInvocationOverridesSchema.optional(),
    })
    .catchall(IndexPassConfigSchema),
);

// The runtime catchall correctly validates arbitrary pass objects, but its
// inferred string index signature also covers reserved scalar keys. Publish a
// precise output type while retaining the stricter runtime and JSON schemas.
export const IndexConfigSchema = IndexConfigRuntimeSchema as z.ZodType<IndexConfigOutput>;
