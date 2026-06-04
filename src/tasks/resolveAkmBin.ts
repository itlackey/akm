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
 *   1. `$AKM_BIN` (explicit override; takes precedence everywhere).
 *   2. `process.execPath` + the resolved CLI script — works when running
 *      from a development checkout (`bun /repo/src/cli.ts`) and from a
 *      compiled install (`bun /opt/akm/dist/cli.js`).
 *   3. `which akm` / `where akm` — last resort when the binary is on PATH
 *      but neither override applies.
 *
 * Returns the argv array the scheduler should execute (e.g.
 * `["/usr/local/bin/bun", "/repo/dist/cli.js"]`). The caller appends
 * subcommand args (`"tasks", "run", "<id>"`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../core/errors";

export interface ResolvedAkmInvocation {
  /** Argv prefix the OS scheduler should execute (one shell-safe path per element). */
  argv: string[];
  /** Source of the resolution, surfaced by `tasks doctor`. */
  via: "AKM_BIN" | "execPath" | "which";
}

export function resolveAkmInvocation(
  options: { env?: NodeJS.ProcessEnv; cliEntryUrl?: string } = {},
): ResolvedAkmInvocation {
  const env = options.env ?? process.env;

  const override = env.AKM_BIN?.trim();
  if (override) {
    return { argv: [override], via: "AKM_BIN" };
  }

  const cliPath = resolveCliEntry(options.cliEntryUrl ?? import.meta.url);
  if (cliPath && process.execPath) {
    return { argv: [process.execPath, cliPath], via: "execPath" };
  }

  const whichBin = findOnPath("akm", env);
  if (whichBin) {
    return { argv: [whichBin], via: "which" };
  }

  throw new ConfigError(
    "Cannot resolve absolute path to the akm binary for scheduler registration.",
    "INVALID_CONFIG_FILE",
    "Set AKM_BIN to the absolute path of the akm binary, or ensure `akm` is on PATH.",
  );
}

/**
 * From the URL of a module inside `src/tasks/` figure out the CLI entry.
 *
 *   • dev      `…/src/tasks/resolveAkmBin.ts`   → `…/src/cli.ts`
 *   • build    `…/dist/tasks/resolveAkmBin.js`  → `…/dist/cli.js`
 */
function resolveCliEntry(moduleUrl: string): string | undefined {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return undefined;
  }
  const dir = path.dirname(modulePath); // .../tasks
  const parent = path.dirname(dir); // .../src or .../dist
  const ext = path.extname(modulePath); // .ts | .js
  const candidate = path.join(parent, `cli${ext}`);
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: try the other extension.
  const alt = path.join(parent, ext === ".ts" ? "cli.js" : "cli.ts");
  if (fs.existsSync(alt)) return alt;
  return undefined;
}

function findOnPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const out = spawnSync(tool, [bin], { encoding: "utf8", env });
    if (out.status === 0 && typeof out.stdout === "string") {
      const first = out.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  } catch {
    // ignore — caller will throw a ConfigError
  }
  return undefined;
}
