// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A version 5 task with an agent step, run for real against a fake harness that prints nothing, is counted by
 * `akm doctor`: the rate, the reason counts and the dominant-reason wording.
 */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFakeHarness } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../../src/cli.ts");
setDefaultTimeout(120_000);
let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-doctor-agent-steps");
});
afterEach(() => {
  bins.cleanup();
  storage.cleanup();
});

function akm(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", BUN_TEST: undefined, AKM_EVENT_SOURCE: undefined },
    timeout: 120_000,
  });
}

test.skipIf(process.platform !== "linux")("v5 agent steps are counted end to end", () => {
  const empty = writeFakeHarness(bins.dir, "fake-claude", [""]);
  writeSandboxConfig({ semanticSearchMode: "off", harnesses: { claude: { platform: "claude", bin: empty } } });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "tasks", "agent.yml"),
    "version: 5-beta.1\nsteps:\n  - name: ask\n    prompt: Hi.\n  - name: after\n    exec: 'true'\n",
  );
  akm(["run", "tasks/agent", "--format", "json"]);
  akm(["run", "tasks/agent", "--format", "json"]);
  const doctor = akm(["doctor", "--no-probe", "--format", "json"]);
  const report = JSON.parse(doctor.stdout);
  expect(report.metrics.agentFailureRate).toBe(1);
  expect(report.metrics.agentFailureReasonCounts).toEqual({ parse_error: 2 });
  const advisory = report.advisories.find((check: { name: string }) => check.name === "task-fail-rate");
  expect(advisory.message).toContain("parse_error-dominant: 2/2 agent dispatch failures");
});
