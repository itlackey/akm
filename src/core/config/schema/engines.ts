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
import { WORKFLOW_MAX_TIMEOUT_MS } from "../../../workflows/resource-limits";
import {
  chatCompletionsEndpoint,
  ExtraParamsSchema,
  engineName,
  nonEmptyString,
  positiveInt,
  symbolicOrWarnApiKey,
} from "./primitives";

/**
 * Engine-config timeouts share the workflow ceiling.
 *
 * 0.9.1 bounded workflow-authored timeouts (parser) and frozen invocations
 * (decoder) at 2^31-1, but the third source — `engines.<name>.timeoutMs` — was
 * validated only as a positive integer. A larger value passed config validation
 * and then failed EVERY run of that engine with an unlocated "Invalid frozen
 * workflow plan: invocation is invalid". Reject it where the value is written.
 */
const timeoutMsField = z.union([positiveInt.max(WORKFLOW_MAX_TIMEOUT_MS), z.null()]).optional();

// ── Connection configs (LLM) ────────────────────────────────────────────────

/**
 * OpenAI-compatible connection fields shared by named LLM engines and bounded
 * internal call helpers. `model` is required at schema level: current loads and
 * CLI writes reject a partial named engine rather than normalizing it through a
 * pre-schema compatibility transform.
 */
export const LlmConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string(),
    model: z.string(),
    apiKey: z.string().optional(),
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    timeoutMs: timeoutMsField,
    concurrency: positiveInt.optional(),
    // User-settable override, not a cached probe verdict: attempt-then-
    // fallback in llm/client.ts tries `response_format: json_schema` whenever
    // a schema is supplied, degrading to plain text on an unsupported-4xx and
    // remembering that in-memory for the rest of the process. `false` here
    // opts a known-incompatible endpoint out of even the first attempt;
    // `true` is advisory only.
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
    reasoningEffort: nonEmptyString.optional(),
  })
  .passthrough();

export const LlmProfileConfigSchema = LlmConnectionConfigSchema.passthrough();

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
    apiKey: symbolicOrWarnApiKey("engines.<name>.apiKey").optional(),
    // #905: file-backed alternative to `apiKey` for hosts that refuse
    // secrets in the process environment. A plain filesystem path (`~`
    // expanded, read at dispatch) — see resolveLlmEngineUse/
    // materializeLlmConnectionWithCredential in integrations/agent/engine-resolution.ts.
    apiKeyFile: nonEmptyString.optional(),
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    timeoutMs: timeoutMsField,
    concurrency: positiveInt.optional(),
    // Same user-settable override LlmConnectionConfigSchema declares above; a
    // named `kind: "llm"` engine is validated by THIS object, so without the
    // field here the unknown-key walk reported a live setting as unknown and
    // `akm migrate apply` dropped it from config.json.
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
    reasoningEffort: nonEmptyString.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of ["platform", "bin", "args", "workspace", "modelAliases", "llmEngine"]) {
      if (key in value)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is not valid on an LLM engine` });
    }
    // #905: apiKey and apiKeyFile are two alternative ways to supply the same
    // credential; a third (the implicit AKM_ENGINE_<NAME>_API_KEY env var) is
    // still available when neither is set, so only the both-set case is
    // rejected here.
    if (value.apiKey !== undefined && value.apiKeyFile !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyFile"],
        message: "apiKey and apiKeyFile cannot both be set",
      });
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
    timeoutMs: timeoutMsField,
    llmEngine: engineName.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of [
      "provider",
      "endpoint",
      "apiKey",
      "apiKeyFile",
      "temperature",
      "maxTokens",
      "concurrency",
      "extraParams",
      "contextLength",
      "enableThinking",
      "reasoningEffort",
      "modelAliases",
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
