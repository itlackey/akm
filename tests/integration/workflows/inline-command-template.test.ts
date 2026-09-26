import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { workflowStepInstructions } from "../../../src/workflows/compile";
import { freezeWorkflow } from "../../../src/workflows/freeze/freeze";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function yamlWorkflow(stepYaml: string): string {
  return [
    "name: Gated",
    "on: { workflow_dispatch: null }",
    "jobs:",
    "  main:",
    "    runs-on: [self-hosted]",
    "    steps:",
    stepYaml,
    "",
  ].join("\n");
}

describe("inline akm/command content is never scanned for native-tool constructs (issue 4)", () => {
  test("compiles, loads, and freezes end to end — @file mention alongside $ARGUMENTS is plain prose", async () => {
    write(
      "workflows/gated.yml",
      yamlWorkflow(
        [
          "      - id: review",
          "        uses: akm/command",
          "        with:",
          "          content: Review $ARGUMENTS against @docs/style-guide.md",
          "          arguments: the diff",
        ].join("\n"),
      ),
    );

    const asset = await loadWorkflowAsset("workflows/gated");
    expect(workflowStepInstructions(asset.plan.steps[0]!)).toBe("Review the diff against @docs/style-guide.md");

    const frozen = await freezeWorkflow(asset, loadConfig());
    const target = frozen.plan.steps[0]?.root;
    if (!target || target.kind !== "unit" || target.frozenTarget.kind !== "command") {
      throw new Error("expected a frozen command unit");
    }
    expect(target.frozenTarget.request.command.content).toBe("Review the diff against @docs/style-guide.md");
  });

  test("a STORED commands/<ref> action carrying the same native-tool-shaped prose also compiles and freezes with its content intact", async () => {
    write("commands/review.md", "Review $ARGUMENTS against @native/tool-construct\n");
    write(
      "workflows/stored.yml",
      yamlWorkflow(
        [
          "      - id: review",
          "        uses: akm/command",
          "        with:",
          "          ref: commands/review",
          "          arguments: the diff",
        ].join("\n"),
      ),
    );

    await akmIndex({ stashDir: storage.stashDir, full: true });
    const asset = await loadWorkflowAsset("workflows/stored");
    const frozen = await freezeWorkflow(asset, loadConfig());
    const target = frozen.plan.steps[0]?.root;
    if (!target || target.kind !== "unit" || target.frozenTarget.kind !== "command") {
      throw new Error("expected a frozen command unit");
    }
    expect(target.frozenTarget.request.command.content).toBe("Review the diff against @native/tool-construct\n");
  });
});
