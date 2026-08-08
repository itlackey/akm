// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bug 7 regression — the freeze-time llm-override guard used to be dead code:
 * `mergedLlmOverrides` was only computed for `kind: "llm"` engines, so the
 * "non-llm engine with llm overrides" branch could never fire and the
 * overrides were silently DROPPED for agent/sdk engines. The guard is now
 * live: llm overrides anywhere in a non-llm engine's layer stack (unit `llm:`
 * or document `defaults.llm`) throw a ConfigError naming the step and engine.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/core/errors";
import type { IrUnitNode } from "../../src/workflows/ir/schema";
import { freezeWorkflow } from "../_helpers/workflow";

// WORKFLOW_TEST_CONFIG's default engine is `test-agent` (opencode-sdk, an
// agent engine with the `test-llm` fallback) — exactly the shape whose llm
// overrides used to vanish.

function workflow(frontmatter: string[]): string {
  return [
    "---",
    "type: workflow",
    ...frontmatter,
    "steps:",
    "  - id: review",
    "---",
    "",
    "## review",
    "",
    "Review.",
    "",
  ].join("\n");
}

describe("bug 7 — llm overrides on a non-llm engine throw at freeze", () => {
  test("unit-level llm overrides on the (agent) default engine throw a ConfigError naming step and engine", () => {
    const markdown = [
      "---",
      "type: workflow",
      "steps:",
      "  - id: review",
      "    unit: { llm: { temperature: 0 } }",
      "---",
      "",
      "## review",
      "",
      "Review.",
      "",
    ].join("\n");
    let caught: unknown;
    try {
      freezeWorkflow(markdown);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain('step "review"');
    expect(message).toContain('engine "test-agent"');
    expect(message).toContain("llm:");
    expect(message).toContain("Remove the llm: block or select an LLM engine");
  });

  test("document defaults.llm with an agent engine anywhere in the stack also throws", () => {
    const markdown = workflow(["defaults: { llm: { temperature: 0.2 } }"]);
    expect(() => freezeWorkflow(markdown)).toThrow(ConfigError);
    expect(() => freezeWorkflow(markdown)).toThrow(/agent engine and cannot receive llm/);
  });

  test("llm overrides on an actual LLM engine freeze into the invocation (no false positive)", () => {
    const markdown = [
      "---",
      "type: workflow",
      "steps:",
      "  - id: review",
      "    unit: { engine: test-llm, llm: { temperature: 0 } }",
      "---",
      "",
      "## review",
      "",
      "Review.",
      "",
    ].join("\n");
    const plan = freezeWorkflow(markdown);
    const root = plan.steps[0]!.root as IrUnitNode;
    expect(root.invocation.engine).toBe("test-llm");
    expect(root.invocation.llm).toEqual({ temperature: 0 });
  });

  test("the SDK fallback path is unaffected: an agent engine WITHOUT llm overrides still freezes", () => {
    // `test-agent` is opencode-sdk with the `test-llm` LLM fallback — the
    // fallback resolves a model through a separate mechanism (`llmEngine`),
    // never through the invocation-override layers, so the live guard must
    // not fire on it.
    const plan = freezeWorkflow(workflow([]));
    const root = plan.steps[0]!.root as IrUnitNode;
    expect(root.invocation.engine).toBe("test-agent");
    expect(root.invocation.llm).toBeUndefined();
    expect(root.invocation.model).toBe("test-model"); // resolved via the test-llm fallback
    expect(plan.execution.engines["test-agent"]).toMatchObject({ kind: "agent", fallbackLlmEngine: "test-llm" });
  });
});
