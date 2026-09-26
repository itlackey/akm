// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one redaction contract every frozen-workflow dispatch (unit or gate
 * judge) is held to before anything about its outcome reaches durable state.
 * A leaf module, so the judge path reuses it without an import cycle.
 */

import {
  collectSensitiveValues,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../core/redaction";
import { lookupApiKeyFileValue, lookupApiKeySecretRefValue } from "../../integrations/agent/engine-resolution";
import type { RunnerSpec } from "../../integrations/agent/runner";
import type { UnitDispatcher } from "./unit-dispatch";

/** The engine pair a dispatch may draw credentials from. `StepWorkUnit` satisfies it structurally. */
export interface DispatchSecretSources {
  runner?: RunnerSpec;
  /** Values sampled by the frozen-environment materializer. */
  sensitiveValues?: readonly string[];
}

/**
 * Every exact value that must never reach the journal from one dispatch: the
 * resolved `env` bindings, the engine's (and SDK fallback's) credential from
 * env, file, or secret store, and unsafe passthrough values. Read at call time,
 * so collect no earlier than the dispatch being scrubbed.
 */
export function collectWorkflowDispatchSensitiveValues(
  dispatch: DispatchSecretSources,
  env: Record<string, string> | undefined,
): string[] {
  const values = new Set<string>([...Object.values(env ?? {}), ...(dispatch.sensitiveValues ?? [])]);
  const addCredential = (runner: RunnerSpec | undefined): void => {
    if (!runner) return;
    if (runner.kind === "llm") {
      for (const name of runner.credential?.names ?? []) {
        const value = process.env[name]?.trim();
        if (value) values.add(value);
      }
      // #905: file-backed credential — best-effort read, never throws, so a
      // broken apiKeyFile is reported by the real dispatch, not this collector.
      if (runner.apiKeyFile) {
        const value = lookupApiKeyFileValue(runner.apiKeyFile);
        if (value) values.add(value);
      }
      // #953: secret-store-backed credential — same best-effort rationale.
      if (runner.apiKeySecretRef) {
        const value = lookupApiKeySecretRefValue(runner.apiKeySecretRef);
        if (value) values.add(value);
      }
      return;
    }
    for (const name of runner.profile.envPassthrough ?? []) {
      const value = process.env[name];
      if (!isEnvPassthroughValueSafeToExpose(name, value) && value) values.add(value);
    }
    if (runner.kind === "sdk") {
      for (const name of runner.fallbackCredential?.names ?? []) {
        const value = process.env[name]?.trim();
        if (value) values.add(value);
      }
      if (runner.fallbackApiKeyFile) {
        const value = lookupApiKeyFileValue(runner.fallbackApiKeyFile);
        if (value) values.add(value);
      }
      if (runner.fallbackApiKeySecretRef) {
        const value = lookupApiKeySecretRefValue(runner.fallbackApiKeySecretRef);
        if (value) values.add(value);
      }
    }
  };
  addCredential(dispatch.runner);
  return collectSensitiveValues(values);
}

/**
 * Scrub a dispatch outcome before anything about it is journaled. A
 * `failureReason` the scrub altered carried a secret, so it is downgraded.
 */
export function redactUnitOutcome<T extends { failureReason?: string }>(
  outcome: T,
  sensitiveValues: readonly string[],
): T {
  const redacted = redactSensitiveValue(outcome, sensitiveValues);
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
