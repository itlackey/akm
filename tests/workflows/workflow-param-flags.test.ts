// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { parseWorkflowParameterFlags } from "../../src/commands/workflow-cli";
import { materializeWorkflowParameterFlags } from "../../src/workflows/ir/params";
import type { WorkflowPlan as WorkflowPlanGraph } from "../../src/workflows/plan";

// F-A11 (docs/plans/specs/p3a-plan-v5-child-freeze.md §6): mechanical value
// bump only, no assertion in this file changes. `parameterPlan()` is
// explicitly typed as WorkflowPlan, so — unlike the two `unknown`-fed
// fixture builders F-A9/F-A10 flip — the literal itself is type-checked
// against `irVersion`'s still-literal-4 field type today, hence the pin
// below. materializeWorkflowParameterFlags/contractFromPlan
// (src/workflows/ir/params.ts:50-57) read only `params`/`paramSchemas` and
// never inspect `irVersion` at runtime, so this flip has zero behavioral
// effect — it exists solely so Implement's type narrowing to literal 5 does
// not turn this pre-existing, not-in-§6-at-the-time file into an unauthorized
// edit for the Implement lane to make.
function parameterPlan(): WorkflowPlanGraph {
  return {
    irVersion: 5,
    title: "parameters",
    params: ["include_processes", "count", "name", "tags", "metadata", "mode"],
    paramSchemas: {
      include_processes: { type: "boolean" },
      count: { type: "integer", minimum: 1 },
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
      mode: { type: "string", enum: ["quick", "full"] },
    },
    execution: { maxConcurrency: 1 },
    steps: [],
  };
}

describe("workflow parameter flags", () => {
  test("parses run controls separately and materializes schema-driven values", () => {
    const flags = parseWorkflowParameterFlags(
      [
        "workflows/health",
        "--include_processes=true",
        "--count",
        "3",
        "--name=001",
        "--tags",
        "api",
        "--tags=worker",
        '--metadata={"owner":"ops"}',
        "--mode",
        "quick",
        "--max-steps",
        "1",
        "--max-retries=2",
        "--timeout",
        "5m",
        "--format=json",
      ],
      "workflows/health",
    );

    expect(materializeWorkflowParameterFlags(parameterPlan(), flags)).toEqual({
      include_processes: true,
      count: 3,
      name: "001",
      tags: ["api", "worker"],
      metadata: { owner: "ops" },
      mode: "quick",
    });
  });

  test("requires exact declared names", () => {
    expect(() =>
      materializeWorkflowParameterFlags(parameterPlan(), [{ name: "include-processes", value: true }]),
    ).toThrow("must exactly match");
  });

  test("rejects duplicate scalars and schema-invalid values", () => {
    expect(() =>
      materializeWorkflowParameterFlags(parameterPlan(), [
        { name: "count", value: "2" },
        { name: "count", value: "3" },
      ]),
    ).toThrow("provided more than once");
    expect(() => materializeWorkflowParameterFlags(parameterPlan(), [{ name: "count", value: "0" }])).toThrow(
      "below minimum",
    );
    expect(() => materializeWorkflowParameterFlags(parameterPlan(), [{ name: "mode", value: "slow" }])).toThrow(
      "not one of",
    );
  });

  test("requires parameter flags after the target and rejects retired JSON params", () => {
    expect(() => parseWorkflowParameterFlags(["--count", "2", "workflows/health"], "workflows/health")).toThrow(
      "must come after",
    );
    expect(() =>
      parseWorkflowParameterFlags(["workflows/health", "--params", '{"count":2}'], "workflows/health"),
    ).toThrow("--params was removed");
  });
});
