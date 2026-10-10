// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow unit's `output:` schema reaches its transport as one instruction,
 * in the bytes the unit prompt has always carried: the unit prompt, then the
 * instruction. A direct-LLM unit's prompt carries the instruction; an agent or
 * SDK transport's request lowering appends it. Resumed runs depend on these
 * bytes not changing. A run executes its plan as `plan_json` stores it, as
 * canonical JSON, so the plan is round-tripped the same way here.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { getCommandBuilder } from "../../src/integrations/agent/builders";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import { buildUnitPrompt, computeStepWorkList } from "../../src/workflows/exec/step-work";
import { prepareWorkflowExecution } from "../../src/workflows/exec/unit-dispatch";
import { canonicalPlanJson } from "../../src/workflows/ir/plan-hash";
import type { FrozenWorkflowCommandTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { freezeWorkflow } from "../_helpers/workflow";

const SCHEMA = { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] };
/** The instruction's exact bytes. */
const instructionFor = (schema: unknown): string =>
  `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(schema)}`;
const RUN_ID = "55555555-5555-4555-8555-555555555555";

const ENGINES: Record<string, Record<string, unknown>> = {
  llm: { kind: "llm", endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "test-model" },
  ...Object.fromEntries(HARNESS_REGISTRY.map((entry) => [entry.id, { kind: "agent", platform: entry.id }])),
};

/**
 * Freeze a one-step workflow on `engine` and return the text its transport
 * receives, the unit prompt bytes with the instruction, and the instruction.
 */
function deliveredPrompt(engine: string): { delivered: string; expected: string; instruction: string } {
  const config = { configVersion: "0.9.0", engines: ENGINES } as unknown as AkmConfig;
  const markdown = [
    "---",
    "type: workflow",
    "steps:",
    "  - id: extract",
    "    unit:",
    `      engine: ${engine}`,
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
  if (built.runner.kind === "llm") return { delivered: built.messages?.at(-1)?.content ?? "", expected, instruction };
  if (built.runner.kind === "sdk") return { delivered: built.prompt, expected, instruction };
  const platform = built.runner.profile.platform ?? built.runner.profile.name;
  const argv = getCommandBuilder(platform).build(built.runner.profile, built.options.dispatch!).argv;
  return { delivered: argv.join("\n"), expected, instruction };
}

describe("a workflow unit's output schema reaches its transport once", () => {
  test.each(Object.keys(ENGINES))("%s", (engine) => {
    const { delivered, expected, instruction } = deliveredPrompt(engine);

    expect(delivered.split(instruction).length - 1).toBe(1);
    expect(delivered.split(expected).length - 1).toBe(1);
  });
});
