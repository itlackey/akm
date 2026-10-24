// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Code-review regression, round 2 (spec docs/plans/specs/p1b-model-extraction.md
 * §5.2 point 2). A prior code-review pass fixed a gap where `dispatchWorkflowExecution`
 * (src/workflows/exec/unit-dispatch.ts) never forwarded its resolved provenance
 * `eventSource` into `runExecution`'s options at all, so a
 * "command" (agent/sdk) frozen target's dispatched child never observed
 * `AKM_EVENT_SOURCE`. That fix forwarded the value UNCONDITIONALLY.
 *
 * `runExecution` applies a forwarded value as
 * `env: { ...execution.options.env, AKM_EVENT_SOURCE: eventSource }`
 * (src/integrations/agent/runner-dispatch.ts) — an unconditional
 * override of that one key. `lowered.options.env` IS the unit's own
 * authored/resolved `env:` binding (`UnitDispatchRequest.env`, folded in by
 * `prepareWorkflowExecution`), so the unconditional forward let the
 * provenance stamp win over an authored `env: { AKM_EVENT_SOURCE: ... }`
 * binding — inverting the precedence pre-P1b had (the child env was built
 * from ambient passthrough with the authored binding applied LAST, at
 * highest precedence) and disagreeing with the sibling "script"/"shell" arm:
 * `exec-unit.ts`'s own `childEnv` stamps its allowlisted base only when the
 * name is absent there, strictly BEFORE the bindings overlay runs, so an
 * authored binding always wins there.
 *
 * `dispatchWorkflowExecution` itself has no injectable
 * `runAgent`/`runSdk`/`chat` seam — a prior remediation recorded this
 * as the reason its real dispatch has no end-to-end test (P1b spec Review
 * log) — so this pins the fix at the exact point the decision is made: the
 * exported `forwardedDispatchEventSource` predicate that
 * `dispatchWorkflowExecution` calls before building
 * `runExecution`'s options.
 */

import { describe, expect, test } from "bun:test";
import { forwardedDispatchEventSource } from "../../src/workflows/exec/unit-dispatch";

describe("forwardedDispatchEventSource — agent/sdk arm eventSource precedence", () => {
  test("no resolved provenance event source (non-task caller) forwards nothing", () => {
    expect(forwardedDispatchEventSource({ eventSource: undefined, env: undefined })).toBeUndefined();
    expect(
      forwardedDispatchEventSource({ eventSource: undefined, env: { AKM_EVENT_SOURCE: "improve" } }),
    ).toBeUndefined();
  });

  test("resolved event source with no env at all forwards it", () => {
    expect(forwardedDispatchEventSource({ eventSource: "task", env: undefined })).toBe("task");
  });

  test("resolved event source with env present but no AKM_EVENT_SOURCE key forwards it", () => {
    expect(forwardedDispatchEventSource({ eventSource: "task", env: {} })).toBe("task");
    expect(forwardedDispatchEventSource({ eventSource: "task", env: { OTHER_VAR: "x" } })).toBe("task");
  });

  test("an authored env: AKM_EVENT_SOURCE binding wins — nothing is forwarded", () => {
    expect(forwardedDispatchEventSource({ eventSource: "task", env: { AKM_EVENT_SOURCE: "improve" } })).toBeUndefined();
  });

  test("gate is on presence, not value — an authored binding equal to the resolved value still forwards nothing", () => {
    // exec-unit.ts's childEnv only stamps its allowlisted base when the name is
    // absent there; the bindings overlay then applies unconditionally. Mirror
    // that here: an authored binding — of ANY value, including one that
    // happens to already equal the resolved provenance value — must still be
    // left for the merge in runner-dispatch.ts to leave alone, not
    // rewritten by this call as if nothing had been authored.
    expect(forwardedDispatchEventSource({ eventSource: "task", env: { AKM_EVENT_SOURCE: "task" } })).toBeUndefined();
  });

  test("scheduled and unscheduled runs agree — the gate depends only on the binding, not on eventSource's value", () => {
    for (const eventSource of ["task", "user", "improve", "audit"]) {
      expect(forwardedDispatchEventSource({ eventSource, env: { AKM_EVENT_SOURCE: "pinned" } })).toBeUndefined();
      expect(forwardedDispatchEventSource({ eventSource, env: { OTHER: "x" } })).toBe(eventSource);
    }
  });
});
