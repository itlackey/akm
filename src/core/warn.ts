// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Module-level quiet/verbose flags and optional file sink for stderr output.
 *
 * `quiet` is controlled by the CLI `--quiet`/`-q` flag.
 * `verbose` is controlled by the CLI `--verbose` flag, with `AKM_VERBOSE`
 * (env var) winning regardless: env > flag > default (false).
 *
 * Call `setLogFile(path)` to tee all warn/error/info output to a file in
 * addition to stderr. The file sink is written even when `--quiet` suppresses
 * console output, so logs remain available for post-run inspection.
 */

import fs from "node:fs";
import path from "node:path";

let quiet = false;
let verbose = false;
let logFilePath: string | undefined;

export function setQuiet(value: boolean): void {
  quiet = value;
}

/**
 * Reset the quiet flag to false.
 * Intended for test teardown to prevent quiet state from leaking between tests.
 */
export function resetQuiet(): void {
  quiet = false;
}

export function isQuiet(): boolean {
  return quiet;
}

/**
 * Set the verbose flag from a CLI flag. The `AKM_VERBOSE` env var, when set,
 * always wins regardless of this flag (env > flag > default).
 */
export function setVerbose(value: boolean): void {
  verbose = value;
}

/**
 * Reset the verbose flag to false. Intended for test teardown so verbose
 * state does not leak between tests.
 */
export function resetVerbose(): void {
  verbose = false;
}

/**
 * Returns true when verbose output is requested.
 *
 * Precedence: `AKM_VERBOSE` env var (when truthy) > `setVerbose(true)` > false.
 * Truthy matches `1`, `true`, `yes`, `on` (case-insensitive). The values
 * `0`, `false`, `no`, `off` hard-disable verbose even if the flag is set,
 * so operators can override per-invocation. Any other value (including
 * empty string) is treated as "not set" and falls through to the flag.
 */
export function isVerbose(): boolean {
  const env = process.env.AKM_VERBOSE?.trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes" || env === "on") return true;
  if (env === "0" || env === "false" || env === "no" || env === "off") return false;
  return verbose;
}

/**
 * Direct all warn/error/info output to `filePath` in addition to stderr.
 * The directory is created if it does not exist. Pass `undefined` to disable.
 * The file is written even when `--quiet` suppresses console output.
 */
export function setLogFile(filePath: string): void {
  logFilePath = filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function clearLogFile(): void {
  logFilePath = undefined;
}

export function getLogFile(): string | undefined {
  return logFilePath;
}

function appendToLogFile(level: "INFO" | "WARN" | "ERROR", args: unknown[]): void {
  if (!logFilePath) return;
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  try {
    fs.appendFileSync(logFilePath, `[${ts}] [${level}] ${msg}\n`);
  } catch (e) {
    // Log file write failed — emit directly to stderr so the message is not lost.
    process.stderr.write(`[akm:warn] log-file write failed (${logFilePath}): ${e}\n`);
    process.stderr.write(`[${ts}] [${level}] ${msg}\n`);
  }
}

/**
 * Emit an info/progress line to stderr unless --quiet is active.
 * Always written to the log file if one is active.
 * Use for progress counters and status lines (replaces console.error used for progress).
 */
export function info(...args: unknown[]): void {
  appendToLogFile("INFO", args);
  if (!quiet) {
    console.warn(...args);
  }
}

/**
 * Emit a warning to stderr unless --quiet is active.
 * Always written to the log file if one is active.
 * Drop-in replacement for console.warn() across the codebase.
 */
export function warn(...args: unknown[]): void {
  appendToLogFile("WARN", args);
  if (!quiet) {
    console.warn(...args);
  }
}

/**
 * Emit an error to stderr unless --quiet is active.
 * Always written to the log file if one is active.
 * Drop-in replacement for console.error() used for diagnostic failures.
 */
export function error(...args: unknown[]): void {
  appendToLogFile("ERROR", args);
  if (!quiet) {
    console.error(...args);
  }
}

/**
 * Emit a warning only when verbose output is requested. Use for noisy
 * per-item diagnostics that should be replaced by a one-line summary at
 * default verbosity (e.g. registry-content workflow validation errors).
 */
export function warnVerbose(...args: unknown[]): void {
  if (isVerbose()) {
    warn(...args);
  }
}
