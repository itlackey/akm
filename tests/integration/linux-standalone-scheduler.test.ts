// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Linux standalone scheduler acceptance. This gate uses a fake crontab and is
 * safe to run locally: it executes the generated cron body but never invokes
 * the host's crontab command.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

const REQUESTED = process.env.AKM_STANDALONE_SCHEDULER_TESTS === "1";
const ENABLED = REQUESTED && process.platform === "linux";

if (REQUESTED && !ENABLED) {
  throw new Error("AKM_STANDALONE_SCHEDULER_TESTS=1 requires a Linux runner");
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(argv: string[], env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

function expectSuccess(result: RunResult, label: string): void {
  expect(result.status, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

function generatedCronCommand(crontab: string, id: string): string {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(`# akm:task ${id} BEGIN`);
  const body = lines[begin + 1] ?? "";
  const match = body.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
  if (!match) throw new Error(`Could not extract generated cron command for ${id}: ${body}`);
  return match[1]!;
}

test.skipIf(!ENABLED)(
  "a standalone binary outside PATH installs and executes its generated cron command",
  () => {
    const binary = path.resolve(process.env.AKM_STANDALONE_TEST_BIN ?? "");
    const candidateArch = process.env.AKM_CANDIDATE_ARCH;
    const candidateVersion = process.env.AKM_CANDIDATE_VERSION;
    expect(process.env.AKM_STANDALONE_TEST_BIN, "AKM_STANDALONE_TEST_BIN must name the compiled artifact").toBeTruthy();
    expect(candidateArch, "AKM_CANDIDATE_ARCH must name the compiled artifact architecture").toBeTruthy();
    expect(candidateVersion, "AKM_CANDIDATE_VERSION must name the compiled artifact version").toBeTruthy();
    expect(candidateArch === process.arch).toBe(true);
    expect(fs.existsSync(binary)).toBe(true);

    const sandbox = makeSandboxDir("akm-linux-standalone-scheduler");
    const id = `akm-ci-linux-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fakeBin = path.join(sandbox.dir, "fake-bin");
    const fakeCrontab = path.join(sandbox.dir, "crontab");
    const home = path.join(sandbox.dir, "home");
    const configHome = path.join(sandbox.dir, "config");
    const dataHome = path.join(sandbox.dir, "data");
    const cacheHome = path.join(sandbox.dir, "cache");
    const stateHome = path.join(sandbox.dir, "state");
    const stashDir = path.join(sandbox.dir, "stash");
    let taskAdded = false;

    for (const dir of [fakeBin, home, path.join(configHome, "akm"), dataHome, cacheHome, stateHome, stashDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(fakeBin, "crontab"),
      [
        "#!/bin/sh",
        `if [ "\${1:-}" = "-l" ]; then`,
        '  if [ -f "$FAKE_CRONTAB" ]; then cat "$FAKE_CRONTAB"; exit 0; fi',
        '  echo "no crontab for sandbox" >&2',
        "  exit 1",
        "fi",
        `if [ "\${1:-}" = "-" ]; then cp /dev/stdin "$FAKE_CRONTAB"; exit 0; fi`,
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(configHome, "akm", "config.json"),
      `${JSON.stringify({ configVersion: "0.9.0", bundles: { stash: { path: stashDir } }, defaultBundle: "stash", semanticSearchMode: "off" })}\n`,
      { mode: 0o600 },
    );

    const restrictedPath = [fakeBin, "/usr/bin", "/bin"].join(path.delimiter);
    expect(restrictedPath.split(path.delimiter)).not.toContain(path.dirname(binary));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      AKM_STASH_DIR: stashDir,
      FAKE_CRONTAB: fakeCrontab,
      PATH: restrictedPath,
      NO_COLOR: "1",
      CI: "1",
    };

    try {
      const version = run([binary, "--version"], env);
      expectSuccess(version, "standalone candidate --version");
      expect(version.stdout).toContain(candidateVersion as string);

      const doctor = run([binary, "tasks", "doctor"], env);
      expectSuccess(doctor, "standalone tasks doctor");
      expect(JSON.parse(doctor.stdout)).toMatchObject({ akm: { argv: [binary], via: "standalone" } });

      const add = run([binary, "tasks", "add", id, "--schedule", "@daily", "--command", "akm --version"], env);
      expectSuccess(add, "standalone tasks add");
      taskAdded = true;

      const taskPath = path.join(stashDir, "tasks", `${id}.yml`);
      const originalTask = fs.readFileSync(taskPath);
      const crontab = fs.readFileSync(fakeCrontab, "utf8");
      expect(crontab).toContain(binary);
      expect(crontab).not.toContain("/$bunfs/");
      expect(crontab).not.toContain("src/cli.ts");

      const scheduledCommand = generatedCronCommand(crontab, id);
      const scheduled = run(["/bin/sh", "-c", scheduledCommand], { ...env, PATH: "/usr/bin:/bin" });
      expectSuccess(scheduled, "generated standalone cron command");

      const history = run([binary, "tasks", "history", "--id", id, "--limit", "1"], env);
      expectSuccess(history, "standalone tasks history");
      const row = (
        JSON.parse(history.stdout) as {
          rows: Array<{ status: string; log: string; detail?: { exitCode?: number } }>;
        }
      ).rows[0];
      expect(row).toMatchObject({ status: "completed", detail: { exitCode: 0 } });
      expect(fs.readFileSync(row!.log, "utf8")).toContain(candidateVersion as string);
      expect(fs.readFileSync(taskPath)).toEqual(originalTask);
    } finally {
      if (taskAdded) run([binary, "tasks", "remove", id], env);
      sandbox.cleanup();
    }
  },
  180_000,
);
