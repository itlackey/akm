/**
 * Module-level quiet/verbose flags for stderr warning gating.
 *
 * `quiet` is controlled by the CLI `--quiet`/`-q` flag.
 * `verbose` is controlled by the CLI `--verbose` flag, with `AKM_VERBOSE`
 * (env var) winning regardless: env > flag > default (false).
 */

let quiet = false;
let verbose = false;

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
 * Emit a warning to stderr unless --quiet is active.
 * Drop-in replacement for console.warn() across the codebase.
 */
export function warn(...args: unknown[]): void {
  if (!quiet) {
    console.warn(...args);
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
