// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI-compatible LLM connection configs + named agent/LLM engine schemas
 * (`engines`). Extracted verbatim from the former `config-schema.ts` monolith —
 * no behavior change.
 */
import { z } from "zod";
// Harness ids come straight from the dependency-free `harnesses/ids` leaf (the
// same source `config-types.ts` re-exports them from). Importing them here
// rather than via `../config-types` keeps `schema/*` free of any edge to
// `config-types`, which type-derives from this barrel via
// `typeof import("./config-schema")` — routing through config-types would mint
// a config-schema ↔ config-types type cycle that collapses inference.
import { HARNESS_AGENT_DISPATCH_IDS, VALID_HARNESS_IDS } from "../../../integrations/harnesses/ids";
import {
  chatCompletionsEndpoint,
  ENV_REFERENCE_PATTERN,
  ExtraParamsSchema,
  engineName,
  LlmCapabilitiesSchema,
  ModelAliasMapSchema,
  nonEmptyString,
  positiveInt,
} from "./primitives";

// ── Connection configs (LLM) ────────────────────────────────────────────────

/**
 * OpenAI-compatible connection fields shared by named LLM engines and bounded
 * internal call helpers. `model` is required at schema level — partial entries
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
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    concurrency: positiveInt.optional(),
    capabilities: LlmCapabilitiesSchema.optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
  })
  .passthrough();

export const LlmProfileConfigSchema = LlmConnectionConfigSchema.extend({
  supportsJsonSchema: z.boolean().optional(),
}).passthrough();

// ── Agent engines ───────────────────────────────────────────────────────────

// Derives from the canonical VALID_HARNESS_IDS (#565) so the Zod gate cannot
// drift from the TS union / parse check / setup detection.
const AgentPlatformSchema = z.enum(VALID_HARNESS_IDS);

const LlmEngineSchema = z
  .object({
    kind: z.literal("llm"),
    provider: z.string().optional(),
    endpoint: chatCompletionsEndpoint,
    model: nonEmptyString,
    apiKey: z.string().regex(ENV_REFERENCE_PATTERN, `apiKey must be $VAR or \${VAR}`).optional(),
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    concurrency: positiveInt.optional(),
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of ["platform", "bin", "args", "workspace", "modelAliases", "llmEngine"]) {
      if (key in value)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is not valid on an LLM engine` });
    }
  });

const AgentEngineSchema = z
  .object({
    kind: z.literal("agent"),
    platform: AgentPlatformSchema.refine((platform) => HARNESS_AGENT_DISPATCH_IDS.has(platform), {
      message: "platform does not support agent dispatch",
    }),
    bin: nonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    workspace: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    modelAliases: ModelAliasMapSchema.optional(),
    llmEngine: engineName.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of [
      "provider",
      "endpoint",
      "apiKey",
      "temperature",
      "maxTokens",
      "concurrency",
      "supportsJsonSchema",
      "extraParams",
      "contextLength",
      "enableThinking",
    ]) {
      if (key in value)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is not valid on an agent engine` });
    }
    if (value.platform !== "opencode-sdk" && value.llmEngine !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llmEngine"],
        message: "llmEngine is only valid on opencode-sdk",
      });
    }
    if (value.platform === "opencode-sdk" && value.args !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["args"], message: "args is not valid on opencode-sdk" });
    }
  });

export const EngineConfigSchema = z.union([LlmEngineSchema, AgentEngineSchema]);
export const EnginesSchema = z.record(engineName, EngineConfigSchema);
