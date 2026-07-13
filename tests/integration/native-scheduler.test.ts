// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CI-only acceptance for real per-user launchd and Windows Task Scheduler
 * jobs. The double opt-in prevents a developer from touching a live scheduler:
 * the explicit gate is rejected unless this is a disposable GitHub runner.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REQUESTED = process.env.AKM_NATIVE_SCHEDULER_TESTS === "1";
const SUPPORTED = process.platform === "darwin" || process.platform === "win32";
const DISPOSABLE_CI = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const ENABLED = REQUESTED && SUPPORTED && DISPOSABLE_CI;

if (REQUESTED && !ENABLED) {
  throw new Error("AKM_NATIVE_SCHEDULER_TESTS=1 is restricted to disposable GitHub Actions macOS/Windows runners");
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: { windowsVerbatimArguments?: boolean } = {},
): RunResult {
  const result = spawnSync(argv[0], argv.slice(1), {
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
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

function withoutHarnessOverrides(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "AKM_STASH_DIR",
    "AKM_CONFIG_DIR",
    "AKM_DATA_DIR",
    "AKM_CACHE_DIR",
    "AKM_STATE_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "BUN_TEST",
    "NODE_ENV",
  ]) {
    delete env[key];
  }
  if (overrides.PATH !== undefined) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
  }
  Object.assign(env, overrides);
  return env;
}

function nativeTarget(id: string): string {
  if (process.platform === "win32") return `\\akm\\${id}`;
  if (typeof process.getuid !== "function") throw new Error("launchd gate cannot resolve the current uid");
  return `gui/${process.getuid()}/com.akm.task.${id}`;
}

async function waitForCompletedHistory(
  runCli: (args: string[]) => RunResult,
  id: string,
): Promise<{
  status: string;
  log: string;
  detail?: { exitCode?: number };
}> {
  const deadline = Date.now() + 60_000;
  let diagnostic = "no history response";
  while (Date.now() < deadline) {
    const history = runCli(["tasks", "history", "--id", id, "--limit", "1"]);
    diagnostic = `${history.stdout}\n${history.stderr}`;
    if (history.status === 0) {
      const rows = (
        JSON.parse(history.stdout) as {
          rows: Array<{ status: string; log: string; detail?: { exitCode?: number } }>;
        }
      ).rows;
      if (rows[0] && rows[0].status !== "active") return rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Native scheduler did not record task ${id} within 60s:\n${diagnostic}`);
}

test.skipIf(!ENABLED)(
  "the packaged standalone runs through the native per-user scheduler and is cleaned up",
  async () => {
    const binary = path.resolve(process.env.AKM_NATIVE_TEST_BIN ?? "");
    const candidateArch = process.env.AKM_CANDIDATE_ARCH;
    const nativeHome = process.env.AKM_NATIVE_HOME;
    const id = process.env.AKM_NATIVE_TASK_ID;
    const candidateVersion = process.env.AKM_CANDIDATE_VERSION;
    const gateDir = path.resolve(process.env.AKM_NATIVE_GATE_DIR ?? "");
    expect(process.env.AKM_NATIVE_TEST_BIN, "AKM_NATIVE_TEST_BIN must name the compiled artifact").toBeTruthy();
    expect(nativeHome, "AKM_NATIVE_HOME must preserve the runner's real home before bun test preload").toBeTruthy();
    expect(id, "AKM_NATIVE_TASK_ID must uniquely identify the scheduler artifact").toBeTruthy();
    expect(candidateArch, "AKM_CANDIDATE_ARCH must name the compiled artifact architecture").toBeTruthy();
    expect(candidateVersion, "AKM_CANDIDATE_VERSION must name the compiled artifact version").toBeTruthy();
    expect(process.env.AKM_NATIVE_GATE_DIR, "AKM_NATIVE_GATE_DIR must isolate gate-owned files").toBeTruthy();
    expect(id).toMatch(new RegExp(`^akm-ci-${process.platform}-[0-9]+-[0-9]+$`));
    expect(candidateArch === process.arch).toBe(true);
    expect(fs.existsSync(binary)).toBe(true);

    const configDir = path.join(gateDir, "config");
    const dataDir = path.join(gateDir, "data");
    const cacheDir = path.join(gateDir, "cache");
    const stateDir = path.join(gateDir, "state");
    const stashDir = path.join(gateDir, "stash");
    const configPath = path.join(configDir, "config.json");
    const plistPath = path.join(nativeHome as string, "Library", "LaunchAgents", `com.akm.task.${id}.plist`);
    const target = nativeTarget(id as string);
    const restrictedPath =
      process.platform === "win32"
        ? [
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
            process.env.SystemRoot ?? "C:\\Windows",
          ].join(path.delimiter)
        : "/usr/bin:/bin:/usr/sbin:/sbin";
    expect(restrictedPath.split(path.delimiter)).not.toContain(path.dirname(binary));

    const env = withoutHarnessOverrides({
      HOME: nativeHome,
      AKM_STASH_DIR: stashDir,
      AKM_CONFIG_DIR: configDir,
      AKM_DATA_DIR: dataDir,
      AKM_CACHE_DIR: cacheDir,
      AKM_STATE_DIR: stateDir,
      PATH: restrictedPath,
      NO_COLOR: "1",
      CI: "true",
    });
    let ownsGateDir = false;
    let taskAdded = false;

    try {
      expect(fs.existsSync(gateDir), `Native gate directory must be unique: ${gateDir}`).toBe(false);
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(stashDir, { recursive: true });
      ownsGateDir = true;
      fs.writeFileSync(
        configPath,
        `${JSON.stringify({ configVersion: "0.9.0", stashDir, sources: [], semanticSearchMode: "off" })}\n`,
        { mode: 0o600 },
      );

      const version = run([binary, "--version"], env);
      expectSuccess(version, "native standalone candidate --version");
      expect(version.stdout).toContain(candidateVersion as string);

      const doctor = run([binary, "tasks", "doctor"], env);
      expectSuccess(doctor, "native standalone tasks doctor");
      expect(JSON.parse(doctor.stdout)).toMatchObject({ akm: { argv: [binary], via: "execPath" } });

      const add = run(
        [binary, "tasks", "add", id as string, "--schedule", "@daily", "--command", "akm --version"],
        env,
      );
      expectSuccess(add, "native tasks add");
      taskAdded = true;

      const installedXml =
        process.platform === "win32" ? run(["schtasks", "/Query", "/TN", target, "/XML"], env) : undefined;
      if (installedXml) expectSuccess(installedXml, "schtasks query before sync");
      const sync = run([binary, "tasks", "sync"], env);
      expectSuccess(sync, "native tasks sync after scheduler materialization");
      expect(JSON.parse(sync.stdout), installedXml?.stdout).toMatchObject({
        installed: [],
        updated: [],
        unchanged: [id],
      });

      const taskPath = path.join(stashDir, "tasks", `${id}.yml`);
      const originalTask = fs.readFileSync(taskPath);
      if (process.platform === "darwin") {
        const plist = fs.readFileSync(plistPath, "utf8");
        expect(plist).toContain(binary);
        expect(plist).toContain(`<string>${id}</string>`);
        expectSuccess(run(["launchctl", "kickstart", "-k", target], env), "launchctl kickstart");
      } else {
        const query = run(["schtasks", "/Query", "/TN", target, "/XML"], env);
        expectSuccess(query, "schtasks query generated XML");
        expect(query.stdout).toContain(binary);
        expectSuccess(run(["schtasks", "/Run", "/TN", target], env), "schtasks run");
      }

      const row = await waitForCompletedHistory((args) => run([binary, ...args], env), id as string);
      expect(row).toMatchObject({ status: "completed", detail: { exitCode: 0 } });
      expect(fs.readFileSync(row.log, "utf8")).toContain(candidateVersion as string);
      expect(fs.readFileSync(taskPath)).toEqual(originalTask);
    } finally {
      if (taskAdded) run([binary, "tasks", "remove", id as string], env);
      if (process.platform === "darwin") {
        run(["launchctl", "bootout", target], env);
        run(["launchctl", "enable", target], env);
        fs.rmSync(plistPath, { force: true });
      } else {
        run(["schtasks", "/End", "/TN", target], env);
        run(["schtasks", "/Delete", "/TN", target, "/F"], env);
      }
      fs.rmSync(path.join(stashDir, "tasks", `${id}.yml`), { force: true });
      if (ownsGateDir) fs.rmSync(gateDir, { recursive: true, force: true });
    }
  },
  180_000,
);

test.skipIf(!ENABLED || process.platform !== "win32")(
  "the packed npm launcher registers and runs its Node fallback with HOME absent and path spaces",
  async () => {
    const launcher = path.resolve(process.env.AKM_NATIVE_PACKED_BIN ?? "");
    const nodeBinary = path.resolve(process.env.AKM_NATIVE_NODE_BIN ?? "");
    const gateDir = path.resolve(process.env.AKM_NATIVE_NODE_GATE_DIR ?? "");
    const id = process.env.AKM_NATIVE_NODE_TASK_ID;
    const candidateVersion = process.env.AKM_CANDIDATE_VERSION;
    expect(process.env.AKM_NATIVE_PACKED_BIN, "AKM_NATIVE_PACKED_BIN must name the packed npm launcher").toBeTruthy();
    expect(process.env.AKM_NATIVE_NODE_BIN, "AKM_NATIVE_NODE_BIN must name the Node executable").toBeTruthy();
    expect(process.env.AKM_NATIVE_NODE_GATE_DIR, "AKM_NATIVE_NODE_GATE_DIR must isolate gate-owned files").toBeTruthy();
    expect(id, "AKM_NATIVE_NODE_TASK_ID must uniquely identify the packed scheduler artifact").toBeTruthy();
    expect(candidateVersion, "AKM_CANDIDATE_VERSION must name the packed artifact version").toBeTruthy();
    expect(id).toMatch(/^akm-ci-node-win32-[0-9]+-[0-9]+$/);
    expect(process.arch).toBe("x64");
    expect(launcher).toContain(" ");
    expect(gateDir).toContain(" ");
    expect(fs.existsSync(launcher)).toBe(true);
    expect(fs.existsSync(nodeBinary)).toBe(true);

    const configDir = path.join(gateDir, "config with spaces");
    const dataDir = path.join(gateDir, "data with spaces");
    const cacheDir = path.join(gateDir, "cache with spaces");
    const stateDir = path.join(gateDir, "state with spaces");
    const stashDir = path.join(gateDir, "stash with spaces");
    const configPath = path.join(configDir, "config.json");
    const target = nativeTarget(id as string);
    const restrictedPath = [
      path.dirname(launcher),
      path.dirname(nodeBinary),
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      process.env.SystemRoot ?? "C:\\Windows",
    ].join(path.delimiter);
    expect(restrictedPath.toLowerCase()).not.toContain("bun");

    const env = withoutHarnessOverrides({
      AKM_STASH_DIR: stashDir,
      AKM_CONFIG_DIR: configDir,
      AKM_DATA_DIR: dataDir,
      AKM_CACHE_DIR: cacheDir,
      AKM_STATE_DIR: stateDir,
      PATH: restrictedPath,
      NO_COLOR: "1",
      CI: "true",
    });
    delete env.HOME;
    expect(env.HOME).toBeUndefined();
    let ownsGateDir = false;
    let taskAdded = false;
    const runPackedCli = (args: string[]): RunResult => {
      const comspec = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const quotedArgs = args.map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ");
      return run([comspec, "/d", "/s", "/c", `""${launcher}" ${quotedArgs}"`], env, {
        windowsVerbatimArguments: true,
      });
    };

    try {
      expect(fs.existsSync(gateDir), `Native Node gate directory must be unique: ${gateDir}`).toBe(false);
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(stashDir, { recursive: true });
      ownsGateDir = true;
      fs.writeFileSync(
        configPath,
        `${JSON.stringify({ configVersion: "0.9.0", stashDir, sources: [], semanticSearchMode: "off" })}\n`,
        { mode: 0o600 },
      );

      const version = runPackedCli(["--version"]);
      expectSuccess(version, "packed Node candidate --version");
      expect(version.stdout).toContain(candidateVersion as string);

      const doctor = runPackedCli(["tasks", "doctor"]);
      expectSuccess(doctor, "packed Node tasks doctor");
      const doctorJson = JSON.parse(doctor.stdout) as { akm: { argv: string[]; via: string } };
      expect(fs.realpathSync(doctorJson.akm.argv[0])).toBe(fs.realpathSync(nodeBinary));
      expect(doctorJson.akm.argv[1]).toEndWith("cli-node.mjs");
      expect(doctorJson.akm).toMatchObject({ via: "execPath" });

      const add = runPackedCli(["tasks", "add", id as string, "--schedule", "@daily", "--command", "akm --version"]);
      expectSuccess(add, "packed Node tasks add");
      taskAdded = true;

      const taskPath = path.join(stashDir, "tasks", `${id}.yml`);
      const originalTask = fs.readFileSync(taskPath);
      const query = run(["schtasks", "/Query", "/TN", target, "/XML"], env);
      expectSuccess(query, "schtasks query packed Node XML");
      expect(query.stdout).toContain(nodeBinary);
      expect(query.stdout).toContain("cli-node.mjs");
      expect(query.stdout).toContain(" ");
      expectSuccess(run(["schtasks", "/Run", "/TN", target], env), "schtasks run packed Node task");

      const row = await waitForCompletedHistory(runPackedCli, id as string);
      expect(row).toMatchObject({ status: "completed", detail: { exitCode: 0 } });
      expect(fs.readFileSync(row.log, "utf8")).toContain(candidateVersion as string);
      expect(fs.readFileSync(taskPath)).toEqual(originalTask);
    } finally {
      if (taskAdded) runPackedCli(["tasks", "remove", id as string]);
      run(["schtasks", "/End", "/TN", target], env);
      run(["schtasks", "/Delete", "/TN", target, "/F"], env);
      fs.rmSync(path.join(stashDir, "tasks", `${id}.yml`), { force: true });
      if (ownsGateDir) fs.rmSync(gateDir, { recursive: true, force: true });
    }
  },
  240_000,
);
