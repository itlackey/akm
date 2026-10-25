// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow unit's `output:` schema reaches its transport as one instruction,
 * in the bytes the unit prompt has always carried: the unit prompt, then the
 * instruction. A harness's or akm's own runtime's request lowering appends it. Resumed runs depend on these
 * bytes not changing. A run executes its plan as `plan_json` stores it, as
 * canonical JSON, so the plan is round-tripped the same way here.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { getHarness, HARNESS_CONFIG_PLATFORMS } from "../../src/integrations/harnesses";
import { buildUnitPrompt, computeStepWorkList } from "../../src/workflows/exec/step-work";
import { prepareWorkflowExecution } from "../../src/workflows/exec/unit-dispatch";
import { canonicalPlanJson } from "../../src/workflows/ir/plan-hash";
import type { FrozenWorkflowCommandTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";
import { freezeWorkflow } from "../_helpers/workflow";

const SCHEMA = { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] };
/** The instruction's exact bytes. */
const instructionFor = (schema: unknown): string =>
  `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(schema)}`;
const RUN_ID = "55555555-5555-4555-8555-555555555555";

/** The targets a unit may run on: a connection (akm's own runtime over it) and every harness platform. */
const TARGETS: Record<string, { key: "connection" | "harness"; config: Record<string, unknown> }> = {
  connection: {
    key: "connection",
    config: { connections: { connection: { endpoint: "http://127.0.0.1:1/v1", models: { fast: "test-model" } } } },
  },
  ...Object.fromEntries(
    HARNESS_CONFIG_PLATFORMS.map((id) => [id, { key: "harness" as const, config: { harnesses: { [id]: {} } } }]),
  ),
};

/**
 * Freeze a one-step workflow on the target `name` and return the text its transport
 * receives, the unit prompt bytes with the instruction, and the instruction.
 */
function deliveredPrompt(name: string): { delivered: string; expected: string; instruction: string } {
  const { key, config: targetConfig } = TARGETS[name]!;
  const config = { configVersion: "0.9.0", ...targetConfig } as unknown as AkmConfig;
  const markdown = [
    "---",
    "type: workflow",
    "steps:",
    "  - id: extract",
    "    unit:",
    `      ${key}: ${name}`,
    `      output: ${JSON.stringify(SCHEMA)}`,
    "---",
    "",
    "## extract",
    "",
    "Extract facts.",
    "",
  ].join("\n");
  const frozen = freezeWorkflow(markdown, "workflows/demo.md", config);
  const step = decodeWorkflowPlan(JSON.parse(canonicalPlanJson(frozen))).steps[0]!;
  const list = computeStepWorkList(step, { runId: RUN_ID, params: {}, stepOutputs: {} });
  if (!list.ok) throw new Error(list.error);
  const unit = list.list.units[0]!;
  const target = unit.frozenTarget as FrozenWorkflowCommandTarget;
  const built = prepareWorkflowExecution({
    runId: RUN_ID,
    stepId: step.stepId,
    unitId: unit.unitId,
    nodeId: unit.nodeId,
    prompt: unit.prompt,
    frozenTarget: target,
    timeoutMs: unit.timeoutMs,
  });
  const schema = list.list.template.schema!;
  const expected = buildUnitPrompt({
    runId: RUN_ID,
    stepId: step.stepId,
    unitId: unit.unitId,
    params: {},
    schema,
    instructions: list.list.template.instructions,
  });
  const instruction = instructionFor(schema);
  if (built.runner.kind === "connection") return { delivered: built.prompt, expected, instruction };
  // A harness that reads its prompt on stdin (OpenCode 1) gets it there instead of in argv.
  const command = getHarness(built.runner.platform)!.build(built.profile!, built.options.dispatch!);
  return { delivered: [...command.argv, command.stdin ?? ""].join("\n"), expected, instruction };
}

describe("a workflow unit's output schema reaches its transport once", () => {
  // The OpenCode 1 builder reads the binary's version; a fake keeps the PATH out of it.
  beforeEach(() => fakeOpencodeMajor(1));

  test.each(Object.keys(TARGETS))("%s", (target) => {
    const { delivered, expected, instruction } = deliveredPrompt(target);

    expect(delivered.split(instruction).length - 1).toBe(1);
    expect(delivered.split(expected).length - 1).toBe(1);
  });
});
