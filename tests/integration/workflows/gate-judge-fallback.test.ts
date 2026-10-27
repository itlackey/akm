import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { freezeWorkflow } from "../../../src/workflows/freeze/freeze";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
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

describe("the gate's judge runs where model work runs", () => {
  test("the default connection judges the gate", async () => {
    writeSandboxConfig({
      connections: { reviewer: { endpoint: "http://localhost:1/v1", models: { fast: "test-model" } } },
    });
    resetConfigCache();
    write("workflows/gated.md", GATED_WORKFLOW);

    const asset = await loadWorkflowAsset("workflows/gated");
    const frozen = await freezeWorkflow(asset, loadConfig());
    const step = frozen.plan.steps.find((s) => s.stepId === "work");
    expect(step?.gate.criteria.length).toBeGreaterThan(0);
    expect(step?.gate.frozenJudge).not.toBeNull();
    expect(step?.gate.frozenJudge?.request.target).toEqual({ name: "reviewer", kind: "connection" });
    expect(step?.gate.frozenJudge?.request.modelWork).toBe(true);
  });

  test("with no connection or harness configured, freezing a gated workflow names akm setup", async () => {
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);

    const asset = await loadWorkflowAsset("workflows/gated");
    const failure = await freezeWorkflow(asset, loadConfig()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).code).toBe("LLM_NOT_CONFIGURED");
    expect((failure as ConfigError).hint()).toContain("akm setup");
  });

  test("end to end: `workflow run` judges the gate through the default connection", async () => {
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ choices: [{ message: { content: '{"complete": true, "missing": []}' } }] }),
    });
    try {
      writeSandboxConfig({
        connections: { reviewer: { endpoint: `http://127.0.0.1:${provider.port}/v1`, models: { fast: "judge" } } },
      });
      resetConfigCache();
      write("workflows/gated.md", GATED_EXEC_WORKFLOW);

      const started = await startWorkflowRun("workflows/gated");
      expect(started.run.status).toBe("active");

      const result = await runWorkflowSteps({ target: started.run.id });

      expect(result.judgeFailure).toBeUndefined();
      expect(result.run.status).toBe("completed");
    } finally {
      provider.stop(true);
    }
  }, 30_000);
});
