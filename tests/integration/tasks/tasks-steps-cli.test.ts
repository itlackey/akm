// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Experimental `steps:` tasks through the real CLI: `akm run`, `--resume`, `doctor explain`, and scheduler projection. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compileSchedulerSources } from "../../../src/tasks/scheduler-sync";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../../src/cli.ts");
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});
afterEach(() => storage.cleanup());

function akm(args: string[]) {
  return spawnSync("bun", [CLI, ...args, "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", BUN_TEST: undefined, AKM_EVENT_SOURCE: undefined },
    timeout: 60000,
  });
}

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe.skipIf(process.platform !== "linux")("steps tasks through the CLI", () => {
  test("akm run runs the steps, a failure is resumed with --resume, and doctor explain lists the steps", () => {
    const marker = path.join(storage.stashDir, "marker");
    write(
      "tasks/demo.yml",
      `version: 4
schedule: "0 5 * * *"
steps:
  - name: prepare
    run: printf 'ready'
  - name: gate
    run: test -f ${marker} && printf '%s' "$AKM_STEPS"
`,
    );
    const first = akm(["run", "tasks/demo"]);
    expect(first.status).toBe(1);
    expect(JSON.parse(first.stdout).result.steps.map((s: { status: string }) => s.status)).toEqual([
      "completed",
      "failed",
    ]);
    fs.writeFileSync(marker, "");
    const resumed = akm(["run", "tasks/demo", "--resume"]);
    expect(resumed.status).toBe(0);
    const result = JSON.parse(resumed.stdout).result;
    expect(result.steps.map((s: { status: string }) => s.status)).toEqual(["reused", "completed"]);
    expect(result.steps[1].summary).toBe('{"prepare":"ready"}');

    const explained = akm(["doctor", "explain", "tasks/demo"]);
    expect(explained.status).toBe(0);
    const target = JSON.parse(explained.stdout).target ?? JSON.parse(explained.stdout).result?.target;
    expect(target.kind).toBe("steps");
    expect(target.steps.map((s: { name: string }) => s.name)).toEqual(["prepare", "gate"]);
  });

  test("scheduler projection accepts a scheduled steps task", async () => {
    write("tasks/nightly.yml", `version: 4\nschedule: "0 5 * * *"\nsteps:\n  - { name: a, run: 'true' }\n`);
    const compiled = await compileSchedulerSources({
      sourceRoot: storage.stashDir,
      adapterId: "akm",
      bundleName: "stash",
      backend: "cron",
    });
    expect(compiled.failures).toEqual([]);
    expect(compiled.desired).toHaveLength(1);
  });
});
