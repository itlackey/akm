// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * End-to-end regression for what `akm show --format json` says about an `exec`
 * (shell) step, driven through the CLI's own entry point (`akmShowUnified`,
 * the value `output("show", result)` serializes).
 *
 * The projection is a CLAIM about what will run. An exec unit names no engine,
 * so `show` must not describe one — it used to merge `defaults.engine` /
 * `defaults.model` into every step and omit the argv entirely, which made the
 * only machine-readable description of an exec step actively false.
 *
 * The unit-level shape of the projection is pinned in
 * `tests/workflows/show-orchestration.test.ts`; this suite exists to prove the
 * fix survives the real command path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../../src/commands/read/show";
import { saveConfig } from "../../../src/core/config/config";
import "../../../src/sources/providers/index";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

const WORKFLOW = [
  "---",
  "type: workflow",
  "description: Runs the test suite as a shell command",
  "defaults:",
  "  engine: default-engine",
  "  model: default-model",
  "steps:",
  "  - id: test",
  "    unit:",
  "      exec:",
  '        command: ["bun", "run", "test:unit"]',
  "        cwd: packages/core",
  "  - id: summarize",
  "---",
  "",
  "# Exec show fixture",
  "",
  "## test",
  "",
  "Run the unit tests.",
  "",
  "## summarize",
  "",
  "Summarize the result.",
  "",
].join("\n");

let stashDir = "";
let cleanup: Cleanup = () => {};

beforeEach(() => {
  const cache = sandboxXdgCacheHome();
  const config = sandboxXdgConfigHome(cache.cleanup);
  const stash = sandboxStashDir(config.cleanup);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("akm show --format json: exec steps", () => {
  test("exposes the exec step's command and does NOT claim the workflow's default engine", async () => {
    const filePath = path.join(stashDir, "workflows", "ship.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, WORKFLOW, "utf8");
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShowUnified({ ref: "workflows/ship", skipLogging: true });
    const steps = result.steps ?? [];
    const execStep = steps.find((step) => step.id === "test");
    const llmStep = steps.find((step) => step.id === "summarize");

    // What runs is visible...
    expect(execStep?.orchestration?.exec).toEqual({ command: ["bun", "run", "test:unit"], cwd: "packages/core" });
    // ...and the untrue claim is gone.
    expect(execStep?.orchestration?.engine).toBeUndefined();
    expect(execStep?.orchestration?.model).toBeUndefined();
    // The sibling engine step is unaffected — the defaults still apply there.
    expect(llmStep?.orchestration?.engine).toBe("default-engine");
    expect(llmStep?.orchestration?.model).toBe("default-model");

    // The serialized `--format json` payload itself, since that is the surface
    // an agent or script reads.
    const json = JSON.stringify(result);
    expect(json).toContain('"test:unit"');
    expect(JSON.parse(json).steps[0].orchestration).toEqual({
      exec: { command: ["bun", "run", "test:unit"], cwd: "packages/core" },
    });
  });
});
