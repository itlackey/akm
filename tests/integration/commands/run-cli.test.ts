// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Exercises real isolated index/state databases and harmless echo/shell children.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { getWorkflowStatus, listWorkflowRuns } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { snapshotTree } from "../../_helpers/snapshot-tree";

let storage: IsolatedAkmStorage;
function write(ref: string, content: string, root = storage.stashDir): void {
  const file = path.join(root, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function stable(stdout: string) {
  const result = JSON.parse(stdout);
  delete result.durationMs;
  return result;
}
const workflow = `---
type: workflow
params:
  label: { type: string }
  tags: { type: array, items: { type: string } }
steps:
  - id: first
    unit:
      exec:
        command: ["sh", "-c", "printf first"]
  - id: second
    unit:
      exec:
        command: ["sh", "-c", "printf second"]
---
## first
Execute first.
## second
Execute second.
`;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    harnesses: { reviewer: { platform: "codex", bin: "/bin/echo", args: [] } },
  });
  write("commands/review.md", "---\ntype: command\nharness: reviewer\n---\nReview: [$ARGUMENTS]\n");
  write("agents/reviewer.md", "---\ntype: agent\n---\nCareful reviewer.\n");
  write("knowledge/note.md", "---\ntype: knowledge\n---\nA note.\n");
  write("scripts/never.sh", "exit 99\n");
  write(
    "tasks/check.yml",
    "version: 4\nrun: printf task-ok\nshell: sh\ninputs:\n  label: { type: string, required: true }\n",
  );
  write("workflows/check.md", workflow);
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

describe("additive akm run", () => {
  test("command arguments and output match the original entry, with no extra asset usage", async () => {
    const flags = ["commands/review", "--arguments", "  --literal=$ARGUMENTS\nline 2  ", "--harness", "reviewer"];
    const legacy = await runCliCapture(["command", "run", ...flags]);
    const before = readEvents({ type: "show" }).events.length;
    const run = await runCliCapture(["run", ...flags]);
    expect(run.code, run.stderr).toBe(0);
    expect(stable(run.stdout)).toEqual(stable(legacy.stdout));
    const after = readEvents({ type: "show" }).events.length;
    expect(after - before).toBe(1);
    expect(JSON.parse(run.stdout).stdout).toContain("  --literal=$ARGUMENTS\nline 2  ");
  });

  test("agent prompt and stdin retain literal input and legacy output", async () => {
    const prompt = "literal $ARGUMENTS {{json}}\nsecond line";
    const flags = ["agents/reviewer", "--prompt", prompt, "--harness", "reviewer"];
    const legacy = await runCliCapture(["agent", ...flags]);
    const run = await runCliCapture(["run", ...flags]);
    expect(run.code, run.stderr).toBe(0);
    expect(stable(run.stdout)).toEqual(stable(legacy.stdout));
    const read = fs.readFileSync;
    const mock = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...rest: unknown[]) =>
      file === 0 ? prompt : Reflect.apply(read, fs, [file, ...rest])) as typeof fs.readFileSync);
    try {
      const stdin = await runCliCapture(["run", "agents/reviewer", "--prompt-stdin", "--harness", "reviewer"]);
      expect(stdin.code, stdin.stderr).toBe(0);
      expect(stable(stdin.stdout)).toEqual(stable(run.stdout));
    } finally {
      mock.mockRestore();
    }
  });

  test("dry-run remains read-only and resolves options before the positional ref correctly", async () => {
    const before = snapshotTree(storage.root);
    const run = await runCliCapture(["run", "--arguments", "commands/review", "commands/review", "--dry-run"]);
    const legacy = await runCliCapture([
      "command",
      "run",
      "--arguments",
      "commands/review",
      "commands/review",
      "--dry-run",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(JSON.parse(legacy.stdout));
    expect(JSON.parse(run.stdout).shape).toBe("command-dry-run");
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("task inputs, scheduled marker, history and qualified bundle ownership are preserved without an index", async () => {
    const other = path.join(storage.root, "other");
    write(
      "tasks/check.yml",
      "version: 4\nrun: printf other-task\nshell: sh\ninputs:\n  label: { type: string, required: true }\n",
      other,
    );
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir },
        other: { path: other, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    const run = await runCliCapture(["run", "other//tasks/check", "--label=001", "--scheduled"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ shape: "task-run", result: { status: "completed" } });
    const history = await runCliCapture(["task", "history", "check", "--bundle", "other"]);
    expect(history.code, history.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(history.stdout).rows[0].log, "utf8")).toContain("other-task");
    expect(history.stdout).toContain("check");
    const selected = await runCliCapture(["run", "tasks/check", "--bundle", "other", "--label=002"]);
    expect(selected.code, selected.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(selected.stdout).result.log, "utf8")).toContain("other-task");
    const conflict = await runCliCapture(["run", "fixture//tasks/check", "--bundle", "other", "--label=x"]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("conflicts");
    const invalid = await runCliCapture(["run", "other//tasks/check", "--missing=1"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("missing");
  });

  test("workflow parameters, limits, frozen ID continuation and existing lifecycle operations remain available", async () => {
    const run = await runCliCapture([
      "run",
      "workflows/check",
      "--label=001",
      "--tags=one",
      "--tags=two",
      "--max-steps",
      "1",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ shape: "workflow-run", stepsProcessed: 1 });
    const id = result.run.id;
    const changedParams = await runCliCapture(["run", id, "--label=changed"]);
    expect(changedParams.code).toBe(2);
    expect(changedParams.stderr).toContain("existing run id");
    expect((await getWorkflowStatus(id)).run.params).toEqual({ label: "001", tags: ["one", "two"] });
    write("workflows/check.md", "invalid replacement: frozen run must survive");
    const resumed = await runCliCapture(["run", id]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).run.status).toBe("completed");
    const status = await runCliCapture(["workflow", "status", id]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).run.status).toBe("completed");
  });

  test("dispatch follows adapter type rather than a native-looking path prefix", async () => {
    const componentRoot = path.join(storage.root, "standalone");
    write("scripts/deep/nightly.yml", "version: 4\nrun: printf standalone\nshell: sh\n", componentRoot);
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir },
        standalone: { path: componentRoot, components: { main: { root: ".", adapter: "akm-task" } } },
      },
    });
    const result = await runCliCapture(["run", "standalone//scripts/deep/nightly"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      shape: "task-run",
      result: { id: "scripts/deep/nightly", status: "completed" },
    });
  });

  test("native task nonzero exits retain the original exit mapping", async () => {
    write("tasks/unavailable.yml", "version: 4\nrun: exit 78\nshell: sh\n");
    const legacy = await runCliCapture(["task", "run", "tasks/unavailable"]);
    const run = await runCliCapture(["run", "tasks/unavailable"]);
    expect(run.code).toBe(78);
    expect(legacy.code).toBe(78);
    expect(JSON.parse(run.stdout)).toMatchObject({
      shape: "task-run",
      ok: false,
      exitCode: 78,
      result: { status: "failed", detail: { exitCode: 78 } },
    });
  });

  for (const flags of [
    ["commands/review", "--prompt", "ignored"],
    ["agents/reviewer", "--arguments", "ignored"],
    ["commands/review", "extra"],
    ["commands/review", "--", "--child-flag"],
    ["agents/reviewer", "--prompt", "x", "--prompt-stdin"],
    ["workflows/check", "--new"],
    ["workflows/check", "--", "extra"],
    ["tasks/check", "--", "extra"],
    ["knowledge/note"],
    ["scripts/never.sh"],
    ["commands/review#section"],
  ]) {
    test(`rejects unsupported inputs without execution: ${flags.join(" ")}`, async () => {
      const result = await runCliCapture(["run", ...flags]);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).ok).toBe(false);
      expect((await listWorkflowRuns()).runs).toHaveLength(0);
    });
  }
});
