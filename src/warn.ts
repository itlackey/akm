/**
 * Module-level quiet flag for suppressing stderr warnings.
 * Controlled by the CLI --quiet / -q flag.
 */

let quiet = false;

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
 * Emit a warning to stderr unless --quiet is active.
 * Drop-in replacement for console.warn() across the codebase.
 */
export function warn(...args: unknown[]): void {
  if (!quiet) {
    console.warn(...args);
  }
}
