// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression: the harness registry must load without a temporal-dead-zone
 * (TDZ) error regardless of which module is the FIRST one evaluated in a fresh
 * module graph.
 *
 * The bug it pins: a harness descriptor that imports (directly or through a
 * barrel) a module reaching `core/config` makes the registry initialise while
 * `core/config` is still loading, because `core/config/config-types` derives
 * `VALID_HARNESS_IDS` back from `harnesses/index.ts`. Importing that module
 * first (as the workflow-exec subprocess entry does: `run-workflow` →
 * `native-executor`/`runner-dispatch` → the harness) then ran
 * `new <Harness>()` while the descriptor's class binding was still
 * initializing, throwing "Cannot access '<Harness>' before initialization"
 * (process exit 1), which crashed every multi-process workflow chaos driver at
 * import time. A descriptor therefore never imports a module that reaches
 * `core/config`. This test spawns a REAL `bun` child whose entry import is
 * `run-workflow` (the workflow-exec subprocess entry — the exact order that
 * reproduced the TDZ) and asserts it loads cleanly. A subprocess is required:
 * an in-process import would hit a warm module cache and never exercise the
 * fresh-graph evaluation order (hence tests/integration/ per the spawn rule).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUN_WORKFLOW = path.join(REPO_ROOT, "src", "workflows", "exec", "run-workflow.ts");

/** Spawn `bun -e <code>` and return its exit status + captured streams. */
function runBun(code: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["-e", code], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("harness registry module load order (TDZ regression)", () => {
  test("importing run-workflow FIRST (the chaos-driver entry) loads without a TDZ crash", () => {
    const code = [
      `const m = await import(${JSON.stringify(RUN_WORKFLOW)});`,
      `if (typeof m.runWorkflowSteps !== "function") throw new Error("runWorkflowSteps missing");`,
      `console.log("ok");`,
    ].join("\n");
    const { status, stdout, stderr } = runBun(code);
    expect(stderr).not.toContain("before initialization");
    expect(status).toBe(0);
    expect(stdout).toContain("ok");
  });
});
