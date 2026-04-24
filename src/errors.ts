/**
 * Typed error classes for structured exit code classification.
 *
 * - ConfigError  -> exit 78  (configuration / environment problems)
 * - UsageError   -> exit 2   (bad CLI arguments or invalid input)
 * - NotFoundError -> exit 1  (requested resource missing)
 *
 * Each error carries a machine-readable `code` field. Codes are stable
 * identifiers safe to consume from scripts and JSON output. Existing throw
 * sites without an explicit code receive a default code per error class so
 * older call sites continue to compile and behave unchanged.
 */

/** Stable, machine-readable codes for ConfigError. */
export type ConfigErrorCode =
  | "CONFIG_DIR_UNRESOLVABLE"
  | "STASH_DIR_NOT_FOUND"
  | "STASH_DIR_NOT_A_DIRECTORY"
  | "STASH_DIR_UNREADABLE"
  | "EMBEDDING_NOT_CONFIGURED"
  | "LLM_NOT_CONFIGURED"
  | "INVALID_CONFIG_FILE";

/** Stable, machine-readable codes for UsageError. */
export type UsageErrorCode =
  | "INVALID_FLAG_VALUE"
  | "UNKNOWN_CONFIG_KEY"
  | "INVALID_JSON_ARGUMENT"
  | "MISSING_REQUIRED_ARGUMENT"
  | "PATH_ESCAPE_VIOLATION"
  | "RESOURCE_ALREADY_EXISTS";

/** Stable, machine-readable codes for NotFoundError. */
export type NotFoundErrorCode = "ASSET_NOT_FOUND" | "STASH_NOT_FOUND" | "WORKFLOW_NOT_FOUND" | "FILE_NOT_FOUND";

/** Raised when configuration or environment is invalid or missing. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  constructor(msg: string, code: ConfigErrorCode = "INVALID_CONFIG_FILE") {
    super(msg);
    this.name = "ConfigError";
    this.code = code;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the user supplies invalid arguments or input. */
export class UsageError extends Error {
  readonly code: UsageErrorCode;
  constructor(msg: string, code: UsageErrorCode = "INVALID_FLAG_VALUE") {
    super(msg);
    this.name = "UsageError";
    this.code = code;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a requested resource (asset, entry, file) is not found. */
export class NotFoundError extends Error {
  readonly code: NotFoundErrorCode;
  constructor(msg: string, code: NotFoundErrorCode = "ASSET_NOT_FOUND") {
    super(msg);
    this.name = "NotFoundError";
    this.code = code;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
