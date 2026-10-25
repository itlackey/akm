// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one corrective loop for a model call whose reply must have a shape:
 * dispatch, parse, and, when the parser refuses the reply, one more dispatch that
 * carries what was wrong. Whoever dispatches decides how the correction reaches
 * the model (appended to the prompt, or as the next turns of the conversation);
 * whoever parses decides what a good reply is.
 *
 * Only a refused reply is corrected. A dispatch that fails, in transport or by
 * timeout, ends the loop with that failure as the dispatch reported it: the
 * transports own their retries, and a command is never run twice to fix its
 * output (`attempts: 1`).
 */

import { parseEmbeddedJsonResponse } from "../core/parse";
import type { Parsed } from "../core/structured";
import type { AgentRunResult } from "../integrations/agent/spawn";

/** Why a model call has no reply, whichever transport made it. */
export interface StructuredFailure {
  reason: "timeout" | "aborted" | "error";
  error: string;
  /** The failed dispatch's own result (an agent's exit code and stderr, say), when it reached a transport. */
  result?: AgentRunResult;
}

/**
 * One dispatch's end: the reply text, or a failure. A model call fails as a
 * {@link StructuredFailure} (what `callStructured` returns); a caller whose
 * dispatch fails otherwise (a workflow unit has its own failure reasons) names
 * its own shape, and the loop passes it through.
 */
export type Dispatched<F extends object = StructuredFailure> = { ok: true; raw: string } | ({ ok: false } & F);

/** The parser's refusal of a reply, as the next dispatch receives it. */
export interface Correction {
  /** The instruction to give the model: what was wrong, and what to send instead. */
  readonly text: string;
  /** The reply that was refused. */
  readonly reply: string;
}

type Refusal = Extract<Parsed<unknown>, { ok: false }>;

export interface StructuredLoopOptions<T, F extends object = StructuredFailure> {
  /** One dispatch: the first gets no correction, a later one the refusal of the reply before it. */
  dispatch: (correction?: Correction) => Promise<Dispatched<F>>;
  parse: (raw: string) => Parsed<T>;
  /** Attempts in all (default 2: one corrective retry). */
  attempts?: number;
  /** The instruction given with a refusal (default {@link correctionText}). */
  correct?: (refusal: Refusal) => string;
}

export type StructuredLoopResult<T, F extends object = StructuredFailure> =
  | { ok: true; value: T; raw: string; attempts: number }
  | {
      ok: false;
      reason: "parse_error" | "validation_error";
      errors: string[];
      /** The last reply, which the parser refused. */
      raw: string;
      attempts: number;
    }
  | ({ ok: false; attempts: number } & F);

/** The reply was refused by the parser, as against the dispatch failing. */
export function isRefused<T, F extends object>(
  result: StructuredLoopResult<T, F>,
): result is Extract<StructuredLoopResult<T, F>, { errors: string[] }> {
  return !result.ok && "errors" in result;
}

/** The default instruction for a refused reply. */
export function correctionText(refusal: Refusal): string {
  if ((refusal.reason ?? "parse_error") === "parse_error") {
    return "Your previous response contained no parseable JSON. Respond with ONLY a JSON value that matches the requested schema — no prose, no code fences.";
  }
  return `Your previous JSON response failed validation:\n- ${refusal.errors.join("\n- ")}\nRespond again with ONLY a corrected JSON value.`;
}

export async function structuredLoop<T, F extends object = StructuredFailure>(
  options: StructuredLoopOptions<T, F>,
): Promise<StructuredLoopResult<T, F>> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const correct = options.correct ?? correctionText;
  let correction: Correction | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const dispatched = await options.dispatch(correction);
    if (!dispatched.ok) return { ...dispatched, attempts: attempt };
    const raw = dispatched.raw;
    const parsed = options.parse(raw);
    if (parsed.ok) return { ok: true, value: parsed.value, raw, attempts: attempt };
    if (attempt >= attempts) {
      return { ok: false, reason: parsed.reason ?? "parse_error", errors: parsed.errors, raw, attempts: attempt };
    }
    correction = { text: correct(parsed), reply: raw };
  }
}

/**
 * A parser for a reply that is JSON, perhaps in prose or code fences: the JSON
 * found in it, held to `validate`. A reply with no JSON in it is a `parse_error`;
 * JSON that fails `validate` is a `validation_error`.
 */
export function jsonParser<T>(validate: (candidate: unknown) => Parsed<T>): (raw: string) => Parsed<T> {
  return (raw) => {
    const candidate = parseEmbeddedJsonResponse(raw);
    if (candidate === undefined) {
      return { ok: false, errors: ["no JSON structure found in response"], reason: "parse_error" };
    }
    const verdict = validate(candidate);
    return verdict.ok ? verdict : { ...verdict, reason: verdict.reason ?? "validation_error" };
  };
}
