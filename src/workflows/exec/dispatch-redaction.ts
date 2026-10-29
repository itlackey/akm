// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a frozen-workflow unit's outcome is scrubbed of before it reaches
 * durable state: the secrets its environment bindings substituted, on top of
 * what the dispatch itself already redacted (the runner's connection key), and
 * the credential-named variables of the environment every unit's process inherits.
 */

import { collectInferredSecretValues, collectSensitiveValues, redactSensitiveValue } from "../../core/redaction";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { collectDispatchSensitiveValues } from "../../integrations/agent/runner-dispatch";

/** What a dispatch may draw credentials from. `StepWorkUnit` satisfies it structurally. */
export interface DispatchSecretSources {
  runner?: RunnerSpec;
  /** Secret values substituted by the frozen-environment materializer. */
  sensitiveValues?: readonly string[];
}

/**
 * Every exact value that must never reach the journal from one dispatch: the
 * secrets substituted into the unit's env bindings (`dispatch.sensitiveValues`;
 * the rest of an env asset is configuration and reaches the journal as is), the
 * runner's connection key, and the credential-named variables of akm's
 * environment, which a shell command inherits as a runner does. Read at call
 * time, so collect no earlier than the dispatch being scrubbed.
 */
export function collectWorkflowDispatchSensitiveValues(dispatch: DispatchSecretSources): string[] {
  const values = new Set<string>(dispatch.sensitiveValues ?? []);
  const dispatchValues = dispatch.runner
    ? collectDispatchSensitiveValues(dispatch.runner)
    : collectInferredSecretValues(process.env);
  for (const value of dispatchValues) values.add(value);
  return collectSensitiveValues(values);
}

/**
 * Turn a number leaf that is exactly a sensitive value into its text, so the string scrub redacts it (a
 * numeric secret echoed as a JSON number). Only the unit's parsed `result` takes this path: a number
 * elsewhere in an outcome (`tokens`) stays a number.
 */
function stringifySensitiveNumbers(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === "number") return sensitiveValues.includes(String(value)) ? String(value) : value;
  if (Array.isArray(value)) return value.map((entry) => stringifySensitiveNumbers(entry, sensitiveValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, stringifySensitiveNumbers(child, sensitiveValues)]),
    );
  }
  return value;
}

/**
 * Scrub a dispatch outcome before anything about it is journaled. A
 * `failureReason` the scrub altered carried a secret, so it is downgraded.
 */
export function redactUnitOutcome<T extends { failureReason?: string }>(
  outcome: T,
  sensitiveValues: readonly string[],
): T {
  const prepared =
    "result" in outcome ? { ...outcome, result: stringifySensitiveNumbers(outcome.result, sensitiveValues) } : outcome;
  const redacted = redactSensitiveValue(prepared, sensitiveValues);
  if (outcome.failureReason !== undefined && redacted.failureReason !== outcome.failureReason) {
    redacted.failureReason = "reported_failure";
  }
  return redacted;
}
