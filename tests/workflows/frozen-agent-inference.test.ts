// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow's `llm:` settings freeze into the request of every unit, whatever
 * its target kind. `reasoning_effort` is the workflow's spelling of
 * `reasoningEffort`.
 */

import { expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { freezeWorkflow } from "../_helpers/workflow";

const CONFIG = {
  configVersion: "0.9.0",
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
