// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Summary-validation gate for workflow step/workflow completion (#506).
 *
 * Takes a step's `completionCriteria` and the summary of work the agent claims
 * to have done, asks the configured LLM to judge whether the summary
 * demonstrates each criterion is met, and returns either a pass or structured
 * corrective feedback steering the agent on what to finish/fix.
 *
 * The LLM call is injected (`judge`) so the gate is unit-testable without a
 * live endpoint, and the whole gate is fail-open: when no criteria exist or no
 * judge is available the step completes as before. See
 * docs/technical/workflow-agent-checkin-adr.md.
 *
 * @module workflows/validate-summary
 */

import validateSummaryJudgePrompt from "../assets/prompts/validate-summary-judge.md" with { type: "text" };
import { parseJsonResponse } from "../core/parse";

export interface ValidateSummaryInput {
  stepTitle: string;
  completionCriteria: string[];
  summary: string;
}

/**
 * Result of the validation gate. `complete: true` ⇒ mark the step complete.
 * `complete: false` ⇒ surface `feedback` + `missing[]` to the agent and leave
 * the step pending so it can finish the outstanding work.
 */
export interface ValidateSummaryResult {
  complete: boolean;
  /** Criteria the judge found unmet or unaddressed (empty when complete). */
  missing: string[];
  /** Corrective directive describing what to fix or finish. */
  feedback?: string;
  /** True when the gate was skipped (no criteria / no judge / judge error). */
  skipped?: boolean;
  /**
   * True when a REQUIRED gate could not obtain a well-formed verdict — the judge
   * threw / was unreachable, or returned an unparseable / malformed response
   * (Codex round-3 finding A). A non-required gate fails OPEN in the same cases
   * (`skipped: true`); a required gate MUST NOT, so this flags the caller to
   * BLOCK the step instead of silently passing an unjudged gate. Always paired
   * with `complete: false`.
   */
  errored?: boolean;
}

/** Feedback surfaced when a REQUIRED gate's judge could not be evaluated. */
const REQUIRED_GATE_JUDGE_UNAVAILABLE_FEEDBACK =
  "The required completion gate could not be judged — the LLM threw, was unreachable, or returned an " +
  "unparseable verdict. A required gate must be judged; refusing to pass it. Restore the judge and re-evaluate.";

/**
 * Judge function: given a fully-rendered prompt, return the raw model text.
 * Injected so the gate can be tested deterministically and so the engine can
 * degrade gracefully when no LLM is configured.
 */
export type SummaryJudge = (prompt: { system: string; user: string }) => Promise<string>;

const JUDGE_SYSTEM = validateSummaryJudgePrompt;

function buildUserPrompt(input: ValidateSummaryInput): string {
  const criteria = input.completionCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Step: ${input.stepTitle}`,
    "",
    "Completion criteria:",
    criteria,
    "",
    "Agent's summary of work done:",
    input.summary.trim(),
    "",
    "Return the JSON verdict now.",
  ].join("\n");
}

/**
 * Run the summary-validation gate.
 *
 * Fail-open contract (NON-required gates):
 *  - no criteria → `{ complete: true, skipped: true }`
 *  - no judge → `{ complete: true, skipped: true }`
 *  - judge throws / returns unparseable → `{ complete: true, skipped: true }`
 *
 * REQUIRED gates (`opts.required`) do NOT fail open on an un-evaluable judge
 * (Codex round-3 finding A): a judge that throws / is unreachable, or returns an
 * unparseable / malformed verdict, yields `{ complete: false, errored: true }`
 * so the caller BLOCKS the step rather than silently passing an unjudged gate.
 * (A required gate with NO judge at all is blocked upstream in
 * `finalizeExecutedStep` before this gate runs, so that branch stays fail-open.)
 *
 * Only a well-formed `complete: false` verdict blocks completion.
 */
export async function validateStepSummary(
  input: ValidateSummaryInput,
  judge: SummaryJudge | undefined,
  opts?: { required?: boolean },
): Promise<ValidateSummaryResult> {
  const required = opts?.required === true;
  const criteria = input.completionCriteria.filter((c) => c.trim().length > 0);
  if (criteria.length === 0) {
    return { complete: true, missing: [], skipped: true };
  }
  if (!judge) {
    return { complete: true, missing: [], skipped: true };
  }

  let raw: string;
  try {
    raw = await judge({ system: JUDGE_SYSTEM, user: buildUserPrompt({ ...input, completionCriteria: criteria }) });
  } catch {
    // LLM unreachable / errored. A REQUIRED gate must be judged — block rather
    // than pass an unjudged gate; a non-required gate fails open so offline use
    // keeps working.
    if (required) {
      return { complete: false, missing: [], errored: true, feedback: REQUIRED_GATE_JUDGE_UNAVAILABLE_FEEDBACK };
    }
    return { complete: true, missing: [], skipped: true };
  }

  const parsed = parseJsonResponse<{ complete?: unknown; missing?: unknown; feedback?: unknown }>(raw);
  if (!parsed || typeof parsed.complete !== "boolean") {
    // An unparseable / malformed verdict is a judge that did not actually judge:
    // a required gate blocks; a non-required gate fails open.
    if (required) {
      return { complete: false, missing: [], errored: true, feedback: REQUIRED_GATE_JUDGE_UNAVAILABLE_FEEDBACK };
    }
    return { complete: true, missing: [], skipped: true };
  }

  if (parsed.complete) {
    return { complete: true, missing: [] };
  }

  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : [];
  const feedback =
    typeof parsed.feedback === "string" && parsed.feedback.trim().length > 0
      ? parsed.feedback.trim()
      : "The summary does not yet demonstrate every completion criterion is met. " +
        "Finish the outstanding work and resubmit with a summary that addresses each criterion.";

  return { complete: false, missing, feedback };
}
