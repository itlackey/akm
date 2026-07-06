// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `runStructured<T>()` — transport-free structured-output core (P0.5 seam).
 *
 * akm has two structured-output paths that share no code: the LLM HTTP path
 * (`llm/structured-call.ts` + `responseSchema`) and the agent JSON path
 * (`agent/spawn.ts` `parseOutput: "json"` — embedded-JSON scan, no schema,
 * no retry). This module is the ONE validation-driven retry loop both are
 * meant to converge on: the workflow engine's schema units compose it with a
 * dispatch adapter per runner (llm = `chatCompletion` + `responseSchema`;
 * agent/sdk = `runAgent`/`runOpencodeSdk` + prompt-injected schema;
 * native-schema CLIs pass the schema through and still validate).
 *
 * Layering: this file lives in `core/` — NOT `llm/` — because the agent path
 * must be able to reach it and `agent/ ⇏ llm/` is an enforced invariant
 * (`tests/architecture/agent-no-llm-sdk-guard.test.ts`). The transport is
 * always injected; this module never performs IO of its own.
 *
 * Retry semantics: only parse/validation misses are retried (with corrective
 * feedback appended to the re-dispatch). Transport errors PROPAGATE — the
 * transports own their own retry discipline (`chatCompletion` has a bounded
 * jittered retry; `runAgent` has timeout/abort semantics).
 */

import { parseEmbeddedJsonResponse } from "./parse";

/** Outcome of one validation attempt. */
export type StructuredValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface RunStructuredOptions<T> {
  /**
   * Injected transport: perform one round-trip and return the raw text
   * response. On retries, `feedback` carries the corrective message built
   * from the previous attempt's parse/validation failure — the adapter
   * decides how to weave it into its prompt/messages.
   */
  dispatch: (feedback?: string) => Promise<string>;
  /**
   * Extract the candidate structure from the raw response. Returns
   * `undefined` when no structure was found. Defaults to
   * {@link parseEmbeddedJsonResponse} (strips think-blocks/code fences,
   * scans for embedded JSON).
   */
  parse?: (raw: string) => unknown;
  /** Validate the parsed candidate against the caller's schema/rules. */
  validate: (candidate: unknown) => StructuredValidation<T>;
  /** Total attempts including the first (default 2 — one corrective retry). */
  maxAttempts?: number;
  /** Override the default corrective-feedback message builder. */
  buildFeedback?: (failure: { reason: "parse_error" | "validation_error"; errors: string[]; raw: string }) => string;
}

export type RunStructuredResult<T> =
  | { ok: true; value: T; attempts: number }
  | {
      ok: false;
      reason: "parse_error" | "validation_error";
      /** Failure detail from the FINAL attempt. */
      errors: string[];
      attempts: number;
      /** Raw response of the final attempt, for diagnostics/unit rows. */
      raw: string;
    };

function defaultFeedback(failure: { reason: "parse_error" | "validation_error"; errors: string[] }): string {
  if (failure.reason === "parse_error") {
    return "Your previous response contained no parseable JSON. Respond with ONLY a JSON value that matches the requested schema — no prose, no code fences.";
  }
  return `Your previous JSON response failed validation:\n- ${failure.errors.join("\n- ")}\nRespond again with ONLY a corrected JSON value.`;
}

/**
 * Run the dispatch→parse→validate loop, re-dispatching with corrective
 * feedback on parse/validation misses, up to `maxAttempts` total attempts.
 * Never throws for structure problems (returns a typed failure); transport
 * throws propagate untouched.
 */
export async function runStructured<T>(options: RunStructuredOptions<T>): Promise<RunStructuredResult<T>> {
  const parse = options.parse ?? ((raw: string) => parseEmbeddedJsonResponse(raw));
  const buildFeedback = options.buildFeedback ?? defaultFeedback;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

  let feedback: string | undefined;
  let lastFailure: Extract<RunStructuredResult<T>, { ok: false }> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await options.dispatch(feedback);

    const candidate = parse(raw);
    if (candidate === undefined) {
      lastFailure = {
        ok: false,
        reason: "parse_error",
        errors: ["no JSON structure found in response"],
        attempts: attempt,
        raw,
      };
      feedback = buildFeedback({ reason: "parse_error", errors: lastFailure.errors, raw });
      continue;
    }

    const verdict = options.validate(candidate);
    if (verdict.ok) {
      return { ok: true, value: verdict.value, attempts: attempt };
    }
    lastFailure = { ok: false, reason: "validation_error", errors: verdict.errors, attempts: attempt, raw };
    feedback = buildFeedback({ reason: "validation_error", errors: verdict.errors, raw });
  }

  // maxAttempts >= 1 guarantees at least one loop iteration set lastFailure
  // (a success would have returned), so the non-null assertion is safe.
  return lastFailure as Extract<RunStructuredResult<T>, { ok: false }>;
}
