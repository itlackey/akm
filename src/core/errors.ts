// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Typed error classes for structured exit code classification.
 *
 * - ConfigError    -> exit 78  (configuration / environment problems)
 * - UsageError     -> exit 2   (bad CLI arguments or invalid input)
 * - NotFoundError  -> exit 1   (requested resource missing)
 * - TransientError -> exit 75  (sysexits EX_TEMPFAIL — retry shortly; another
 *                                akm process holds a lock or is writing
 *                                state.db right now, not a bad command line)
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
  // The index/state database exists (or may exist) but this process cannot read
  // it — a permission or ownership mismatch, not a missing index. Distinct from
  // "not built yet" precisely so a read can fail loudly instead of returning an
  // empty-but-successful result for an index that is sitting right there (#791).
  | "DATA_DIR_UNREADABLE"
  | "INDEX_SCHEMA_INCOMPATIBLE"
  | "EMBEDDING_NOT_CONFIGURED"
  | "LLM_NOT_CONFIGURED"
  | "INVALID_CONFIG_FILE"
  | "UNSUPPORTED_CONFIG_VERSION"
  | "UNKNOWN_IMPROVE_STRATEGY"
  | "DANGEROUS_ENV_AUDIT_FAILED"
  | "EXECUTION_NOT_AUTHORIZED"
  // Refused stashDir that would clobber a sensitive system path or the user's
  // home directory (#473). Triggered by `akm bundle create`/`akm setup` when the
  // explicit `--dir` argument resolves to e.g. `/`, `$HOME`, `~/.config`,
  // `/etc`, etc.
  | "UNSAFE_STASH_DIR"
  // Defense-in-depth sentinel raised under `bun test` / NODE_ENV=test
  // when a test sets AKM_BUNDLE_DIR but forgets to also point
  // XDG_DATA_HOME / AKM_DATA_DIR (and XDG_STATE_HOME / AKM_STATE_DIR)
  // at temp directories. See src/core/paths.ts.
  | "TEST_ISOLATION_MISSING"
  // The host platform/architecture has no supported build for a requested
  // binary operation (e.g. `akm upgrade` on an unreleased platform target).
  | "UNSUPPORTED_PLATFORM"
  // `akm upgrade` refused: the environment blocks the upgrade (version
  // contract, filesystem permissions, or leftover upgrade state). The error
  // message carries the specific remediation.
  | "UPGRADE_BLOCKED"
  // A `secret://<name>` apiKey reference did not resolve to a stored value —
  // the named secret does not exist, or no store-backed resolver was wired at
  // the call site.
  | "SECRET_REFERENCE_UNRESOLVED"
  // units-repository's searchUnits: sqlite-vec is not loaded, so the units_vec
  // KNN query cannot run. There is no JS-cosine fallback for units — the
  // caller is expected to catch this and fall back to lexical search instead
  // (docs/plans/index-fragment-vectors.md).
  | "EMBEDDING_VEC_UNAVAILABLE";

/** Stable, machine-readable codes for UsageError. */
export type UsageErrorCode =
  | "INVALID_FLAG_VALUE"
  | "INVALID_SOURCE_VALUE"
  | "INVALID_FORMAT_VALUE"
  | "INVALID_DETAIL_VALUE"
  | "INVALID_SHAPE_VALUE"
  | "INVALID_JSON_CONFIG_VALUE"
  | "UNKNOWN_CONFIG_KEY"
  | "INVALID_JSON_ARGUMENT"
  | "MISSING_REQUIRED_ARGUMENT"
  | "MISSING_OR_AMBIGUOUS_TARGET"
  | "TARGET_NOT_UPDATABLE"
  | "PATH_ESCAPE_VIOLATION"
  | "RESOURCE_ALREADY_EXISTS"
  | "TASK_SCHEMA_VERSION_UNSUPPORTED"
  | "WORKFLOW_IR_VERSION_UNSUPPORTED"
  | "INVALID_PROPOSAL"
  | "NON_INTERACTIVE_REQUIRES_YES"
  // citty's own CLIError (unknown top-level command or subcommand), reclassified
  // by src/cli.ts so it flows through the same JSON envelope as every other
  // usage error instead of citty's raw usage-banner + console.error path.
  | "UNKNOWN_COMMAND"
  // A flag the resolved command does not declare. citty (node:util parseArgs,
  // strict: false) silently ignores these, so a typo used to parse
  // "successfully" and exit 0 — a `--fail-on-flaged`
  // in CI meant the gate never fired.
  | "UNKNOWN_FLAG"
  // P1a (docs/plans/specs/p1a-with-rejection-classifier.md §2.1, D7): a
  // workflow step authors with: on a target that cannot bind it. The
  // authored mapping used to be silently dropped at freeze; now it is
  // rejected instead (the fail-closed correction). P2b
  // (docs/plans/specs/p2b-input-bindings.md §1.7 A-N5) narrows this to a
  // tasks/<ref> target that declares no inputs: at all, and grows it to
  // commands/<ref> and scripts/<ref> targets, which are never binding
  // surfaces. Thrown from src/workflows/freeze/targets/task.ts's
  // taskDispatch and src/workflows/freeze/resolve-steps.ts's resolveStep.
  | "COMPOSITION_INVALID"
  // P1a: the sourceError funnel in src/tasks/source-v3.ts, re-coded from
  // INVALID_FLAG_VALUE. Message text, field-path rendering (`$` for the
  // empty path), and the file:line location string are unchanged.
  | "TASK_SOURCE_INVALID"
  // P1a: src/execution/target-ref.ts's classifyTargetRef rejects any value
  // that is not a canonical commands/, scripts/, tasks/, or workflows/ asset
  // ref (fragments, malformed shapes, non-canonical spellings, other asset
  // families, GitHub locators, etc).
  | "TARGET_REF_INVALID"
  // P1a: declared only in this phase — wired to workflow source validation
  // (e.g. `akm workflow validate`) in a later phase.
  | "WORKFLOW_SOURCE_INVALID"
  // P1a: declared only in this phase — wired in P2b when with: bindings are
  // validated against a target's declared inputs.
  | "INPUT_BINDING_INVALID"
  // P1b (docs/plans/specs/p1b-model-extraction.md, diagnostic-codes ratchet
  // remedy): originated in the now-deleted src/tasks/source/parse-v3-adapter.ts's
  // taskDefinitionFromV3, which rejected a validly-parsed task-v3 `uses:`
  // kind (builtin-command) that had no representation in P1b's closed
  // TaskDefinitionTarget vocabulary. Distinct from INVALID_FLAG_VALUE: the
  // input is not malformed, it is a recognized construct the target model
  // does not model. The code and its hint survive that adapter's P4 deletion
  // (spec docs/plans/specs/p4-deletions-closeout.md §3.2.7); §5.2 gives it a
  // live consumer in `prepare/script-capture.ts`'s interpreter rejections
  // (a later commit in this same phase — not yet wired as of this file).
  | "TASK_TARGET_UNSUPPORTED"
  // P3b (docs/plans/specs/p3b-child-executor.md §4.3, B-N13): a declared
  // `outputs:` entry could not be resolved at run completion — a missing
  // reference, a truncated source artifact, or a schema violation. Thrown
  // from `completeWorkflowStep`'s write transaction, which SQLite rolls back
  // whole: the step stays pending, the run stays active, fail-before-mutation
  // preserved.
  | "WORKFLOW_OUTPUT_INVALID";

/**
 * Stable, machine-readable codes for TransientError — a retryable-shortly
 * signal distinct from every UsageError code (#948 addendum, dev-team field
 * review 2026-09-09): schedulers classify exit 2 as "fix the command line",
 * but these two conditions mean "try again in a few seconds", a different
 * contract a cron wrapper or scheduler can branch on.
 */
export type TransientErrorCode =
  // A run's single-driver engine lease (R2) is live and held by another
  // engine invocation — refusing to acquire it (`akm workflow run` racing an
  // in-flight one) or to advance its step spine manually (`akm workflow
  // complete` racing the engine). Moved off UsageError by the #948 addendum:
  // a held lease is not a bad command line, it is ordinary contention a
  // caller can retry once the named expiry passes.
  | "RUN_LEASE_HELD"
  // #948: `withImmediateTransaction`/`beginImmediateTransaction`
  // (src/core/state-db.ts) exhausted every BEGIN IMMEDIATE retry attempt and
  // the failure is still contention-shaped (`isSqliteContentionError`) —
  // another akm process is writing state.db right now, not a genuine
  // corruption/unrelated failure. The original driver error survives as
  // `cause`.
  | "STATE_DB_CONTENDED"
  // Field follow-up to #956 (dev-team field review 2026-09-10): a
  // concurrent `akm index` (or any other writer touching index.db — source
  // add/update, the implicit per-command background reindex) can make a
  // rebuild's write hit the same contention-shaped SQLite condition
  // `isSqliteContentionError` already classifies for state.db, but index.db
  // writes had no reclassification boundary of their own — the raw driver
  // error ("database is locked") escaped `akmIndex` as exit 70
  // (internal/unclassified) instead of this "retry shortly" contract.
  // Thrown from `akmIndex`'s outer catch (src/indexer/indexer.ts), the one
  // function every caller goes through, for a contention-shaped error
  // escaping the walk, index, or embedding phase. The original driver error
  // survives as `cause`.
  | "INDEX_DB_CONTENDED"
  // Field follow-up to #956 (G1, dev-team field review 2026-09-10): two real
  // concurrent akm processes (e.g. two plain `akm index` runs started back
  // to back by a scheduler) can both reach `acquireMaintenanceBarrier()` —
  // the short critical section that registers a long-lived AKM lock, lease,
  // or state activity (canonical state.db's own open registers one; so did
  // the opt-in index rebuild lock, before index-redesign deleted that
  // consumer) — in the same instant. The barrier is meant to be held for
  // milliseconds, so losing that race is ordinary contention, never a
  // broken config file:
  // previously this threw `ConfigError("INVALID_CONFIG_FILE")`, surfacing
  // as exit 78 and telling a supervisor to stop retrying a normal lock
  // collision. Thrown from `acquireMaintenanceBarrier`
  // (src/core/maintenance-barrier.ts) once its own brief backoff-and-retry
  // window is exhausted.
  | "MAINTENANCE_BARRIER_BUSY"
  // Field follow-up to #948 (dev-team field review 2026-09-10): the
  // `akm improve` whole-run lock (`commands/improve/locks.ts`) is ordinary
  // contention between two legitimate `improve` invocations — the same
  // "config error is not the right label for a timing collision" shape #956
  // fixed for the index rebuild lock and the maintenance-start barrier. It
  // previously threw `ConfigError("INVALID_CONFIG_FILE")`, surfacing as
  // exit 78 and telling a supervisor to stop retrying a normal lock
  // collision. Thrown from `tryAcquireImproveLockUnlocked` when the lock is
  // held by a live PID and `--skip-if-locked` was not passed.
  | "IMPROVE_LOCK_HELD";

/** Stable, machine-readable codes for NotFoundError. */
export type NotFoundErrorCode =
  | "ASSET_NOT_FOUND"
  | "STASH_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "WORKFLOW_NOT_FOUND"
  | "PROPOSAL_NOT_FOUND"
  | "DANGEROUS_ENV_KEY"
  | "FILE_NOT_FOUND"
  | "IMPROVE_RUN_NOT_FOUND";

/**
 * Default hint for each ConfigError code. Keep these short, actionable, and
 * imperative. Returning undefined means "no canned hint".
 */
const CONFIG_HINTS: Partial<Record<ConfigErrorCode, string>> = {
  STASH_DIR_NOT_FOUND: "Run `akm setup` to create and configure your bundle, or configure a defaultBundle path.",
  STASH_DIR_NOT_A_DIRECTORY:
    "The configured default bundle path exists but isn't a directory. Update it to point at a folder.",
  STASH_DIR_UNREADABLE: "Check the path exists and your user has read permission, or update the default bundle path.",
  DATA_DIR_UNREADABLE:
    "The data directory is not readable by the user running akm. Check its owner and mode, or point AKM_DATA_DIR / XDG_DATA_HOME somewhere this user owns.",
  INDEX_SCHEMA_INCOMPATIBLE:
    "Run `akm index --full` to rebuild the derived index from the currently materialized sources.",
  EMBEDDING_NOT_CONFIGURED: 'Run `akm config set embedding \'{"endpoint":"...","model":"..."}\'` to enable embeddings.',
  LLM_NOT_CONFIGURED:
    'Run `akm setup` or configure an `engines` entry with `kind: "llm"`, then select it with `defaults.llmEngine`.',
  TEST_ISOLATION_MISSING:
    "Under bun test, when AKM_BUNDLE_DIR is set you MUST also set XDG_DATA_HOME (or AKM_DATA_DIR) and XDG_STATE_HOME (or AKM_STATE_DIR) to temp directories so the test does not touch the developer's real ~/.local/share/akm or ~/.local/state/akm.",
  UNSAFE_STASH_DIR:
    "Choose a path inside your home directory (e.g. ~/akm) or another empty workspace. The bundle directory cannot be the filesystem root, your home directory itself, or a sensitive system path like /etc, /var, ~/.config, or ~/.ssh.",
  UNKNOWN_IMPROVE_STRATEGY:
    "Pass one of the listed strategy names to `--strategy`, or define it under `improve.strategies`. Names are case-sensitive.",
  EXECUTION_NOT_AUTHORIZED: "Change the selected tools or update the machine/user execution policy, then retry.",
  SECRET_REFERENCE_UNRESOLVED:
    "Check the secret exists (`akm secret list`) and the name after `secret://` matches, or run `akm secret set <name> <value>` to store it.",
  EMBEDDING_VEC_UNAVAILABLE:
    "Install sqlite-vec for unit-level semantic search, or rely on lexical search until it is available.",
};

// Code-review finding: COMPOSITION_INVALID covers several unrelated causes
// (a rejected with:, a multi-job source, a composition cycle/depth/size
// violation, an invalid child-output reference). USAGE_HINTS below carries
// only the with:-rejection text — accurate for every with:-rejection throw
// site (none of which pass an explicit constructor hint), but wrong for the
// others. Those throw sites pass their OWN explicit hint (the constructor's
// 3rd argument overrides USAGE_HINTS, per errors-usage-hints.test.ts's
// "explicit constructor hint still overrides the USAGE_HINTS default").
// Multi-job rejection is thrown from 5 separate call sites across
// src/tasks/prepare/prepare-support.ts and src/workflows/**, so its hint is
// centralized here as the one shared string all 5 import, rather than
// duplicated at each site and risking drift.
export const COMPOSITION_INVALID_MULTI_JOB_HINT =
  "AKM workflows support exactly one job per source, with no needs: between jobs. Split the extra job(s) into " +
  "their own workflow file, and compose them with uses: workflows/<ref> instead.";

/** Default hint for each UsageError code. */
const USAGE_HINTS: Partial<Record<UsageErrorCode, string>> = {
  INVALID_FLAG_VALUE: "Run `akm <command> --help` to see accepted values.",
  INVALID_SOURCE_VALUE: "Pick one of: local, registry, all, or a configured source name.",
  INVALID_FORMAT_VALUE: "Pick one of: json, jsonl, yaml, text, md, html.",
  INVALID_DETAIL_VALUE: "Pick one of: brief, normal, full. For agent/summary projections use --shape.",
  INVALID_SHAPE_VALUE:
    "Pick one of: human, agent, summary (summary falls back to agent, with a warning, on commands with no summary projection).",
  INVALID_JSON_CONFIG_VALUE:
    'Quote JSON values in your shell, for example: akm config set embedding \'{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}\'.',
  MISSING_OR_AMBIGUOUS_TARGET:
    "Use `akm bundle update --all` or pass a target like `akm bundle update npm:@scope/pkg` (not both).",
  TARGET_NOT_UPDATABLE: "Run `akm bundle list` to view your sources, then retry with one of those values.",
  MISSING_REQUIRED_ARGUMENT:
    "Refs use the form [bundle//]conceptId, e.g. `akm show knowledge/guide.md` or `akm show skills/deploy`.",
  UNKNOWN_COMMAND: "Run `akm --help` to see available commands.",
  UNKNOWN_FLAG: "Run the command with `--help` to see its accepted flags.",
  // P2b (docs/plans/specs/p2b-input-bindings.md §1.7 A-N5, §7 F-A3): the
  // "arrives in a later 0.9.x release" promise is gone now that task-call
  // inputs are implemented. Names the two real rejection causes instead:
  // (1) a task target that declares no inputs: at all, (2) commands/<ref> /
  // scripts/<ref>, which are never binding surfaces. F-A3 authorizes this
  // edit and the matching pinned-string update in
  // tests/core/errors-usage-hints.test.ts in the same commit.
  //
  // Code-review finding: this default is reached ONLY by with:-rejection
  // throw sites (the ones above, plus task.ts's noDeclaredInputsError and
  // resolve-steps.ts's rejectNonTaskBindingWith) — every other
  // COMPOSITION_INVALID throw site (multi-job source, composition
  // cycle/depth/size, invalid child-output reference, an env: on a
  // composing step) passes its own explicit constructor hint instead of
  // falling through to this text, so this stays scoped and accurate rather
  // than generalized into something vaguer.
  COMPOSITION_INVALID:
    "Remove the with: block, or target a tasks/<ref> whose source declares inputs: — commands/<ref> and scripts/<ref> steps are not binding surfaces.",
  TASK_SOURCE_INVALID: "Fix the task source at the reported path and line, then re-run.",
  TARGET_REF_INVALID:
    "Targets are canonical asset refs: `commands/review`, `scripts/build.sh`, `tasks/nightly`, `workflows/release`.",
  // P4 (docs/plans/specs/p4-deletions-closeout.md §4.1, row B-53, R-R5): the
  // original hint named `akm workflow validate`, a verb that was never
  // implemented. Points at the two verbs that actually inspect a workflow
  // source without executing it.
  WORKFLOW_SOURCE_INVALID:
    "Run `akm lint` to see the failing source location, or `akm workflow plan <ref>` to compile it without writing.",
  INPUT_BINDING_INVALID: "Check the step's with: keys against the target's declared inputs.",
  TASK_TARGET_UNSUPPORTED:
    "Task definitions support command, script, workflow, and shell (run:) targets; akm/command is layered by callers.",
  // P3a (docs/plans/specs/p3a-plan-v5-child-freeze.md §3.2, A-N2): the
  // complete-or-abandon policy for a stored pre-irVersion-5 run.
  WORKFLOW_IR_VERSION_UNSUPPORTED:
    "Abandon the run with `akm workflow abandon <id>`, then start it again from the workflow source — a frozen plan this akm cannot execute is not re-executable in place.",
  // P3b (docs/plans/specs/p3b-child-executor.md §4.3).
  WORKFLOW_OUTPUT_INVALID:
    "Check each `outputs:` entry's `from:` against the step artifact it names, and its `schema:` against the value that step actually promotes.",
};

/** Default hint for each TransientErrorCode. */
const TRANSIENT_HINTS: Partial<Record<TransientErrorCode, string>> = {
  RUN_LEASE_HELD:
    "Wait for the named engine invocation to finish or for the lease to expire, then retry. `akm workflow status <id>` shows the current lease.",
  STATE_DB_CONTENDED:
    "Another akm process is writing state.db right now. Wait a few seconds and retry; commands that support --skip-if-locked can skip instead of failing.",
  INDEX_DB_CONTENDED:
    "Another akm process is writing index.db right now. Wait a few seconds and retry — index runs take no rebuild " +
    "lock, so this clears quickly; a scheduled run left alone will simply run again next time.",
  MAINTENANCE_BARRIER_BUSY:
    "Another akm process is registering a lock or lease right now. Retry shortly, or pass --skip-if-locked on " +
    "scheduled improve runs to skip gracefully instead — workflow run does not treat this code as skippable.",
  IMPROVE_LOCK_HELD:
    "Another akm improve run holds the whole-run lock right now. Wait for it to finish and retry, or pass --skip-if-locked on scheduled runs.",
};

/** Default hint for each NotFoundError code. */
const NOT_FOUND_HINTS: Partial<Record<NotFoundErrorCode, string>> = {
  ASSET_NOT_FOUND: "Run `akm search <query>` or `akm index` to refresh the index.",
  SOURCE_NOT_FOUND: "Run `akm bundle list` to view your sources, then retry with one of those values.",
  WORKFLOW_NOT_FOUND: "Run `akm workflow list --active` to see runs.",
  // A proposal is addressed by id or ref, never by path — reusing
  // FILE_NOT_FOUND here handed users "check the path exists and is readable"
  // for a mistyped id, which points at the wrong thing entirely.
  PROPOSAL_NOT_FOUND: "Run `akm proposal list` to see pending proposals and their ids.",
  FILE_NOT_FOUND: "Check the path exists and is readable.",
  IMPROVE_RUN_NOT_FOUND:
    "Run `akm improve` first, or `akm improve report --since 30d` to see recent run ids in `runIds`.",
};

/**
 * Discriminant identifying which concrete akm error class an instance is,
 * independent of `instanceof` (which can break across realm / bundle
 * boundaries). `classifyExitCode` switches exhaustively on this `kind`, so
 * adding a new error class forces a compile-time error at the switch until a
 * case is added — there is no silent `default` fall-through to a wrong code.
 */
export type AkmErrorKind = "config" | "usage" | "not-found" | "transient";

/**
 * Base class for all akm-thrown, classified errors. Carries the `kind`
 * discriminant consumed by the CLI exit-code classifier. Errors that are NOT
 * instances of `AkmError` are treated as genuinely unexpected (INTERNAL).
 */
export abstract class AkmError extends Error {
  abstract readonly kind: AkmErrorKind;
  /** Stable, machine-readable code surfaced in the JSON error envelope. */
  abstract readonly code: string;
  /** Actionable hint string, or undefined when none applies. */
  abstract hint(): string | undefined;
}

/** Raised when configuration or environment is invalid or missing. */
export class ConfigError extends AkmError {
  readonly kind = "config" as const;
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
export class UsageError extends AkmError {
  readonly kind = "usage" as const;
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

/**
 * Raised when a condition is ordinary, retryable contention rather than a
 * bad command line or a genuine failure — another akm process holds a lock
 * or is writing state.db right now. Distinct from `UsageError` (#948
 * addendum, dev-team field review 2026-09-09): schedulers classify exit 2 as
 * "fix the command line", so contention needs its own exit code (75,
 * sysexits EX_TEMPFAIL) a cron wrapper can branch on to retry instead of
 * alerting.
 */
export class TransientError extends AkmError {
  readonly kind = "transient" as const;
  readonly code: TransientErrorCode;
  private readonly _hint?: string;
  constructor(msg: string, code: TransientErrorCode, hint?: string) {
    super(msg);
    this.name = "TransientError";
    this.code = code;
    this._hint = hint;
    // Fixes `instanceof` checks under ES5 transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return this._hint ?? TRANSIENT_HINTS[this.code];
  }
}

/** Raised when a requested resource (asset, entry, file) is not found. */
export class NotFoundError extends AkmError {
  readonly kind = "not-found" as const;
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

/**
 * Test-isolation guard helper.
 *
 * `src/core/paths.ts` throws `ConfigError("TEST_ISOLATION_MISSING")` under
 * `bun test` when `AKM_BUNDLE_DIR` is set without a paired data-dir or
 * state-dir override. That throw must never be swallowed by best-effort
 * catches around DB/data-dir operations — otherwise the guard's loud failure
 * silently degrades into a "no result" outcome (cold cache, missing snapshot,
 * etc.) and the underlying test leak goes undetected.
 *
 * Call `rethrowIfTestIsolationError(err)` from any catch block that returns
 * a fallback value (null, [], empty result) after touching DB or data-dir
 * paths. It re-throws when the caught error is the guard violation, otherwise
 * does nothing so the existing benign-fallback path can proceed unchanged.
 *
 * Usage:
 *   try {
 *     const db = openDatabase();
 *     // ...
 *   } catch (err) {
 *     rethrowIfTestIsolationError(err);
 *     // existing benign-fallback handling
 *   }
 */
export function isTestIsolationError(err: unknown): boolean {
  return err instanceof ConfigError && err.code === "TEST_ISOLATION_MISSING";
}

export function rethrowIfTestIsolationError(err: unknown): void {
  if (isTestIsolationError(err)) {
    throw err;
  }
}

/**
 * Unreadable-data-dir guard helper — the #791 sibling of the test-isolation
 * pair above, and it exists for the same reason.
 *
 * `DATA_DIR_UNREADABLE` says "this path is there and I am not allowed to read
 * it". It is raised by `assertIndexPathReadable` and friends precisely so a
 * permission fault stops being indistinguishable from "nothing indexed yet".
 * That distinction is destroyed again the moment a best-effort `catch` around
 * the open collapses it into the same `null`/`[]`/`0` the absent case returns —
 * which is how `akm search` came to answer "No search index available. Run
 * 'akm index'" at exit 0 for a populated index sitting right there on disk.
 *
 * Call `rethrowIfDataDirUnreadable(err)` from any catch block that returns a
 * fallback value after touching a data-dir path. Absent stays absent; a fault
 * the operator has to fix keeps travelling.
 */
export function isDataDirUnreadableError(err: unknown): err is ConfigError {
  return err instanceof ConfigError && err.code === "DATA_DIR_UNREADABLE";
}

export function rethrowIfDataDirUnreadable(err: unknown): void {
  if (isDataDirUnreadableError(err)) {
    throw err;
  }
}
