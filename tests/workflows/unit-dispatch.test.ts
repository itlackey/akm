// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import type { ConnectionRunner, HarnessRunner } from "../../src/integrations/agent/runner";
import { collectWorkflowDispatchSensitiveValues, redactUnitOutcome } from "../../src/workflows/exec/dispatch-redaction";
import type { UnitOutcome } from "../../src/workflows/exec/step-work";
import { forwardedDispatchEventSource } from "../../src/workflows/exec/unit-dispatch";
import { withEnv } from "../_helpers/sandbox";
import { freezeWorkflow } from "../_helpers/workflow";

describe("redactUnitOutcome number leaves", () => {
  test("redacts a numeric secret in the parsed result and no other number", () => {
    const outcome = redactUnitOutcome<UnitOutcome>(
      { unitId: "u", ok: true, result: { n: 4242, other: 42, nested: [4242] } },
      ["4242"],
    );
    expect(outcome.result).toEqual({ n: "[REDACTED]", other: 42, nested: ["[REDACTED]"] });
  });

  test("keeps tokens a number when a sensitive value equals it", () => {
    const outcome = redactUnitOutcome<UnitOutcome>({ unitId: "u", ok: true, tokens: 1200, result: { n: 1200 } }, [
      "1200",
    ]);
    expect(outcome.tokens).toBe(1200);
    expect(outcome.result).toEqual({ n: "[REDACTED]" });
  });
});

describe("collectWorkflowDispatchSensitiveValues", () => {
  const harness: HarnessRunner = {
    kind: "harness",
    name: "claude",
    platform: "claude",
    bin: "claude",
    args: [],
    timeoutMs: null,
  };
  const connection: ConnectionRunner = {
    kind: "connection",
    name: "lab",
    endpoint: "http://127.0.0.1:1/v1",
    model: "m",
    request: {},
    apiKey: "$DISPATCH_REDACTION_KEY",
    timeoutMs: null,
  };

  test("a connection's key is read from this process's environment, and a credential-named variable the child inherits counts for every unit, a shell command's included", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "the-users-own-key", DISPATCH_REDACTION_KEY: "connection-secret" }, () => {
      expect(collectWorkflowDispatchSensitiveValues({ runner: connection })).toContain("connection-secret");
      expect(collectWorkflowDispatchSensitiveValues({ runner: harness })).toContain("the-users-own-key");
      expect(collectWorkflowDispatchSensitiveValues({})).toContain("the-users-own-key");
    });
  });

  test("the values the unit's environment bindings substituted are included", () => {
    expect(collectWorkflowDispatchSensitiveValues({ sensitiveValues: ["bound-secret"] })).toContain("bound-secret");
  });
});

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

/**
 * A workflow's `llm:` settings freeze into the request of every unit, whatever
 * its target kind. `reasoning_effort` is the workflow's spelling of
 * `reasoningEffort`.
 */

const CONFIG = {
  semanticSearchMode: "off",
  harnesses: { oc: { platform: "opencode", args: ["run", "--model", "krang/chat/qwen3.8-27b"] } },
} as const satisfies AkmConfig;

const WORKFLOW = [
  "---",
  "type: workflow",
  "defaults:",
  "  harness: oc",
  "  llm:",
  "    temperature: 0.2",
  "    reasoning_effort: low",
  "steps:",
  "  - id: review",
  "---",
  "",
  "## review",
  "",
  "Review it.",
].join("\n");

test("a unit's llm: settings freeze into its request", () => {
  const root = freezeWorkflow(WORKFLOW, "workflows/demo.md", CONFIG).steps[0]?.root;
  if (root?.kind !== "unit" || root.frozenTarget.kind !== "command") throw new Error("expected a frozen command unit");

  expect(root.frozenTarget.request.inference).toEqual({ temperature: 0.2, reasoningEffort: "low" });
});

test("a retired supports_json_schema is warned about once and ignored", () => {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    const retired = WORKFLOW.replace(
      "    reasoning_effort: low",
      "    reasoning_effort: low\n    supports_json_schema: false",
    );
    const root = freezeWorkflow(retired, "workflows/demo.md", CONFIG).steps[0]?.root;
    if (root?.kind !== "unit" || root.frozenTarget.kind !== "command")
      throw new Error("expected a frozen command unit");

    expect(root.frozenTarget.request.inference).toEqual({ temperature: 0.2, reasoningEffort: "low" });
    expect(warnings.filter((warning) => warning.includes("supports_json_schema"))).toHaveLength(1);
  } finally {
    _setWarnSinkForTests(undefined);
  }
});
