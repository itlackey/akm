// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one redaction contract every frozen-workflow dispatch (unit or gate
 * judge) is held to before anything about its outcome reaches durable state.
 * A leaf module, so the judge path reuses it without an import cycle.
 */

import { collectSensitiveValues, redactSensitiveText, redactSensitiveValue } from "../../core/redaction";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { collectDispatchSensitiveValues } from "../../integrations/agent/runner-dispatch";
import type { UnitDispatcher } from "./unit-dispatch";

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
 * runner's credential and unsafe passthrough values. Read at call time, so
 * collect no earlier than the dispatch being scrubbed.
 */
export function collectWorkflowDispatchSensitiveValues(dispatch: DispatchSecretSources): string[] {
  const values = new Set<string>(dispatch.sensitiveValues ?? []);
  for (const value of dispatch.runner ? collectDispatchSensitiveValues(dispatch.runner) : []) values.add(value);
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

/** Scrub a value thrown out of a dispatch; re-wrapped only when the scrub changed its message. */
function redactDispatchError(err: unknown, sensitiveValues: readonly string[]): unknown {
  if (sensitiveValues.length === 0 || !(err instanceof Error)) return err;
  const redacted = redactSensitiveText(err.message, sensitiveValues);
  if (redacted === err.message) return err;
  const replacement = new Error(redacted);
  replacement.name = err.name;
  return replacement;
}

/**
 * Wrap a dispatcher so both its outcome and its thrown error are scrubbed with
 * the request's `sensitiveValues` (the gate judge; the unit path scrubs at its
 * own journal boundary after the structured-output parse).
 */
export function withDispatchRedaction(inner: UnitDispatcher): UnitDispatcher {
  return async (request, feedback) => {
    const sensitiveValues = request.sensitiveValues ?? [];
    try {
      return redactUnitOutcome(await inner(request, feedback), sensitiveValues);
    } catch (err) {
      throw redactDispatchError(err, sensitiveValues);
    }
  };
}
