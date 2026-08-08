// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE redaction contract every frozen-workflow dispatch is held to before
 * anything about its outcome reaches durable state.
 *
 * This is a LEAF module on purpose. Both dispatch paths need it — the unit path
 * (`exec/native-executor.ts`) and the gate-judge path (`exec/frozen-judge.ts`) —
 * and the judge path is reached from `runtime/runs.ts`, which the executor's own
 * dependency chain runs back into. Keeping the helpers here (importing only
 * `core/redaction` plus erased types) means the judge can reuse the exact unit
 * scrub without opening a runtime import cycle.
 *
 * @module workflows/exec/dispatch-redaction
 */

import { collectSensitiveValues, isEnvPassthroughValueSafeToExpose, redactSensitiveValue } from "../../core/redaction";
import type { FrozenEngineSnapshot } from "../ir/schema";

/** The engine pair a dispatch may draw credentials from. `StepWorkUnit` satisfies it structurally. */
export interface DispatchEngines {
  engine?: FrozenEngineSnapshot;
  fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
}

/**
 * Every exact value that must never survive into the journal from ONE frozen
 * dispatch: the resolved `env` bindings injected into the child, the selected
 * engine's (and its SDK fallback's) credential env values, and any
 * `envPassthrough` value the redaction policy does not consider safe to expose.
 *
 * Shared by the unit path and the gate-judge path. There is deliberately ONE
 * collector: a second, parallel implementation is exactly how a dispatch path
 * silently loses the scrub.
 */
export function collectWorkflowDispatchSensitiveValues(
  dispatch: DispatchEngines,
  env: Record<string, string> | undefined,
): string[] {
  const values = new Set<string>(Object.values(env ?? {}));
  const addCredential = (engine: FrozenEngineSnapshot | undefined): void => {
    if (!engine) return;
    if (engine.kind === "llm") {
      for (const name of engine.credential?.names ?? []) {
        const value = process.env[name]?.trim();
        if (value) values.add(value);
      }
      return;
    }
    for (const name of engine.envPassthrough) {
      const value = process.env[name];
      if (!isEnvPassthroughValueSafeToExpose(name, value) && value) values.add(value);
    }
  };
  addCredential(dispatch.engine);
  addCredential(dispatch.fallbackEngine);
  return collectSensitiveValues(values);
}

/**
 * Scrub a dispatch outcome before ANYTHING about it is journaled.
 *
 * The `failureReason` downgrade is part of the contract: if redaction ALTERED
 * the reason, the reason itself carried a secret, and the persisted failure
 * vocabulary must not become a side channel for it.
 *
 * Structurally typed over `{ failureReason? }` rather than importing
 * `UnitOutcome` from `step-work.ts`: this module must stay a LEAF, and even an
 * erased `import type` edge here would put `frozen-judge → step-work →
 * runtime/runs → frozen-judge` back on the static import graph (the
 * import-cycle ratchet is shrink-only). Callers keep their exact outcome type
 * through the generic.
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
