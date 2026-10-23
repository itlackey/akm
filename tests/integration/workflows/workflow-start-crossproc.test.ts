// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { bunAvailable, pollUntil } from "../_helpers/workflow-crossproc";

const WORKER = path.join(__dirname, "..", "_helpers", "workflow-start-worker.ts");
const BUN = bunAvailable();
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    "---\ntype: workflow\ndescription: cross-process start\nsteps:\n  - id: work\n---\n\n## work\n\nWork.\n",
  );
}

async function runPair(name: string): Promise<Array<{ ok: boolean; runId?: string; error?: string; code?: string }>> {
  await withWorkflowRunsRepo(() => undefined);
  const markerDir = path.join(storage.root, `start-${name}`);
  fs.mkdirSync(markerDir, { recursive: true });
  const release = path.join(markerDir, "release");
  const children = [0, 1].map((index) => {
    const result = path.join(markerDir, `${index}.result.json`);
    const ready = path.join(markerDir, `${index}.ready`);
    const child = spawn("bun", [WORKER], {
      env: {
        ...process.env,
        WORKFLOW_START_READY: ready,
        WORKFLOW_START_RELEASE: release,
        WORKFLOW_START_RESULT: result,
        WORKFLOW_START_TARGET: `workflows/${name}`,
        WORKFLOW_START_STASH_DIR: storage.stashDir,
        WORKFLOW_START_CONFIG_HOME: storage.configDir,
        WORKFLOW_START_DATA_HOME: storage.dataDir,
        WORKFLOW_START_CACHE_HOME: storage.cacheDir,
        WORKFLOW_START_STATE_HOME: storage.stateDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    return { child, result, ready, stderr: () => stderr };
  });
  await pollUntil(
    () => {
      const failed = children.find(({ child, ready }) => child.exitCode !== null && !fs.existsSync(ready));
      if (failed) {
        const result = fs.existsSync(failed.result) ? fs.readFileSync(failed.result, "utf8") : "no result";
        throw new Error(`start worker exited before barrier: ${failed.stderr()} ${result}`);
      }
      return children.every(({ ready }) => fs.existsSync(ready));
    },
    { label: "both start workers ready" },
  );
  const exited = Promise.all(
    children.map(
      ({ child }) =>
        new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null) return resolve();
          child.on("error", reject);
          child.on("exit", () => resolve());
        }),
    ),
  );
  fs.writeFileSync(release, "go");
  await exited;
  return children.map(({ result }) => JSON.parse(fs.readFileSync(result, "utf8")));
}

describe.skipIf(!BUN)("cross-process workflow start", () => {
  test("two concurrent starts of one ref both succeed and leave two runs", async () => {
    writeWorkflow("concurrent-start");
    const results = await runPair("concurrent-start");
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(
      await withWorkflowRunsRepo((repo) => repo.listRuns({ workflowRef: "stash//workflows/concurrent-start" })),
    ).toHaveLength(2);
  }, 30_000);
});
