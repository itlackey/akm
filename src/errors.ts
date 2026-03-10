/**
 * Typed error classes for structured exit code classification.
 *
 * - ConfigError  -> exit 78  (configuration / environment problems)
 * - UsageError   -> exit 2   (bad CLI arguments or invalid input)
 * - NotFoundError -> exit 1  (requested resource missing)
 */

/** Raised when configuration or environment is invalid or missing. */
export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "ConfigError"
  }
}

/** Raised when the user supplies invalid arguments or input. */
export class UsageError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "UsageError"
  }
}

/** Raised when a requested resource (asset, entry, file) is not found. */
export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "NotFoundError"
  }
}
