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
 *
 * Each error also exposes a `hint()` method returning an actionable hint
 * string (or `undefined`). Hints can be supplied at construction time or
 * derived from the error `code` via the per-class default mapping below.
 * The CLI surfaces this via `error.hint()` rather than message-regex parsing.
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
  | "INVALID_SOURCE_VALUE"
  | "INVALID_FORMAT_VALUE"
  | "INVALID_DETAIL_VALUE"
  | "INVALID_JSON_CONFIG_VALUE"
  | "UNKNOWN_CONFIG_KEY"
  | "INVALID_JSON_ARGUMENT"
  | "MISSING_REQUIRED_ARGUMENT"
  | "MISSING_OR_AMBIGUOUS_TARGET"
  | "TARGET_NOT_UPDATABLE"
  | "PATH_ESCAPE_VIOLATION"
  | "RESOURCE_ALREADY_EXISTS";

/** Stable, machine-readable codes for NotFoundError. */
export type NotFoundErrorCode =
  | "ASSET_NOT_FOUND"
  | "STASH_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "WORKFLOW_NOT_FOUND"
  | "FILE_NOT_FOUND";

/**
 * Default hint for each ConfigError code. Keep these short, actionable, and
 * imperative. Returning undefined means "no canned hint".
 */
const CONFIG_HINTS: Partial<Record<ConfigErrorCode, string>> = {
  STASH_DIR_NOT_FOUND: "Run `akm init` to create the default stash, or set stashDir in your config.",
  STASH_DIR_NOT_A_DIRECTORY:
    "The configured stashDir exists but isn't a directory. Update stashDir to point at a folder.",
  STASH_DIR_UNREADABLE: "Check the path exists and your user has read permission, or update stashDir.",
  EMBEDDING_NOT_CONFIGURED: 'Run `akm config set embedding \'{"endpoint":"...","model":"..."}\'` to enable embeddings.',
  LLM_NOT_CONFIGURED: 'Run `akm config set llm \'{"endpoint":"...","model":"..."}\'` to configure the LLM.',
};

/** Default hint for each UsageError code. */
const USAGE_HINTS: Partial<Record<UsageErrorCode, string>> = {
  INVALID_SOURCE_VALUE: "Pick one of: stash, registry, both.",
  INVALID_FORMAT_VALUE: "Pick one of: json, jsonl, text, yaml.",
  INVALID_DETAIL_VALUE: "Pick one of: brief, normal, full, summary, agent.",
  INVALID_JSON_CONFIG_VALUE:
    'Quote JSON values in your shell, for example: akm config set embedding \'{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}\'.',
  MISSING_OR_AMBIGUOUS_TARGET: "Use `akm update --all` or pass a target like `akm update npm:@scope/pkg` (not both).",
  TARGET_NOT_UPDATABLE: "Run `akm list` to view your sources, then retry with one of those values.",
  MISSING_REQUIRED_ARGUMENT:
    "Refs use the form type:name, e.g. `akm show skill:deploy` or `akm show knowledge:guide.md`.",
};

/** Default hint for each NotFoundError code. */
const NOT_FOUND_HINTS: Partial<Record<NotFoundErrorCode, string>> = {
  SOURCE_NOT_FOUND: "Run `akm list` to view your sources, then retry with one of those values.",
};

/** Raised when configuration or environment is invalid or missing. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: ConfigErrorCode = "INVALID_CONFIG_FILE", hint?: string) {
    super(msg);
    this.name = "ConfigError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? CONFIG_HINTS[this.code];
  }
}

/** Raised when the user supplies invalid arguments or input. */
export class UsageError extends Error {
  readonly code: UsageErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: UsageErrorCode = "INVALID_FLAG_VALUE", hint?: string) {
    super(msg);
    this.name = "UsageError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? USAGE_HINTS[this.code];
  }
}

/** Raised when a requested resource (asset, entry, file) is not found. */
export class NotFoundError extends Error {
  readonly code: NotFoundErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: NotFoundErrorCode = "ASSET_NOT_FOUND", hint?: string) {
    super(msg);
    this.name = "NotFoundError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? NOT_FOUND_HINTS[this.code];
  }
}
