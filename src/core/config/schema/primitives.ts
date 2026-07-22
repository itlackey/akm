// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared atomic Zod schemas and small helpers used across the config-schema
 * modules. Extracted verbatim from the former `config-schema.ts` monolith — no
 * behavior change (see `./index` re-export barrel at `../config-schema.ts`).
 */
import { z } from "zod";
import { validateExtraParams } from "../../extra-params";
import { ENGINE_NAME_PATTERN_SOURCE } from "../engine-semantics";

/** Persisted config schema version. Package prerelease/patch versions do not change this value. */
export const CURRENT_CONFIG_VERSION = "0.9.0" as const;

// ── Reusable atomic schemas ─────────────────────────────────────────────────

/** Positive integer (used for tokens, timeouts, batch sizes). */
export const positiveInt = z.number().int().positive();

/** Non-negative finite number (used for scores, weights, days). */
export const nonNegativeNumber = z.number().finite().min(0);

/** Non-empty string (rejects "" and whitespace-only). */
export const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, { message: "expected a non-empty string" });

/** HTTP(S) URL string. */
export const httpUrl = z.string().refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
  message: "endpoint must start with http:// or https://",
});

const ENGINE_NAME_PATTERN = new RegExp(ENGINE_NAME_PATTERN_SOURCE);
export const ENV_REFERENCE_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export const engineName = z
  .string()
  .max(63)
  .regex(ENGINE_NAME_PATTERN, "names must be lowercase kebab-case and must not begin with reserved akm-");

export const chatCompletionsEndpoint = z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must use http:// or https://" });
    }
    if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/chat/completions")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endpoint must be a credential-free OpenAI chat-completions URL without query or fragment",
      });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must be a complete URL" });
  }
});

export const ExtraParamsSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  for (const issue of validateExtraParams(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});

function normalizeAliasKeys(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const normalized: Record<string, unknown> = {};
  const originalByKey = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    const previous = originalByKey.get(lower);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `alias collides case-insensitively with ${previous}`,
      });
      continue;
    }
    originalByKey.set(lower, key);
    normalized[lower] = value;
  }
  return normalized;
}

export const ModelAliasMapSchema = z.preprocess(
  (raw, ctx) => normalizeAliasKeys(raw, ctx),
  z.record(z.string().min(1), z.string().min(1)),
);

export const GlobalModelAliasesSchema = z.preprocess(
  (raw, ctx) => normalizeAliasKeys(raw, ctx),
  z.record(z.string().min(1), z.record(z.string().min(1), z.string().min(1))),
);

// ── Shared connection/invocation building blocks ────────────────────────────

export const LlmCapabilitiesSchema = z
  .object({
    structuredOutput: z.boolean().optional(),
  })
  .passthrough();

export const LlmInvocationOverridesSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
  })
  .passthrough();
