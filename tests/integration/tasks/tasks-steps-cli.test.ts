// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Experimental `steps:` tasks through the real CLI: `akm run`, `--resume`, `doctor explain`, and the scheduler dispatcher. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { dispatchDueTasks } from "../../../src/tasks/dispatch";
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

  test("the dispatcher starts a scheduled steps task", async () => {
    write("tasks/nightly.yml", `version: 4\nschedule: "30 9 * * *"\nsteps:\n  - { name: a, run: 'true' }\n`);
    saveConfig({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      scheduler: { enabled: ["stash//tasks/nightly"] },
    });
    const started: string[] = [];
    const result = await dispatchDueTasks({
      now: () => new Date(2026, 10, 9, 9, 30, 0, 0),
      launcher: ["/opt/akm"],
      start: async (argv) => {
        started.push(argv.join(" "));
      },
      statePath: path.join(storage.stateDir, "akm", "scheduler", "dispatch-minute"),
      logDir: path.join(storage.cacheDir, "task-logs"),
    });
    expect(result.failures).toEqual([]);
    expect(result.started).toEqual(["stash//tasks/nightly"]);
    expect(started).toEqual(["/opt/akm task run nightly --bundle stash --scheduled"]);
  });
});
