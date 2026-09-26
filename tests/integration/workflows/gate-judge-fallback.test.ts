import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { freezeWorkflow } from "../../../src/workflows/freeze/freeze";
import { getWorkflowStatus, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

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

// Keep the workflow's `true` executable resolvable while deliberately hiding
// ambient agent CLIs such as opencode. These cases assert the no-engine path.
const NO_AGENT_PATH = path.dirname(Bun.which("true") ?? process.execPath);

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

describe("resolveJudge freezes frozenJudge: null (never refuses) when no engine resolves anywhere", () => {
  test("freezing a gated workflow succeeds and warns instead of throwing", async () => {
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);

    const warnCalls: string[] = [];
    const asset = await loadWorkflowAsset("workflows/gated");
    const frozen = await withEnv({ PATH: NO_AGENT_PATH }, () =>
      withSeam(
        _setWarnSinkForTests,
        (level, args) => {
          if (level !== "warn") return;
          warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
        },
        () => freezeWorkflow(asset, loadConfig()),
      ),
    );

    const step = frozen.plan.steps.find((s) => s.stepId === "work");
    expect(step?.gate.criteria.length).toBeGreaterThan(0);
    expect(step?.gate.frozenJudge).toBeNull();
    expect(warnCalls.some((w) => w.includes("no verification engine is available"))).toBe(true);
  });

  test("end to end: `workflow create` + `workflow run` no longer fails outright on a default install — the run blocks gracefully at the gate instead", async () => {
    writeSandboxConfig({});
    resetConfigCache();
    write("workflows/gated.md", GATED_EXEC_WORKFLOW);

    await withEnv({ PATH: NO_AGENT_PATH }, async () => {
      const started = await startWorkflowRun("workflows/gated");
      expect(started.run.status).toBe("active");

      const result = await runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => ({ ok: true, text: "did the work" }),
        summaryJudge: null,
      });

      expect(result.run.status).toBe("blocked");
      expect(result.judgeFailure?.stepId).toBe("work");
      expect(result.judgeFailure?.message).toContain("no verification judge is available");
      const status = await getWorkflowStatus(started.run.id);
      expect(status.run.status).toBe("blocked");
      expect(status.workflow.steps[0]?.status).toBe("blocked");
      expect(status.workflow.steps[0]?.evidence?.output).toBe("did the work");
    });
  }, 30_000);
});
