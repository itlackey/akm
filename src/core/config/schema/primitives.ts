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
import { redactUrlCredentials } from "../../redaction";
import { isSecretRefToken } from "../../ref-token";
import { warnOnce } from "../../warn";
import { ENGINE_NAME_PATTERN_SOURCE } from "../engine-semantics";

// Zod 4 reports a map key its key schema rejects as "Invalid key in record" and keeps that schema's own message
// (the naming rule, the slug rule) inside the issue; config errors and warnings print only the outer message.
z.config({
  customError: (issue) =>
    issue.code === "invalid_key" ? issue.issues.map((inner) => inner.message).join("; ") : undefined,
});

/** Persisted config schema version. Package prerelease/patch versions do not change this value. */
export const CURRENT_CONFIG_VERSION = "0.9.0" as const;

// ── Reusable atomic schemas ─────────────────────────────────────────────────

/** Positive integer (used for tokens, timeouts, batch sizes). */
export const positiveInt = z.number().int().positive();

/**
 * The catchall of an object whose extra keys are the endpoint's to define (a connection's request fields):
 * any key, contents left alone. The config walker knows it by identity: a `.passthrough()` object also has an
 * `unknown` catchall, and its extra keys are ones akm does not define.
 */
export const OpaqueFieldSchema = z.unknown();

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

/** The two symbolic credential forms akm accepts in a bundle source's `credential`: an env-var reference (`$VAR`, `${VAR}`) or a `secrets/` ref (`${secrets/name}`). Never matches a literal key. */
export function isApiKeyReference(value: string): boolean {
  return ENV_REFERENCE_PATTERN.test(value) || isSecretRefToken(value);
}

/** A `$VAR` / `${VAR}` reference to an environment variable. */
export function isEnvReference(value: string): boolean {
  return ENV_REFERENCE_PATTERN.test(value);
}

/** The variable a `$VAR` / `${VAR}` reference names. */
export function envReferenceName(value: string): string | undefined {
  return /^\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?$/.exec(value)?.[1];
}

/**
 * The `apiKey` of a connection, `embedding` or `search.curateRerank`: a `$VAR` /
 * `${VAR}` reference, or absent (the key is then `credentials.json`'s under the
 * block's name). Anything else is never read or sent: it is warned about once,
 * never a load error, and kept as written so an ordinary write does not delete
 * the user's key from their file (`akm migrate apply` moves it).
 */
export const envReferenceApiKey = z.string().transform((value) => {
  if (isEnvReference(value)) return value;
  if (isSecretRefToken(value)) {
    warnOnce(
      "config:secret-ref-api-key",
      "An apiKey that is a secret-store reference is ignored: akm reads a key from a $VAR or credentials.json. `akm migrate apply` moves it into credentials.json.",
    );
  } else {
    warnOnce(
      "config:literal-api-key",
      "A literal apiKey in config.json is ignored: akm does not read keys from config. Use a $VAR reference, or run `akm migrate apply` to move the key into credentials.json.",
    );
  }
  return value;
});

/**
 * The retired `apiKeyFile` of an engine that `akm migrate apply` could not read yet: kept as written so a
 * later run can move the key it names, never read, sent or printed by akm.
 */
export const retiredApiKeyFile = z.string().transform((value) => {
  warnOnce(
    "config:api-key-file",
    "An apiKeyFile in config.json is ignored: akm reads a key from a $VAR or credentials.json. `akm migrate apply` moves the key the file holds once it can be read.",
  );
  return value;
});

/** A connection endpoint: a complete http(s) URL, the OpenAI-compatible base (`…/v1`) or the chat-completions URL itself. */
export const connectionEndpoint = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must be a complete URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must use http:// or https://" });
    return;
  }
  if (url.username || url.password) {
    // The warning names the endpoint without the credential it is about, and is keyed by that too.
    const shown = redactUrlCredentials(value);
    warnOnce(
      `connectionEndpoint:userinfo:${shown}`,
      `Config endpoint "${shown}" embeds a username/password; move the credential out of the URL (apiKey: "$VAR", or credentials.json).`,
    );
  }
});

export const ExtraParamsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  for (const issue of validateExtraParams(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});

// ── Shared connection/invocation building blocks ────────────────────────────

export const LlmInvocationOverridesSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    extraParams: ExtraParamsSchema.optional(),
    enableThinking: z.boolean().optional(),
    reasoningEffort: nonEmptyString.optional(),
  })
  .passthrough();
