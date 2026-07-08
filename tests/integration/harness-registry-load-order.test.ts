// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression: the harness registry must load without a temporal-dead-zone
 * (TDZ) error regardless of which module is the FIRST one evaluated in a fresh
 * module graph.
 *
 * The bug: the per-harness barrel `harnesses/opencode-sdk/index.ts` re-exports
 * `runOpencodeSdk`/`closeServer` from `./sdk-runner`, which imports
 * `core/config`; `core/config/config-types` derives `VALID_HARNESS_IDS` back
 * from `harnesses/index.ts`. When the registry imported `OpencodeSdkHarness`
 * through that barrel, importing the barrel first (as the workflow-exec
 * subprocess entry — `run-workflow` → `native-executor`/`runner-dispatch` →
 * this barrel — does) evaluated `harnesses/index.ts` and ran
 * `new OpencodeSdkHarness()` while the barrel's class binding was still
 * initializing, throwing "Cannot access 'OpencodeSdkHarness' before
 * initialization" (process exit 1). That crashed every multi-process workflow
 * chaos driver at import time.
 *
 * The fix moves the descriptor into a config-leaf module
 * (`opencode-sdk/harness.ts`) that the registry imports directly, so importing
 * the barrel never re-enters the still-initializing registry. This test spawns
 * a REAL `bun` child whose entry import is the barrel — the exact order that
 * reproduced the TDZ — and asserts it loads cleanly. A subprocess is required:
 * an in-process import would hit a warm module cache and never exercise the
 * fresh-graph evaluation order (hence tests/integration/ per the spawn rule).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SDK_BARREL = path.join(REPO_ROOT, "src", "integrations", "harnesses", "opencode-sdk", "index.ts");
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
  test("importing the opencode-sdk barrel FIRST loads the registry without a TDZ crash", () => {
    // Entry import is the barrel — the order that crashed with "Cannot access
    // 'OpencodeSdkHarness' before initialization" before the leaf-module split.
    const code = [
      `const m = await import(${JSON.stringify(SDK_BARREL)});`,
      `if (typeof m.OpencodeSdkHarness !== "function") throw new Error("OpencodeSdkHarness missing");`,
      `if (typeof m.runOpencodeSdk !== "function") throw new Error("runOpencodeSdk missing");`,
      `const reg = await import(${JSON.stringify(path.join(REPO_ROOT, "src", "integrations", "harnesses", "index.ts"))});`,
      `if (!reg.VALID_HARNESS_IDS.includes("opencode-sdk")) throw new Error("registry missing opencode-sdk");`,
      `console.log("ok");`,
    ].join("\n");
    const { status, stdout, stderr } = runBun(code);
    expect(stderr).not.toContain("before initialization");
    expect(status).toBe(0);
    expect(stdout).toContain("ok");
  });

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
