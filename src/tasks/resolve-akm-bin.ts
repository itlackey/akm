// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve the absolute invocation that the OS scheduler should run.
 *
 * cron / launchd / schtasks all execute jobs with a stripped environment and
 * a minimal PATH, so the registered command must be an absolute path.
 *
 * Resolution order:
 *
 *   1. `process.execPath` alone for a Bun standalone executable.
 *   2. Absolute Node plus the public `dist/akm` package launcher.
 *   3. Absolute runtime plus the source/build CLI entry of a checkout.
 *
 * `via` names which one was used. `checkout` — a package launcher inside a
 * git work tree, or a source/build entry — runs whatever the checkout holds
 * when the scheduler fires; `task sync` says so once when it writes one.
 *
 * Returns the argv array the scheduler should execute (e.g.
 * `["/usr/local/bin/node", "/usr/lib/node_modules/akm-cli/dist/akm"]`). The
 * caller appends subcommand args (`"task", "run", "<id>"`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../core/errors";
import { mainPath as runtimeMainPath } from "../runtime";

export interface ResolvedAkmInvocation {
  /** Argv prefix the OS scheduler should execute (one shell-safe path per element). */
  argv: string[];
  /** How the invocation was resolved, surfaced by `task doctor`. */
  via: "npm" | "standalone" | "checkout";
}

/** A source entry or local build run by a runtime: `src/cli.ts`, `dist/cli.js`, `dist/cli-node.mjs`. */
const CHECKOUT_ENTRY = /(?:^|[\\/])src[\\/]cli\.ts$|(?:^|[\\/])dist[\\/](?:cli\.js|cli-node\.mjs)$/i;

/** True only for Bun's virtual main path inside a compiled standalone executable. */
export function isBunStandaloneMain(mainPath: string | undefined = runtimeMainPath): boolean {
  return (
    mainPath?.startsWith("/$bunfs/") === true || (mainPath !== undefined && /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(mainPath))
  );
}

export function resolveAkmInvocation(
  options: {
    env?: NodeJS.ProcessEnv;
    cliEntryUrl?: string;
    runtime?: "bun" | "node";
    execPath?: string;
    mainPath?: string;
    launcherPath?: string;
    nodePath?: string;
  } = {},
): ResolvedAkmInvocation {
  const env = options.env ?? process.env;

  const runtime = options.runtime ?? (process.versions.bun ? "bun" : "node");
  const execPath = options.execPath ?? process.execPath;
  const mainPath = options.mainPath ?? runtimeMainPath;
  if (runtime === "bun" && isBunStandaloneMain(mainPath) && execPath) {
    return { argv: [absoluteInvocationPath(execPath)], via: "standalone" };
  }

  const launcherPath = options.launcherPath ?? env.AKM_LAUNCHER_PATH?.trim();
  const nodePath = options.nodePath ?? env.AKM_LAUNCHER_NODE?.trim() ?? (runtime === "node" ? execPath : undefined);
  if (launcherPath && nodePath && isPublicPackageLauncher(launcherPath)) {
    return {
      argv: [absoluteInvocationPath(nodePath), absoluteInvocationPath(launcherPath)],
      via: isCheckoutLauncher(launcherPath) ? "checkout" : "npm",
    };
  }

  const checkoutEntry = resolveCheckoutEntry(options.cliEntryUrl ?? import.meta.url, runtime, mainPath);
  if (checkoutEntry && execPath) {
    return { argv: [absoluteInvocationPath(execPath), absoluteInvocationPath(checkoutEntry)], via: "checkout" };
  }

  throw new ConfigError(
    "Cannot resolve absolute path to the akm binary for scheduler registration.",
    "INVALID_CONFIG_FILE",
    "Run the npm-global launcher or a standalone akm executable.",
  );
}

/** Whether an installed launcher argv runs akm out of a source checkout. */
export function isCheckoutInvocation(argv: readonly string[]): boolean {
  return argv.some((part) => CHECKOUT_ENTRY.test(part) || (isPublicPackageLauncher(part) && isCheckoutLauncher(part)));
}

function resolveCheckoutEntry(
  moduleUrl: string,
  runtime: "bun" | "node",
  mainPath: string | undefined,
): string | undefined {
  try {
    const modulePath = fileURLToPath(moduleUrl);
    const parent = path.dirname(path.dirname(modulePath));
    if (runtime === "node") {
      const wrapper = path.join(parent, "cli-node.mjs");
      if (fs.existsSync(wrapper)) return wrapper;
      if (mainPath) {
        if (path.basename(mainPath) === "cli-node.mjs" && fs.existsSync(mainPath)) return mainPath;
        const siblingWrapper = path.join(path.dirname(mainPath), "cli-node.mjs");
        if (fs.existsSync(siblingWrapper)) return siblingWrapper;
      }
      return undefined;
    }
    const extension = path.extname(modulePath);
    const candidate = path.join(parent, `cli${extension}`);
    if (fs.existsSync(candidate)) return candidate;
    const alternate = path.join(parent, extension === ".ts" ? "cli.js" : "cli.ts");
    return fs.existsSync(alternate) ? alternate : undefined;
  } catch {
    return runtime === "bun" ? mainPath : undefined;
  }
}

function absoluteInvocationPath(value: string): string {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ? value : path.resolve(value);
}

function isPublicPackageLauncher(file: string): boolean {
  return (
    path.basename(file).toLowerCase() === "akm" &&
    path.basename(path.dirname(file)).toLowerCase() === "dist" &&
    fs.existsSync(file)
  );
}

/** A package launcher whose package root is a git work tree (`npm link`, a local clone). */
function isCheckoutLauncher(file: string): boolean {
  let launcher = path.resolve(file);
  try {
    launcher = fs.realpathSync(file);
  } catch {
    // The caller gets a missing-path diagnostic from doctor.
  }
  const packageRoot = path.dirname(path.dirname(launcher));
  return fs.existsSync(path.join(packageRoot, ".git"));
}

/** `npm root --global` for the npm that ships with `nodePath`; `akm upgrade` uses it to detect a global install. */
export function resolveNpmGlobalRoot(nodePath: string, env: NodeJS.ProcessEnv): string | undefined {
  const npmCli = resolveAssociatedNpmCli(nodePath);
  if (!npmCli) return undefined;
  const result = spawnSync(absoluteInvocationPath(nodePath), [npmCli, "root", "--global"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0] || !path.isAbsolute(lines[0])) return undefined;
  return lines[0];
}

function resolveAssociatedNpmCli(nodePath: string): string | undefined {
  const nodeDirs = new Set([path.dirname(absoluteInvocationPath(nodePath))]);
  try {
    nodeDirs.add(path.dirname(fs.realpathSync(nodePath)));
  } catch {
    // The scheduler binding will separately report a missing Node path.
  }

  for (const binDir of nodeDirs) {
    const candidates = [
      ...(process.platform === "win32" ? [] : [path.join(binDir, "npm")]),
      path.join(binDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(path.dirname(binDir), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      try {
        const resolved = fs.realpathSync(candidate);
        if (fs.statSync(resolved).isFile()) return resolved;
      } catch {
        // Try the next layout associated with this Node installation.
      }
    }
  }
  return undefined;
}
