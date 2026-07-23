// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm tasks` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/tasks-cli.ts and the migration of the
 * leaf handlers onto `defineJsonCommand` is byte-identical. Only the
 * scheduler-free subcommands are exercised (`doctor`, the bare-group default,
 * and the `run` not-found error path) so the test never touches the host OS
 * scheduler. The CLI reads an isolated stash through AKM_STASH_DIR via the
 * in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildScheduledTaskInvocation, type ScheduledTaskContext } from "../../../src/tasks/scheduler-invocation";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-tasks-envelope-");
  disposers.push(d);
  fs.mkdirSync(path.join(d.dir, "tasks"), { recursive: true });
  return d.dir;
}

function writeDisabledCommandTask(stashDir: string): void {
  fs.writeFileSync(
    path.join(stashDir, "tasks", "disabled-command.yml"),
    [
      "version: 2",
      'schedule: "@daily"',
      "enabled: false",
      `command: ${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`,
      "",
    ].join("\n"),
  );
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv({ AKM_STASH_DIR: stashDir }, () => runCliCapture(args));
  return { stdout, stderr, status: code };
}

describe("akm tasks — JSON envelope snapshot (WS6)", () => {
  test("bare `akm tasks` → doctor diagnostics envelope (group defaultRun)", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["--json", "tasks"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("tasks-doctor");
    expect(typeof env.backend).toBe("string");
  });

  test("tasks doctor: success envelope reports the active scheduler backend", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["--json", "tasks", "doctor"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("tasks-doctor");
    expect(typeof env.backend).toBe("string");
    expect(Array.isArray(env.warnings)).toBe(true);
  });

  // A v2 default-task file carrying a deprecated `--auto-accept safe` default-
  // task command. Parser normalization only rewrites `--profile`→`--strategy`
  // for legacy v1 files, so a stored v2 file keeps whichever spelling it was
  // minted with — the doctor's upgrade map must match both.
  function writeGeneratedCommandTask(stashDir: string, id: string, command: string): void {
    fs.writeFileSync(
      path.join(stashDir, "tasks", `${id}.yml`),
      ["version: 2", 'schedule: "@daily"', "enabled: true", `command: ${command}`, ""].join("\n"),
    );
  }

  test("tasks doctor flags the migrated `--strategy X --auto-accept safe` spelling with the flag-dropped replacement", async () => {
    const stash = makeStashDir();
    // What the 0.8→0.9 migration writes for the default improve tasks. Before
    // the upgrade map learned this spelling it matched no key and warned on
    // every run until 0.10 (chunk-6 ledger residue).
    writeGeneratedCommandTask(stash, "akm-improve-frequent", "akm improve --strategy frequent --auto-accept safe");

    const { stdout, status } = await runCli(["--json", "tasks", "doctor"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.staleGeneratedCommands).toContainEqual({
      id: "akm-improve-frequent",
      replacement: "akm improve --strategy frequent",
    });
  });

  test("tasks doctor still flags the original `--profile X --auto-accept safe` spelling", async () => {
    const stash = makeStashDir();
    writeGeneratedCommandTask(
      stash,
      "akm-graph-refresh-weekly",
      "akm improve --profile graph-refresh --auto-accept safe",
    );

    const { stdout, status } = await runCli(["--json", "tasks", "doctor"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.staleGeneratedCommands).toContainEqual({
      id: "akm-graph-refresh-weekly",
      replacement: "akm improve --strategy graph-refresh",
    });
  });

  test("tasks run: unknown id → {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["--json", "tasks", "run", "does-not-exist"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("ASSET_NOT_FOUND");
  });

  test("tasks run manually executes an intentionally disabled task", async () => {
    const stash = makeStashDir();
    writeDisabledCommandTask(stash);

    const { stdout, status } = await runCli(["--json", "tasks", "run", "disabled-command"], stash);

    expect(status).toBe(0);
    expect(JSON.parse(stdout).result.status).toBe("completed");
  });

  test("a backend-generated invocation uses its captured stash and skips the disabled task", async () => {
    const capturedStash = makeStashDir();
    const ambientStash = makeStashDir();
    writeDisabledCommandTask(capturedStash);
    const root = path.dirname(capturedStash);
    const context: ScheduledTaskContext = {
      AKM_STASH_DIR: capturedStash,
      AKM_CONFIG_DIR: path.join(root, "captured-config"),
      AKM_DATA_DIR: path.join(root, "captured-data"),
      AKM_CACHE_DIR: path.join(root, "captured-cache"),
      AKM_STATE_DIR: path.join(root, "captured-state"),
    };
    const generated = buildScheduledTaskInvocation(["akm"], "disabled-command", context);
    const ambientEnv: NodeJS.ProcessEnv = { AKM_STASH_DIR: ambientStash };

    const { code, stdout } = await withEnv({ ...ambientEnv, ...generated.environment }, () =>
      runCliCapture(["--json", ...generated.argv.slice(1)]),
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout).result.status).toBe("disabled");
  });
});
