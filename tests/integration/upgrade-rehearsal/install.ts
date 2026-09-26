// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Installs a packed `akm-cli` tarball into its own throwaway global npm
 * prefix and returns the verified launcher paths, reusing the same
 * install/verify machinery `tests/integration/install/package-install.test.ts`
 * exercises directly.
 */

import fs from "node:fs";
import path from "node:path";
import {
  type CommandRunner,
  installGlobalTarball,
  launcherExecutionCommand,
  runCommand,
  verifyGlobalInstall,
} from "../../../scripts/package-install";

const PACKAGE_NAME = "akm-cli";

export interface InstalledAkm {
  readonly prefix: string;
  readonly launcher: string;
  readonly migrateLauncher: string;
  readonly version: string;
}

/**
 * Install `tarball` under `<prefixRoot>/<label>` and verify it reports
 * `expectedVersion`.
 */
export async function installAkmTarball(
  tarball: string,
  prefixRoot: string,
  label: string,
  expectedVersion: string,
  runner: CommandRunner = runCommand,
): Promise<InstalledAkm> {
  const prefix = path.join(prefixRoot, label);
  fs.mkdirSync(prefix, { recursive: true });
  await installGlobalTarball(tarball, prefixRoot, prefix, runner);
  const verified = await verifyGlobalInstall(prefix, { name: PACKAGE_NAME, version: expectedVersion }, runner);
  return {
    prefix,
    launcher: verified.launchers.akm,
    migrateLauncher: verified.launchers["akm-migrate"],
    version: verified.version,
  };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run an installed launcher through the same platform-aware execution
 * command the install flow uses.
 *
 * MUST stay asynchronous (`Bun.spawn`, not `spawnSync`): several rehearsal
 * steps (website/npm bundle add) drive a launcher against a `Bun.serve`
 * fixture running IN this same process. A synchronous spawn blocks this
 * process's single event loop for the whole child lifetime, so the fixture
 * server can never accept the child's own connection — a self-deadlock that
 * only a real clock timeout would ever break.
 */
export async function runLauncher(
  launcher: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<RunResult> {
  const [command, ...commandArgs] = launcherExecutionCommand(launcher, args);
  const proc = Bun.spawn([command as string, ...commandArgs], {
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timedOut = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${commandArgs.join(" ")}`));
    }, timeoutMs).unref();
  });
  try {
    const [stdout, stderr, status] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      timedOut,
    ]);
    return { status, stdout, stderr };
  } catch (error) {
    return { status: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}
