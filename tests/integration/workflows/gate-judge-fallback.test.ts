import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { freezeWorkflow } from "../../../src/workflows/freeze/freeze";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { installFakeOpencodeHost } from "../../_helpers/fake-opencode-host";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
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

const GATED_WORKFLOW = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
  "### gate",
  "",
  "- Confirm the work is done.",
  "",
].join("\n");

const GATED_EXEC_WORKFLOW = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "    unit:",
  '      exec: { command: ["true"] }',
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
  "### gate",
  "",
  "- Confirm the work is done.",
  "",
].join("\n");

describe("resolveJudge falls back to the default engine when workflow.judgeEngine is unset", () => {
  test("a configured defaults.engine is used for the gate's judge", async () => {
    writeSandboxConfig({
      engines: { reviewer: { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test-model" } },
      defaults: { engine: "reviewer" },
    });
    resetConfigCache();
    write("workflows/gated.md", GATED_WORKFLOW);

    const asset = await loadWorkflowAsset("workflows/gated");
    const frozen = await freezeWorkflow(asset, loadConfig());
    const step = frozen.plan.steps.find((s) => s.stepId === "work");
    expect(step?.gate.criteria.length).toBeGreaterThan(0);
    expect(step?.gate.frozenJudge).not.toBeNull();
    expect(step?.gate.frozenJudge?.request.engine.name).toBe("reviewer");
  });
});

describe("resolveJudge falls back to the opencode-sdk engine when no engine resolves anywhere", () => {
  test("freezing a gated workflow freezes the opencode-sdk judge", async () => {
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);

    const asset = await loadWorkflowAsset("workflows/gated");
    const frozen = await freezeWorkflow(asset, loadConfig());

    const step = frozen.plan.steps.find((s) => s.stepId === "work");
    expect(step?.gate.criteria.length).toBeGreaterThan(0);
    expect(step?.gate.frozenJudge?.request.engine).toEqual({
      name: "opencode-sdk",
      kind: "sdk",
      platform: "opencode-sdk",
    });
  });

  test("end to end: `workflow create` + `workflow run` on a default install judges the gate on the embedded OpenCode", async () => {
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);
    const host = installFakeOpencodeHost({ reply: () => '{"complete": true, "missing": []}' });

    const started = await startWorkflowRun("workflows/gated");
    expect(started.run.status).toBe("active");

    const result = await runWorkflowSteps({ target: started.run.id });

    expect(result.judgeFailure).toBeUndefined();
    expect(result.run.status).toBe("completed");
    expect(host.calls.length).toBeGreaterThan(0);
  }, 30_000);
});
