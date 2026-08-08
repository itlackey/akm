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
 * The judge call is injected so the gate is unit-testable without a live
 * endpoint. A declared gate is fail-closed: only a well-formed affirmative
 * verdict advances the step.
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
  /** True when the gate was skipped because no criteria were declared. */
  skipped?: boolean;
}

/**
 * Judge function: given a fully-rendered prompt, return the raw model text.
 * Injected so the gate can be tested deterministically.
 */
export type SummaryJudge = (prompt: { system: string; user: string }) => Promise<string>;

/** The verdict shape a well-formed judge response must parse to. */
export interface JudgeVerdict {
  complete: boolean;
  missing?: unknown;
  feedback?: unknown;
}

/**
 * Parse the judge's raw response into a well-formed verdict, or `undefined`
 * when the response is malformed (unparseable, or missing a boolean
 * `complete`). This is the ONE verdict parser: {@link validateStepSummary}
 * fails closed through it, and the engine's gate wrapper (step-work.ts) uses
 * the same function to classify a malformed verdict as verifier
 * INFRASTRUCTURE failure — never an honest rejection that would consume a
 * gate loop — so the two classifications cannot drift.
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict | undefined {
  const parsed = parseJsonResponse<{ complete?: unknown; missing?: unknown; feedback?: unknown }>(raw);
  if (!parsed || typeof parsed.complete !== "boolean") return undefined;
  return parsed as JudgeVerdict;
}

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
 * No criteria skips verification. A missing, failing, or malformed judge is a
 * rejection: declared criteria are never silently bypassed.
 */
export async function validateStepSummary(
  input: ValidateSummaryInput,
  judge: SummaryJudge | undefined,
  signal?: AbortSignal,
): Promise<ValidateSummaryResult> {
  const criteria = input.completionCriteria.filter((c) => c.trim().length > 0);
  if (criteria.length === 0) {
    return { complete: true, missing: [], skipped: true };
  }
  if (!judge) {
    return {
      complete: false,
      missing: criteria,
      feedback: "This step declares completion criteria but no verification judge is available.",
    };
  }

  let raw: string;
  try {
    if (signal?.aborted) throw interruptionReason(signal);
    raw = await judge({ system: JUDGE_SYSTEM, user: buildUserPrompt({ ...input, completionCriteria: criteria }) });
    if (signal?.aborted) throw interruptionReason(signal);
  } catch {
    if (signal?.aborted) throw interruptionReason(signal);
    return {
      complete: false,
      missing: criteria,
      feedback: "The verification judge failed. Retry after fixing the verifier configuration or service.",
    };
  }

  const parsed = parseJudgeVerdict(raw);
  if (!parsed) {
    return {
      complete: false,
      missing: criteria,
      feedback: "The verification judge returned a malformed verdict instead of the required JSON result.",
    };
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

function interruptionReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Workflow verification interrupted.");
}
