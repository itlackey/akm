/**
 * Module-level quiet flag for suppressing stderr warnings.
 * Controlled by the CLI --quiet / -q flag.
 */

let quiet = false

export function setQuiet(value: boolean): void {
  quiet = value
}

export function isQuiet(): boolean {
  return quiet
}

/**
 * Emit a warning to stderr unless --quiet is active.
 * Drop-in replacement for console.warn() across the codebase.
 */
export function warn(...args: unknown[]): void {
  if (!quiet) {
    console.warn(...args)
  }
}
