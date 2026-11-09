/**
 * The test side of "a test must never reach the developer's real akm data".
 *
 * Production akm no longer asks whether it is under a test (`NODE_ENV=test` in a shell changes nothing). The
 * protection lives here, installed by `tests/_preload.ts` for every `bun test` process:
 *
 *   1. `unsandboxedDirs(env)` resolves akm's config, data, cache and state directories with the production
 *      resolvers (`src/core/paths.ts`) for an environment, and names the ones that land outside the OS temp root.
 *      The preload checks `process.env` with it before and after every test.
 *   2. `installChildProcessGuard()` wraps `Bun.spawn` / `Bun.spawnSync` (which `node:child_process` runs on), so an
 *      akm child process started with an environment that resolves a directory outside the temp root, or that can
 *      reach the real scheduler binary (`crontab`, `launchctl`), is refused at spawn and recorded.
 *   3. `schedulerStubDir()` is a directory of stub `crontab` / `launchctl` the preload puts first on `PATH`, so a
 *      child that inherits it (the usual `env: { ...process.env }`) finds a stub, never the developer's crontab.
 *
 * A refusal is a thrown error and also a recorded violation; the preload fails the test in `afterEach` for a
 * recorded one, so a test that catches the thrown error still fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCacheDir, getConfigDir, getDataDir, getStateDir } from "../../src/core/paths";

const violations: string[] = [];

/** Violations recorded since the last call; the preload turns a non-empty list into a test failure. */
export function takeViolations(): string[] {
  return violations.splice(0, violations.length);
}

function record(message: string): never {
  violations.push(message);
  throw new Error(`[harness-safety] ${message}`);
}

const TMP_REAL: string = fs.realpathSync(os.tmpdir());

/** True when `target`, or its nearest existing ancestor, resolves under the OS temp root. */
export function isUnderTempRoot(target: string): boolean {
  let probe = path.resolve(target);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const real = fs.realpathSync(probe);
    return real === TMP_REAL || real.startsWith(TMP_REAL + path.sep);
  } catch {
    return false;
  }
}

/** The akm directories this environment resolves to outside the temp root, as `config=/path`. Empty is safe. */
export function unsandboxedDirs(env: NodeJS.ProcessEnv): string[] {
  const resolvers = { config: getConfigDir, data: getDataDir, cache: getCacheDir, state: getStateDir };
  const outside: string[] = [];
  for (const [name, resolve] of Object.entries(resolvers)) {
    let dir: string;
    try {
      dir = resolve(env);
    } catch {
      continue; // unresolvable (no HOME on Windows): akm itself refuses, nothing is reached
    }
    if (!isUnderTempRoot(dir)) outside.push(`${name}=${dir}`);
  }
  return outside;
}

// ── The scheduler binaries ─────────────────────────────────────────────────────

const SCHEDULER_BINARIES = ["crontab", "launchctl"] as const;

let stubDir: string | undefined;

/** A directory holding stub `crontab` and `launchctl` that read nothing and write nothing. Created once. */
export function schedulerStubDir(root: string): string {
  if (stubDir) return stubDir;
  const dir = path.join(root, "scheduler-stubs");
  fs.mkdirSync(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "-l" ]; then echo "no crontab for sandbox" >&2; exit 1; fi',
    'echo "the bun test harness stubs the OS scheduler; inject a backend or put a fake on PATH" >&2',
    "exit 1",
    "",
  ].join("\n");
  for (const name of SCHEDULER_BINARIES) fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  stubDir = dir;
  return dir;
}

function resolveOnPath(name: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The real scheduler binary `env`'s PATH would find, if any (anything outside the temp root is the developer's). */
function realSchedulerBinary(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of SCHEDULER_BINARIES) {
    const found = resolveOnPath(name, env.PATH);
    if (found && !isUnderTempRoot(found)) return found;
  }
  return undefined;
}

// ── The spawn guard ────────────────────────────────────────────────────────────

type SpawnArgs = [unknown, unknown?];

function commandOf(args: SpawnArgs): string[] {
  const first = args[0];
  if (Array.isArray(first)) return first.map(String);
  if (first && typeof first === "object" && Array.isArray((first as { cmd?: unknown }).cmd)) {
    return ((first as { cmd: unknown[] }).cmd ?? []).map(String);
  }
  return [];
}

function optionsOf(args: SpawnArgs): { env?: Record<string, string | undefined> } {
  const first = args[0];
  const options = Array.isArray(first) ? args[1] : first;
  return options && typeof options === "object" ? (options as { env?: Record<string, string | undefined> }) : {};
}

/** True for `bun src/cli.ts ...`, `node dist/cli.js ...` and a compiled `akm` binary. */
function isAkmInvocation(cmd: string[]): boolean {
  if (/^akm([-.]|$)/.test(path.basename(cmd[0] ?? ""))) return true;
  return cmd.slice(0, 4).some((part) => /^cli\.(ts|js|mjs)$/.test(path.basename(part)));
}

function checkSpawn(args: SpawnArgs): void {
  const cmd = commandOf(args);
  if (cmd.length === 0) return;
  const env = (optionsOf(args).env ?? process.env) as NodeJS.ProcessEnv;
  const schedulerCheck = process.platform !== "win32";

  const program = path.basename(cmd[0] ?? "");
  if (schedulerCheck && (SCHEDULER_BINARIES as readonly string[]).includes(program)) {
    const found = path.isAbsolute(cmd[0] ?? "") ? cmd[0] : resolveOnPath(program, env.PATH);
    if (found && !isUnderTempRoot(found)) {
      record(`a test ran the real scheduler binary ${found}; inject a backend or put a fake on PATH`);
    }
    return;
  }

  if (!isAkmInvocation(cmd)) return;
  const outside = unsandboxedDirs(env);
  if (outside.length > 0) {
    record(
      `a test started akm with an environment that resolves ${outside.join(", ")} outside the temp root; ` +
        "pass env: { ...process.env, ... } or set HOME and XDG_*_HOME to temp directories",
    );
  }
  const real = schedulerCheck ? realSchedulerBinary(env) : undefined;
  if (real) {
    record(
      `a test started akm with a PATH that reaches the real scheduler binary ${real}; ` +
        "keep the harness's PATH (env: { ...process.env, ... }) or put a fake first",
    );
  }
}

let installed = false;

/** Wrap `Bun.spawn` and `Bun.spawnSync`, which `node:child_process` also runs on. Idempotent. */
export function installChildProcessGuard(): void {
  if (installed) return;
  installed = true;
  const bun = Bun as unknown as Record<string, (...args: SpawnArgs) => unknown>;
  for (const name of ["spawn", "spawnSync"] as const) {
    const original = bun[name]!.bind(Bun);
    bun[name] = (...args: SpawnArgs) => {
      checkSpawn(args);
      return original(...args);
    };
  }
}
