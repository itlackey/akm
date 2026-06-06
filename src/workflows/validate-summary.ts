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
}

/**
 * Judge function: given a fully-rendered prompt, return the raw model text.
 * Injected so the gate can be tested deterministically and so the engine can
 * degrade gracefully when no LLM is configured.
 */
export type SummaryJudge = (prompt: { system: string; user: string }) => Promise<string>;

const JUDGE_SYSTEM =
  "You are a strict completion auditor for a software workflow engine. " +
  "Given a step's completion criteria and a summary of the work an agent claims to have done, " +
  "judge whether the summary provides concrete evidence that EVERY criterion is satisfied. " +
  "Be skeptical: vague, hand-wavy, or unsubstantiated claims do NOT satisfy a criterion. " +
  'Respond with ONLY a JSON object: {"complete": boolean, "missing": string[], "feedback": string}. ' +
  '"missing" lists the exact criteria that are not yet satisfied; "feedback" is a short directive ' +
  "telling the agent what to finish or fix. No prose, no markdown fences.";

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
 * Fail-open contract:
 *  - no criteria → `{ complete: true, skipped: true }`
 *  - no judge → `{ complete: true, skipped: true }`
 *  - judge throws / returns unparseable → `{ complete: true, skipped: true }`
 *
 * Only a well-formed `complete: false` verdict blocks completion.
 */
export async function validateStepSummary(
  input: ValidateSummaryInput,
  judge: SummaryJudge | undefined,
): Promise<ValidateSummaryResult> {
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
    // LLM unreachable / errored — fail open so offline use keeps working.
    return { complete: true, missing: [], skipped: true };
  }

  const parsed = parseJsonResponse<{ complete?: unknown; missing?: unknown; feedback?: unknown }>(raw);
  if (!parsed || typeof parsed.complete !== "boolean") {
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
