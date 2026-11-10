/**
 * CI-only acceptance for the real per-user launchd and Windows Task Scheduler
 * entry. The double opt-in prevents a developer from touching a live scheduler:
 * the explicit gate is rejected unless this is a disposable GitHub runner.
 *
 * The scenario is the one the design rests on, with nothing faked: `task enable`
 * installs the one entry; the OS itself runs `akm task dispatch` (kickstart /
 * `schtasks /Run`); dispatch starts a due task detached and exits; and that
 * task is still running after the OS reports dispatch finished, and completes.
 * A child the OS reaps with its parent would leave the history row `active` and
 * the marker unwritten, and this fails.
 *
 * `task sync` writes the OS scheduler only for the default installation, so
 * the gate runs with HOME (and, on Windows, the profile folders) deciding every
 * location, and cleans those directories up afterwards. That is safe because
 * the gate refuses to run anywhere but a disposable runner, and refuses to
 * start when akm already has a config there.
 *
 * To run it (macOS and Windows runners only; `.github/workflows/gated-ci.yml`,
 * job `Gated / Native Scheduler`, does exactly this):
 *   macOS:   bun scripts/build-standalone.ts --outfile $RUNNER_TEMP/akm-darwin --version <v>
 *            AKM_NATIVE_SCHEDULER_TESTS=1 AKM_NATIVE_TEST_BIN=... AKM_CANDIDATE_ARCH=<arch> AKM_CANDIDATE_VERSION=<v>
 *            AKM_NATIVE_HOME=$HOME AKM_NATIVE_GATE_DIR=<fresh dir> CI=true GITHUB_ACTIONS=true
 *            bun test --timeout=240000 tests/integration/native-scheduler.test.ts
 *   Windows: the same, plus the packed npm launcher variables the workflow sets (AKM_NATIVE_PACKED_BIN,
 *            AKM_NATIVE_NODE_BIN, AKM_NATIVE_NODE_GATE_DIR).
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir, getConfigDir, getDataDir, getStateDir } from "../../src/core/paths";

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
  const result = spawnSync(argv[0]!, argv.slice(1), {
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
    "AKM_BUNDLE_DIR",
    "AKM_CONFIG_DIR",
    "AKM_DATA_DIR",
    "AKM_CACHE_DIR",
    "AKM_STATE_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
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

/**
 * On Windows the profile folders decide every location, and the suite preload points them at its sandbox. Task
 * Scheduler starts `akm task dispatch` with the account's real profile, so the CLI children must use that same
 * profile (the runner's `AKM_NATIVE_HOME`, with the default `AppData` layout) for dispatch to find their config.
 */
function nativeProfile(nativeHome: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return {};
  return {
    USERPROFILE: nativeHome,
    APPDATA: path.join(nativeHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(nativeHome, "AppData", "Local"),
  };
}

/** The OS-side name of the one entry. */
function nativeTarget(): string {
  if (process.platform === "win32") return "\\akm\\dispatch";
  if (typeof process.getuid !== "function") throw new Error("launchd gate cannot resolve the current uid");
  return `gui/${process.getuid()}/com.akm.dispatch`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(500);
  }
  return check();
}

interface HistoryRow {
  status: string;
  startedAt: string;
  log: string;
  detail?: { exitCode?: number };
}

function history(cli: (args: string[]) => RunResult, id: string): HistoryRow[] {
  const result = cli(["task", "history", id, "--limit", "10"]);
  if (result.status !== 0) return [];
  return (JSON.parse(result.stdout) as { rows: HistoryRow[] }).rows.sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
}

/** Whether the OS reports the dispatch entry itself as running (the child it started is not the entry). */
function entryRunning(env: NodeJS.ProcessEnv): boolean {
  if (process.platform === "win32") {
    return run(["schtasks", "/Query", "/TN", nativeTarget(), "/FO", "CSV", "/NH"], env).stdout.includes("Running");
  }
  return /state = running/.test(run(["launchctl", "print", nativeTarget()], env).stdout);
}

function entryInstalled(env: NodeJS.ProcessEnv): boolean {
  if (process.platform === "win32") return run(["schtasks", "/Query", "/TN", nativeTarget()], env).status === 0;
  return run(["launchctl", "print", nativeTarget()], env).status === 0;
}

/**
 * The whole scenario against one launcher. `launcher` is what the entry must name (argv of akm, as `task doctor`
 * reports it); `cli` runs akm with the gate's environment.
 */
async function scenario(input: {
  cli: (args: string[]) => RunResult;
  env: NodeJS.ProcessEnv;
  gateDir: string;
  stashDir: string;
  id: string;
  /** Strings the OS-side definition of the entry must contain. */
  entryMentions: string[];
  nativeHome: string;
}): Promise<void> {
  const { cli, env, gateDir, stashDir, id } = input;
  const defaults = [getConfigDir(env), getDataDir(env), getCacheDir(env), getStateDir(env)];
  const marker = path.join(gateDir, "outlived.txt");
  const plistPath = path.join(input.nativeHome, "Library", "LaunchAgents", "com.akm.dispatch.plist");
  let enabled = false;
  try {
    for (const dir of defaults) {
      expect(fs.existsSync(dir), `the gate needs a runner with no akm state, found ${dir}`).toBe(false);
    }
    expect(entryInstalled(env), "no dispatch entry may exist before the gate installs it").toBe(false);
    fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
    fs.mkdirSync(getConfigDir(env), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(env), "config.json"),
      `${JSON.stringify({ bundles: { stash: { path: stashDir, writable: true } }, defaultBundle: "stash", semanticSearchMode: "off" })}\n`,
      { mode: 0o600 },
    );
    // Due every minute; runs for twelve seconds, so it is still going after dispatch has exited.
    // JSON.stringify is a valid YAML double-quoted scalar: backslashes in a Windows path stay literal.
    const command =
      process.platform === "win32"
        ? `Start-Sleep -Seconds 12; Set-Content -LiteralPath '${marker}' -Value outlived`
        : `sleep 12 && echo outlived > '${marker}'`;
    const body = `${process.platform === "win32" ? "shell: powershell\n" : ""}run: ${JSON.stringify(command)}`;
    fs.writeFileSync(path.join(stashDir, "tasks", `${id}.yml`), `version: 4\n${body}\nschedule: "* * * * *"\n`);

    // `enable` syncs the OS scheduler: the first enabled task installs the one entry, so a `sync` after it has nothing to do.
    const enable = cli(["task", "enable", `stash//tasks/${id}`]);
    expectSuccess(enable, "task enable");
    enabled = true;
    expect(JSON.parse(enable.stdout)).toMatchObject({ sync: { entry: "installed", removedLegacy: [] } });
    expect(entryInstalled(env)).toBe(true);
    const sync = cli(["task", "sync"]);
    expectSuccess(sync, "task sync");
    expect(JSON.parse(sync.stdout)).toMatchObject({ entry: "unchanged", removedLegacy: [] });
    const definition =
      process.platform === "win32"
        ? run(["schtasks", "/Query", "/TN", nativeTarget(), "/XML"], env).stdout
        : fs.readFileSync(plistPath, "utf8");
    for (const mention of input.entryMentions) expect(definition).toContain(mention);
    expect(definition).not.toContain(id);
    if (process.platform === "darwin") expect(definition).toContain("<key>AbandonProcessGroup</key>");

    // The OS runs the entry now, not at the next minute.
    expectSuccess(
      process.platform === "win32"
        ? run(["schtasks", "/Run", "/TN", nativeTarget()], env)
        : run(["launchctl", "kickstart", "-k", nativeTarget()], env),
      "start the entry through the OS",
    );

    // Dispatch started the task: its history row is reserved (active) while the task sleeps.
    expect(
      await waitFor(() => history(cli, id).some((row) => row.status === "active"), 90_000),
      "the task started",
    ).toBe(true);
    // The dispatch process has exited by then: the OS no longer reports the entry running, and the task still is.
    // (Checked before `disable`, which removes the entry and would make this vacuous.)
    expect(await waitFor(() => !entryRunning(env), 30_000), "the OS reports dispatch finished").toBe(true);
    expect(fs.existsSync(marker), "the task is still running after dispatch has exited").toBe(false);
    // From now on nothing else may start it; the run in flight is the one under test. Disabling the last enabled
    // task syncs the OS scheduler too, removing the entry, and the run in flight survives that.
    const disable = cli(["task", "disable", `stash//tasks/${id}`]);
    expectSuccess(disable, "task disable");
    enabled = false;
    expect(JSON.parse(disable.stdout)).toMatchObject({ sync: { entry: "removed" } });
    expect(entryInstalled(env), "disabling the last enabled task removes the entry").toBe(false);

    expect(await waitFor(() => fs.existsSync(marker), 60_000), "the detached task finished").toBe(true);
    expect(await waitFor(() => history(cli, id).every((row) => row.status !== "active"), 30_000)).toBe(true);
    const [first] = history(cli, id);
    expect(first).toMatchObject({ status: "completed", detail: { exitCode: 0 } });
    expect(fs.readFileSync(marker, "utf8")).toContain("outlived");
  } finally {
    if (enabled) cli(["task", "disable", `stash//tasks/${id}`]);
    // With nothing enabled, sync removes the entry (and `--rebind` makes no difference).
    cli(["task", "sync"]);
    if (process.platform === "win32") run(["schtasks", "/Delete", "/TN", nativeTarget(), "/F"], env);
    else {
      run(["launchctl", "bootout", nativeTarget()], env);
      run(["launchctl", "enable", nativeTarget()], env);
      fs.rmSync(plistPath, { force: true });
    }
    for (const dir of defaults) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(gateDir, { recursive: true, force: true });
  }
  expect(entryInstalled(env), "the entry is gone after cleanup").toBe(false);
}

test.skipIf(!ENABLED)(
  "the packaged standalone's dispatch entry runs through the native per-user scheduler, starts a detached task that outlives it, and is cleaned up",
  async () => {
    const binary = path.resolve(process.env.AKM_NATIVE_TEST_BIN ?? "");
    const candidateArch = process.env.AKM_CANDIDATE_ARCH;
    const nativeHome = process.env.AKM_NATIVE_HOME;
    const id = process.env.AKM_NATIVE_TASK_ID;
    const candidateVersion = process.env.AKM_CANDIDATE_VERSION;
    const gateDir = path.resolve(process.env.AKM_NATIVE_GATE_DIR ?? "");
    expect(process.env.AKM_NATIVE_TEST_BIN, "AKM_NATIVE_TEST_BIN must name the compiled artifact").toBeTruthy();
    expect(nativeHome, "AKM_NATIVE_HOME must preserve the runner's real home before bun test preload").toBeTruthy();
    expect(id, "AKM_NATIVE_TASK_ID must uniquely identify the gate's task").toBeTruthy();
    expect(candidateArch, "AKM_CANDIDATE_ARCH must name the compiled artifact architecture").toBeTruthy();
    expect(candidateVersion, "AKM_CANDIDATE_VERSION must name the compiled artifact version").toBeTruthy();
    expect(process.env.AKM_NATIVE_GATE_DIR, "AKM_NATIVE_GATE_DIR must isolate gate-owned files").toBeTruthy();
    expect(id).toMatch(new RegExp(`^akm-ci-${process.platform}-[0-9]+-[0-9]+$`));
    expect(candidateArch === process.arch).toBe(true);
    expect(fs.existsSync(binary)).toBe(true);
    expect(fs.existsSync(gateDir), `Native gate directory must be unique: ${gateDir}`).toBe(false);

    const restrictedPath =
      process.platform === "win32"
        ? [
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
            process.env.SystemRoot ?? "C:\\Windows",
          ].join(path.delimiter)
        : "/usr/bin:/bin:/usr/sbin:/sbin";
    expect(restrictedPath.split(path.delimiter)).not.toContain(path.dirname(binary));
    // The default installation: no AKM_* or XDG variable; HOME (and the runner's real Windows profile folders) decide every location.
    const env = withoutHarnessOverrides({
      ...nativeProfile(nativeHome as string),
      HOME: nativeHome,
      PATH: restrictedPath,
      NO_COLOR: "1",
      CI: "true",
    });
    const cli = (args: string[]) => run([binary, ...args], env);

    const version = cli(["--version"]);
    expectSuccess(version, "native standalone candidate --version");
    expect(version.stdout).toContain(candidateVersion as string);
    const doctor = cli(["task", "doctor"]);
    expectSuccess(doctor, "native standalone tasks doctor");
    expect(JSON.parse(doctor.stdout)).toMatchObject({ akm: { argv: [binary], via: "standalone" } });

    await scenario({
      cli,
      env,
      gateDir,
      stashDir: path.join(gateDir, "stash"),
      id: id as string,
      entryMentions: [binary],
      nativeHome: nativeHome as string,
    });
  },
  300_000,
);

test.skipIf(!ENABLED || process.platform !== "win32")(
  "the packed npm launcher's dispatch entry runs its Node fallback with HOME absent and path spaces, and its detached task outlives it",
  async () => {
    const launcher = path.resolve(process.env.AKM_NATIVE_PACKED_BIN ?? "");
    const nodeBinary = path.resolve(process.env.AKM_NATIVE_NODE_BIN ?? "");
    const gateDir = path.resolve(process.env.AKM_NATIVE_NODE_GATE_DIR ?? "");
    const nativeHome = process.env.AKM_NATIVE_HOME;
    const id = process.env.AKM_NATIVE_NODE_TASK_ID;
    const candidateVersion = process.env.AKM_CANDIDATE_VERSION;
    expect(process.env.AKM_NATIVE_PACKED_BIN, "AKM_NATIVE_PACKED_BIN must name the packed npm launcher").toBeTruthy();
    expect(process.env.AKM_NATIVE_NODE_BIN, "AKM_NATIVE_NODE_BIN must name the Node executable").toBeTruthy();
    expect(process.env.AKM_NATIVE_NODE_GATE_DIR, "AKM_NATIVE_NODE_GATE_DIR must isolate gate-owned files").toBeTruthy();
    expect(nativeHome, "AKM_NATIVE_HOME must preserve the runner's real profile before bun test preload").toBeTruthy();
    expect(id, "AKM_NATIVE_NODE_TASK_ID must uniquely identify the packed scheduler artifact").toBeTruthy();
    expect(candidateVersion, "AKM_CANDIDATE_VERSION must name the packed artifact version").toBeTruthy();
    expect(id).toMatch(/^akm-ci-node-win32-[0-9]+-[0-9]+$/);
    expect(process.arch).toBe("x64");
    expect(launcher).toContain(" ");
    expect(gateDir).toContain(" ");
    expect(fs.existsSync(launcher)).toBe(true);
    expect(fs.existsSync(nodeBinary)).toBe(true);
    expect(fs.existsSync(gateDir), `Native Node gate directory must be unique: ${gateDir}`).toBe(false);

    const restrictedPath = [
      path.dirname(launcher),
      path.dirname(nodeBinary),
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      process.env.SystemRoot ?? "C:\\Windows",
    ].join(path.delimiter);
    expect(restrictedPath.toLowerCase()).not.toContain("bun");

    // The CI workflow installs the packed tarball with `npm install --prefix
    // <installDir>`, which produces exactly the on-disk layout of an npm
    // GLOBAL install under that prefix (<prefix>\node_modules\akm-cli) — but
    // npm only *reports* that prefix as global when npm_config_prefix says
    // so. akm's own eligibility probe is `npm root --global` in the process
    // env, so exporting the prefix here is what makes this fixture a
    // faithful npm-global install by npm's own definition, rather than a
    // package-local one (via: "package-local", eligible: false).
    // launcher is <installDir>\node_modules\.bin\akm.cmd (gated-ci.yml), so
    // three dirnames reach the install prefix whose node_modules holds the
    // package. Pin that shape so the math fails loudly if the workflow's
    // launcher layout ever changes instead of silently deriving a wrong
    // prefix.
    expect(launcher.toLowerCase().endsWith(path.join("node_modules", ".bin", "akm.cmd"))).toBe(true);
    const npmGlobalPrefix = path.dirname(path.dirname(path.dirname(launcher)));
    // The default installation again: the profile folders decide every location, and HOME is absent.
    const env = withoutHarnessOverrides({
      ...nativeProfile(nativeHome as string),
      PATH: restrictedPath,
      npm_config_prefix: npmGlobalPrefix,
      NO_COLOR: "1",
      CI: "true",
    });
    delete env.HOME;
    expect(env.HOME).toBeUndefined();
    const cli = (args: string[]): RunResult => {
      const comspec = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const quotedArgs = args.map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ");
      return run([comspec, "/d", "/s", "/c", `""${launcher}" ${quotedArgs}"`], env, {
        windowsVerbatimArguments: true,
      });
    };

    const version = cli(["--version"]);
    expectSuccess(version, "packed Node candidate --version");
    expect(version.stdout).toContain(candidateVersion as string);
    const doctor = cli(["task", "doctor"]);
    expectSuccess(doctor, "packed Node tasks doctor");
    const doctorJson = JSON.parse(doctor.stdout) as { akm: { argv: string[]; via: string } };
    expect(fs.realpathSync(doctorJson.akm.argv[0]!)).toBe(fs.realpathSync(nodeBinary));
    expect(doctorJson.akm.argv[1]).toEndWith(path.join("dist", "akm"));
    expect(doctorJson.akm).toMatchObject({ via: "npm" });

    await scenario({
      cli,
      env,
      gateDir,
      stashDir: path.join(gateDir, "stash with spaces"),
      id: id as string,
      entryMentions: [nodeBinary, path.join("dist", "akm")],
      nativeHome: nativeHome as string,
    });
  },
  300_000,
);
