// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow's `llm:` settings on an agent engine freeze into the plan with the
 * request, and a resumed unit lowers them from the journaled request and
 * runner alone, so a config edit after the freeze cannot change what it sends.
 * `reasoning_effort` is the workflow's spelling of `reasoningEffort`.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { buildExecutionFromWire } from "../../src/integrations/agent/execution";
import { getHarness } from "../../src/integrations/harnesses";
import { freezeWorkflow } from "../_helpers/workflow";

const CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: { oc: { kind: "agent", platform: "opencode", args: ["run", "--model", "krang/chat/qwen3.8-27b"] } },
  defaults: { engine: "oc" },
  workflow: { judgeEngine: "oc" },
} as const satisfies AkmConfig;

const WORKFLOW = [
  "---",
  "type: workflow",
  "defaults:",
  "  engine: oc",
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

function frozenTarget() {
  const plan = freezeWorkflow(WORKFLOW, "workflows/demo.md", CONFIG);
  const root = plan.steps[0]?.root;
  if (root?.kind !== "unit" || root.frozenTarget.kind !== "command") throw new Error("expected a frozen command unit");
  return root.frozenTarget;
}

describe("a frozen workflow unit on an agent engine", () => {
  test("freezes the unit's inference into the request and the runner", () => {
    const target = frozenTarget();

    expect(target.request.inference).toEqual({ temperature: 0.2, reasoningEffort: "low" });
    expect(target.runner.kind === "agent" && target.runner.profile.inference).toEqual({
      temperature: 0.2,
      reasoningEffort: "low",
    });
  });

  test("a resumed unit lowers it from the journal alone", () => {
    const target = frozenTarget();
    // Through the JSON the journal stores.
    const wire = JSON.parse(JSON.stringify({ request: target.request, runner: target.runner }));
    const built = buildExecutionFromWire(wire);
    if (built.runner.kind === "llm") throw new Error("expected an agent runner");
    const command = getHarness("opencode")?.agentBuilder?.build(
      built.runner.profile,
      built.options.dispatch ?? { prompt: "" },
    );

    expect(built.notices.filter((notice) => (notice.field ?? "").startsWith("inference."))).toEqual([]);
    expect(JSON.parse(command?.env?.OPENCODE_CONFIG_CONTENT ?? "null")).toEqual({
      provider: {
        krang: {
          models: { "chat/qwen3.8-27b": { options: { temperature: 0.2, reasoningEffort: "low" } } },
        },
      },
    });
  });
});
