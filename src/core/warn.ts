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
/** Calls inside {@link withQuiet}; counted so overlapping calls cannot leave the flag flipped. */
let quietScopes = 0;
let verbose = false;
let logFilePath: string | undefined;

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore output-sink override. Inert in production; only tests call
// the setter (via tests/_helpers/seams.ts). When installed, the sink captures
// every info/warn/error/warnVerbose call BEFORE the quiet/verbose gates —
// matching the full-replacement semantics the old mock.module fakes had.
export type WarnSinkForTests = (level: "info" | "warn" | "error" | "warnVerbose", args: unknown[]) => void;

let sinkOverride: WarnSinkForTests | undefined;

/** TEST-ONLY. Swap the output sink; pass undefined to restore real output. */
export function _setWarnSinkForTests(fake?: WarnSinkForTests): void {
  sinkOverride = fake;
}

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
  return quiet || quietScopes > 0;
}

/**
 * Run `fn` with stderr diagnostics suppressed (the log file sink still
 * receives them), then restore. For in-process callers (`src/api.ts`) that
 * must stay silent without touching the host's `--quiet` state: a depth count
 * rather than save/restore of the flag keeps overlapping async calls correct.
 */
export async function withQuiet<T>(fn: () => Promise<T>): Promise<T> {
  quietScopes++;
  try {
    return await fn();
  } finally {
    quietScopes--;
  }
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
  if (sinkOverride) {
    sinkOverride("info", args);
    return;
  }
  appendToLogFile("INFO", args);
  if (!isQuiet()) {
    console.warn(...args);
  }
}

/**
 * Emit a warning to stderr unless --quiet is active.
 * Always written to the log file if one is active.
 * Drop-in replacement for console.warn() across the codebase.
 */
export function warn(...args: unknown[]): void {
  if (sinkOverride) {
    sinkOverride("warn", args);
    return;
  }
  appendToLogFile("WARN", args);
  if (!isQuiet()) {
    console.warn(...args);
  }
}

const warnedOnceKeys = new Set<string>();

/**
 * `warn()` at most once per process for a given `key`. For diagnostics that
 * would otherwise repeat on every read of the same bad row or value.
 */
export function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedOnceKeys.has(key)) return;
  warnedOnceKeys.add(key);
  warn(...args);
}

/** TEST-ONLY. Forget every `warnOnce` key so a test can re-trigger a warning. */
export function _resetWarnOnceForTests(): void {
  warnedOnceKeys.clear();
}

/**
 * Emit an error to stderr unless --quiet is active.
 * Always written to the log file if one is active.
 * Drop-in replacement for console.error() used for diagnostic failures.
 */
export function error(...args: unknown[]): void {
  if (sinkOverride) {
    sinkOverride("error", args);
    return;
  }
  appendToLogFile("ERROR", args);
  if (!isQuiet()) {
    console.error(...args);
  }
}

/**
 * Emit a warning only when verbose output is requested. Use for noisy
 * per-item diagnostics that should be replaced by a one-line summary at
 * default verbosity (e.g. registry-content workflow validation errors).
 */
export function warnVerbose(...args: unknown[]): void {
  if (sinkOverride) {
    sinkOverride("warnVerbose", args);
    return;
  }
  if (isVerbose()) {
    warn(...args);
  }
}
