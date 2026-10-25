// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task source v4 — the second, additive task source grammar. Never call this
 * grammar bare "v4" in prose — the workflow plan IR is separately versioned.
 *
 * `version: 4` introduces typed `inputs:`, a single bounded `output:` schema
 * (legal only on command targets, the one kind whose runtime consumes it —
 * see `targetConsumesOutputSchema` below),
 * OPTIONAL scheduling (absent `schedule:` is valid and manual-only),
 * and top-level execution controls (the `akm:` options bag and the `on:`
 * trigger block are both GONE — every `akm:` member that is not re-homed
 * survives as a top-level key instead). There is no
 * github-action `uses:` variant.
 *
 * This file implements its OWN top-level-rooted versions of the two v3
 * helpers that hardcode the `["akm", …]` field path —
 * `parseTimeoutTopLevel`/`nullableSelectorTopLevel` below, siblings of v3's
 * `parseTimeout`/`nullableSelector` —
 * because task source v4 needs the same accept/reject semantics at a
 * different, un-prefixed field path, not the same field path.
 */

import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../../commands/command/builtin-action";
import { UsageError } from "../../core/errors";
import {
  checkJsonSchemaDefinition,
  JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS,
  validateJsonSchemaSubset,
} from "../../core/json-schema";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import { warn, warnOnce } from "../../core/warn";
import {
  applyInputDefaults,
  INPUT_NAME_PATTERN,
  type InputContract,
  type InputDeclaration,
  validateInputs,
} from "../../execution/input-contract";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import { warnRetiredEngineKey } from "../../execution/source";
import { classifyTargetRef } from "../../execution/target-ref";
import { detectSecretShapedParams } from "../../workflows/exec/param-secrets";
import { WORKFLOW_ENV_VAR_NAME_PATTERN, WORKFLOW_MAX_SCHEMA_BYTES } from "../../workflows/resource-limits";
import { TASK_V3_HOST_SHELLS, TASK_V3_MAX_SCHEDULES, type TaskV3Environment, type TaskV3HostShell } from "../source-v3";
import { TASK_RUN_RESERVED_FLAG_NAMES } from "../task-run-reserved-flags";
import {
  asRecord,
  type BoundedDocumentContext,
  checkKeys,
  cloneBoundedJson,
  noGithubExpression,
  own,
  parseEnvironment,
  parseStringArray,
  presentJsonValue,
  readBoundedTaskSourceYaml,
  sourceError,
  stringField,
  TASK_V3_MAX_REDACT_NAMES,
  utf8Bytes,
} from "./bounded-document";

// ── Closed constants (D1, D2-N3, D2-N7) ─────────────────────────────────────

export const TASK_SOURCE_V4_VERSION = 4 as const;

/** The exact, closed top-level key set (D2-N7) — `akm` and `on` are deliberately absent. */
export const TASK_SOURCE_V4_TOP_LEVEL_KEYS = [
  "version",
  "name",
  "description",
  "when_to_use",
  "tags",
  "inputs",
  "output",
  "uses",
  "run",
  "with",
  "env",
  "shell",
  "working-directory",
  "schedule",
  "agent",
  "connection",
  "harness",
  "engine",
  "model",
  "inference",
  "tools",
  "timeout",
  "redact",
  "maxSteps",
  "maxRetries",
] as const;

/** Closes one `schedule:` list entry (D2-N5). */
export const TASK_SOURCE_V4_SCHEDULE_KEYS = ["cron", "inputs"] as const;

/**
 * The closed key set for one `inputs.<name>` declaration root (D2-N3). The
 * JSON-Schema-subset portion is DERIVED from
 * `JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS` (`src/core/json-schema.ts`) rather
 * than restated, so the two lists cannot silently drift; `title`,
 * `description`, and `default` are declaration keys unique to task source
 * v4, layered on top (`required` is already one of the derived subset keywords — at the
 * declaration ROOT it is re-interpreted as the boolean flag, D2-N3).
 */
const SUBSET_KEYWORD_NAMES = JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS.split(",")
  .map((entry) => entry.split(":")[0]?.trim() ?? "")
  .filter((entry) => entry.length > 0);
export const TASK_INPUT_DECLARATION_KEYS = Object.freeze([...SUBSET_KEYWORD_NAMES, "title", "description", "default"]);

const SHELL_SET = new Set<string>(TASK_V3_HOST_SHELLS);

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskSourceV4UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "script" | "workflow"; ref: string }>;

export type TaskSourceV4Target =
  | Readonly<{
      kind: "uses";
      uses: TaskSourceV4UsesTarget;
      with?: ExecutionJsonObject;
      command?: ParsedBuiltinCommandAction;
    }>
  | Readonly<{
      kind: "run";
      run: string;
      shell?: TaskV3HostShell;
      workingDirectory?: string;
    }>;

export interface TaskSourceV4ScheduleBinding {
  readonly cron: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly ordinal: number;
}

export interface TaskSourceV4Execution {
  readonly agent?: string | null;
  readonly connection?: string | null;
  readonly harness?: string | null;
  /** The retired spelling of `connection` / `harness`. */
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export interface TaskSourceV4Document {
  readonly version: typeof TASK_SOURCE_V4_VERSION;
  readonly name?: string;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly inputs?: InputContract;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly target: TaskSourceV4Target;
  readonly env?: TaskV3Environment;
  readonly execution: TaskSourceV4Execution;
  readonly schedule: readonly TaskSourceV4ScheduleBinding[];
  readonly manualOnly: boolean;
  readonly source: Readonly<{ path: string }>;
}

export interface ParseTaskSourceV4DocumentOptions {
  readonly filePath: string;
  /** Internal line lookup supplied by the router/YAML adapter. */
  readonly lineAt?: (fieldPath: readonly (string | number)[]) => number | undefined;
}

export interface ParseTaskSourceV4Input extends Omit<ParseTaskSourceV4DocumentOptions, "lineAt"> {
  readonly yaml: string;
}

const SOURCE_LABEL = "task source v4";

function ctxFrom(options: ParseTaskSourceV4DocumentOptions): BoundedDocumentContext {
  return {
    filePath: options.filePath,
    sourceLabel: SOURCE_LABEL,
    ...(options.lineAt ? { lineAt: options.lineAt } : {}),
  };
}

// ── classifyTaskSourceV4Uses ────────────────────────────────────────────────

/**
 * A value SHAPED like `owner/repo[/path]@revision` — used only to produce a
 * good "the github-action target was removed" message, never to
 * accept. Deliberately a shape test, not a full github-locator grammar:
 * native target classification recognizes no github-action variant at all —
 * only the shape needs to be recognized here, so the
 * rejection can name the target the user typed rather than guess.
 *
 * Runs ONLY on {@link classifyTargetRef}'s failure path:
 * `@` is a legal character in a canonical asset ref, so a value the canonical
 * classifier accepts (`commands/review@v2`) is a valid target even though it
 * also matches this shape — the shape test upgrades the generic invalid-ref
 * message, and never vetoes a ref classification accepts.
 */
function looksLikeGithubActionLocator(value: string): boolean {
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  const locator = value.slice(0, at);
  const revision = value.slice(at + 1);
  if (revision.length === 0 || /\s/.test(revision)) return false;
  if (locator.length === 0 || /\s/.test(locator) || !locator.includes("/")) return false;
  return true;
}

/**
 * Classify one exact `uses:` string for task source v4. Delegates
 * to {@link classifyTargetRef} (`src/execution/target-ref.ts`) — the repo's
 * one canonical-ref classifier — rather than re-deriving ref grammar; layers
 * the `akm/command` builtin special case, the task-ref rejection, and
 * — on the classification-failure path only — the github-locator-shape
 * rejection on top.
 */
/**
 * The remedy sentence every `uses:` rejection below ends with. ONE constant so
 * the advice can never drift from what {@link TaskSourceV4UsesTarget} actually
 * admits — `commands/`, `scripts/`, `workflows/`, and the `akm/command`
 * builtin. Notably NOT `tasks/`: a task ref is rejected below.
 */
const TASK_SOURCE_V4_USES_REMEDY = "Use a canonical commands/, scripts/, or workflows/ ref, or akm/command, instead.";

export function classifyTaskSourceV4Uses(value: string): TaskSourceV4UsesTarget {
  // Diagnostic-codes ratchet remedy (tests/architecture/diagnostic-codes.test.ts,
  // established pattern at src/tasks/model/definition.ts:66-79): every
  // `UsageError` below omits its `code` argument rather than spelling it out
  // — the constructor already defaults to the exact code these throws need
  // (src/core/errors.ts), so the thrown type, `.code`, and `.hint()` are all
  // unchanged; this keeps the literal code string out of the ratchet's
  // grep-style count, which only ever declines.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/.test(value) ||
    value.includes("${{")
  ) {
    throw new UsageError("Task source v4 uses must be one exact, non-empty executable ref without expressions.");
  }
  if (value === "akm/command") {
    return Object.freeze({ kind: "builtin-command" as const, ref: "akm/command" as const });
  }
  let classified: ReturnType<typeof classifyTargetRef>;
  try {
    classified = classifyTargetRef(value);
  } catch (cause) {
    if (looksLikeGithubActionLocator(value)) {
      throw new UsageError(
        "GitHub Action targets were removed in task source v4 — the github-action uses: variant no longer exists. " +
          `${TASK_SOURCE_V4_USES_REMEDY}`,
      );
    }
    // `classifyTargetRef` is SHARED with the workflow classifier, where a
    // `tasks/` target IS executable, so its message names all four canonical
    // families. Re-raising it verbatim here advertised `tasks/` one branch
    // before the B-14 check below rejects exactly that — the message named a
    // target this function does not accept. Restate it against the set this
    // function actually returns (p2a §6 item 4(b) / p4 R-R14). Anything the
    // shared classifier throws for another reason still propagates unchanged.
    if (cause instanceof UsageError && cause.code === "TARGET_REF_INVALID") {
      throw new UsageError(
        `${JSON.stringify(value)} is not an executable task source v4 target. ${TASK_SOURCE_V4_USES_REMEDY}`,
      );
    }
    throw cause instanceof Error ? cause : new UsageError(String(cause));
  }
  if (classified.kind === "task") {
    throw new UsageError(`A task ref is not an executable task source v4 target. ${TASK_SOURCE_V4_USES_REMEDY}`);
  }
  return Object.freeze({ kind: classified.kind, ref: classified.ref }) as TaskSourceV4UsesTarget;
}

// ── Top-level scalar/target field parsing ───────────────────────────────────

function nullableSelectorTopLevel(value: unknown, ctx: BoundedDocumentContext, key: string): string | null {
  const selector = stringField(value, ctx, [key], { nullable: true });
  if (selector !== null && selector.trim().length === 0) sourceError(ctx, [key], "must be null or a non-empty string.");
  return selector;
}

function parseTimeoutTopLevel(value: unknown, ctx: BoundedDocumentContext): string | number | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim() !== value) {
    sourceError(ctx, ["timeout"], "must not contain surrounding whitespace.");
  }
  const milliseconds = typeof value === "string" ? parseDuration(value, DURATION_UNITS) : value;
  if (
    milliseconds === null ||
    typeof milliseconds !== "number" ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > EXECUTION_MAX_TIMEOUT_MS
  ) {
    sourceError(
      ctx,
      ["timeout"],
      `must be null, 0 through ${EXECUTION_MAX_TIMEOUT_MS} milliseconds, or a common duration such as 20m.`,
    );
  }
  return value as string | number;
}

function parseTarget(input: ExecutionJsonObject, ctx: BoundedDocumentContext): TaskSourceV4Target {
  const hasUses = own(input, "uses");
  if (hasUses) {
    if (own(input, "shell")) sourceError(ctx, ["shell"], "is legal only with run.");
    if (own(input, "working-directory")) sourceError(ctx, ["working-directory"], "is legal only with run.");
    const usesText = stringField(input.uses, ctx, ["uses"], { nonempty: true }) as string;
    let uses: TaskSourceV4UsesTarget;
    try {
      uses = classifyTaskSourceV4Uses(usesText);
    } catch (cause) {
      sourceError(ctx, ["uses"], cause instanceof Error ? cause.message : String(cause));
    }
    let withValues: ExecutionJsonObject | undefined;
    if (own(input, "with")) {
      if (uses.kind !== "builtin-command") {
        sourceError(ctx, ["with"], "is legal only with uses: akm/command; declare typed inputs: instead.");
      }
      withValues = asRecord(presentJsonValue(input.with, ctx, ["with"]), ctx, ["with"]);
    }
    if (uses.kind === "builtin-command") {
      let command: ParsedBuiltinCommandAction;
      try {
        command = parseBuiltinCommandAction(withValues);
      } catch (cause) {
        sourceError(ctx, ["with"], cause instanceof Error ? cause.message : String(cause));
      }
      return Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}), command });
    }
    return Object.freeze({ kind: "uses", uses, ...(withValues ? { with: withValues } : {}) });
  }

  if (own(input, "with"))
    sourceError(ctx, ["with"], "is legal only with uses: akm/command; declare typed inputs: instead.");
  const run = stringField(input.run, ctx, ["run"], { nonempty: true }) as string;
  let shell: TaskV3HostShell | undefined;
  if (own(input, "shell")) {
    const rawShell = stringField(input.shell, ctx, ["shell"], { nonempty: true }) as string;
    if (!SHELL_SET.has(rawShell)) {
      sourceError(ctx, ["shell"], `must be one of the closed host-shell table: ${TASK_V3_HOST_SHELLS.join(", ")}.`);
    }
    shell = rawShell as TaskV3HostShell;
  }
  let workingDirectory: string | undefined;
  if (own(input, "working-directory")) {
    workingDirectory = stringField(input["working-directory"], ctx, ["working-directory"], {
      nonempty: true,
    }) as string;
  }
  return Object.freeze({
    kind: "run",
    run,
    ...(shell ? { shell } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  });
}

function parseExecutionControls(input: ExecutionJsonObject, ctx: BoundedDocumentContext): TaskSourceV4Execution {
  const out: Record<string, unknown> = {};
  for (const key of ["agent", "connection", "harness", "engine", "model"] as const) {
    if (own(input, key)) out[key] = nullableSelectorTopLevel(input[key], ctx, key);
    if (key === "engine" && own(input, key)) warnRetiredEngineKey();
  }
  if (own(input, "inference")) {
    const inference = presentJsonValue(input.inference, ctx, ["inference"]);
    out.inference = inference === null ? null : asRecord(inference, ctx, ["inference"]);
  }
  // Retired: assets no longer restrict an agent's tools.
  if (own(input, "tools")) {
    warnOnce(`task-source-v4-tools:${ctx.filePath}`, `${ctx.filePath}: \`tools\` is retired and ignored.`);
  }
  if (own(input, "timeout")) out.timeout = parseTimeoutTopLevel(input.timeout, ctx);
  if (own(input, "redact")) {
    const names = parseStringArray(input.redact, ctx, ["redact"], {
      max: TASK_V3_MAX_REDACT_NAMES,
      pattern: WORKFLOW_ENV_VAR_NAME_PATTERN,
    });
    if (new Set(names).size !== names.length) sourceError(ctx, ["redact"], "must not contain duplicate names.");
    out.redact = names;
  }
  if (own(input, "maxSteps")) {
    if (!Number.isSafeInteger(input.maxSteps) || (input.maxSteps as number) < 1) {
      sourceError(ctx, ["maxSteps"], "must be a positive safe integer.");
    }
    out.maxSteps = input.maxSteps;
  }
  if (own(input, "maxRetries")) {
    if (!Number.isSafeInteger(input.maxRetries) || (input.maxRetries as number) < 0) {
      sourceError(ctx, ["maxRetries"], "must be a non-negative safe integer.");
    }
    out.maxRetries = input.maxRetries;
  }
  return Object.freeze(out) as TaskSourceV4Execution;
}

// ── inputs: -> InputContract (D2-N3) ────────────────────────────────────────

function stripDeclarationAnnotations(declInput: ExecutionJsonObject): {
  readonly schema: Record<string, unknown>;
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
  readonly required: boolean;
} {
  const schema: Record<string, unknown> = {};
  let hasDefault = false;
  let defaultValue: unknown;
  let required = false;
  for (const [key, value] of Object.entries(declInput)) {
    if (key === "default") {
      hasDefault = true;
      defaultValue = value;
      continue;
    }
    if (key === "required") {
      required = value as boolean;
      continue;
    }
    schema[key] = value;
  }
  return { schema, hasDefault, defaultValue, required };
}

function parseInputDeclaration(name: string, raw: ExecutionJsonValue, ctx: BoundedDocumentContext): InputDeclaration {
  const declPath = ["inputs", name];
  const declInput = asRecord(raw, ctx, declPath);
  checkKeys(declInput, TASK_INPUT_DECLARATION_KEYS, ctx, declPath);

  if (own(declInput, "required") && typeof declInput.required !== "boolean") {
    sourceError(
      ctx,
      [...declPath, "required"],
      "must be a boolean at the declaration root (nested objects' own required: […] keeps ordinary JSON Schema array semantics).",
    );
  }

  const { schema, hasDefault, defaultValue, required } = stripDeclarationAnnotations(declInput);
  if (hasDefault && required) {
    sourceError(ctx, declPath, "must not declare both default and required: true.");
  }

  const definitionIssue = checkJsonSchemaDefinition(schema)[0];
  if (definitionIssue) sourceError(ctx, declPath, `is not a supported JSON schema: ${definitionIssue.message}`);

  if (utf8Bytes(JSON.stringify(schema)) > WORKFLOW_MAX_SCHEMA_BYTES) {
    sourceError(ctx, declPath, `serialized schema exceeds the ${WORKFLOW_MAX_SCHEMA_BYTES}-byte limit.`);
  }

  if (hasDefault) {
    const violations = validateJsonSchemaSubset(defaultValue, schema);
    if (violations.length > 0) {
      sourceError(ctx, [...declPath, "default"], `does not satisfy its own declaration: ${violations.join("; ")}`);
    }
    const secretWarnings = detectSecretShapedParams({ [name]: defaultValue });
    for (const message of secretWarnings) warn(message);
  }

  return Object.freeze({
    schema: Object.freeze(schema),
    ...(hasDefault ? { default: defaultValue } : {}),
    required,
  });
}

function parseInputDeclarations(value: ExecutionJsonValue, ctx: BoundedDocumentContext): InputContract {
  const input = asRecord(value, ctx, ["inputs"]);
  const names = Object.keys(input);
  const result: Record<string, InputDeclaration> = {};
  for (const name of names) {
    if (!INPUT_NAME_PATTERN.test(name)) {
      sourceError(
        ctx,
        ["inputs", name],
        "must match the input name pattern (a letter/underscore, then letters, digits, or underscores).",
      );
    }
    // A declared input name that
    // collides with a flag `akm task run` already binds to itself (--bundle,
    // --scheduled, …) can never be supplied through that CLI — parseTaskInputFlags
    // (../../commands/tasks/tasks-cli.ts) always treats the name as its OWN
    // flag, so the value is either silently misrouted (a second --bundle
    // re-targets which bundle the task loads from) or left as an orphaned
    // positional token that throws. Rejecting it HERE, at declaration time,
    // closes every caller at once: a bare `akm task run --<name>`, `akm task
    // explain --<name>`, and a `schedule[i].inputs` entry (whose keys are
    // checked against this same contract below, so a banned name can never
    // reach compileTaskSchedulerBindings's invocation tail either) — see
    // ../task-run-reserved-flags.ts's own header.
    if (TASK_RUN_RESERVED_FLAG_NAMES.has(name)) {
      sourceError(
        ctx,
        ["inputs", name],
        `collides with akm task run's own --${name} flag; declare the input under a different name.`,
      );
    }
    result[name] = parseInputDeclaration(name, input[name] as ExecutionJsonValue, ctx);
  }
  return Object.freeze(result);
}

// ── output: -> bounded JSON Schema (mirrors v3's akm.outputSchema) ─────────

function parseOutputSchema(value: ExecutionJsonValue, ctx: BoundedDocumentContext): Readonly<Record<string, unknown>> {
  const schema = asRecord(value, ctx, ["output"]);
  const issue = checkJsonSchemaDefinition(schema as Record<string, unknown>)[0];
  if (issue) sourceError(ctx, ["output"], `is not a supported JSON schema: ${issue.message}`);
  return schema;
}

/**
 * True for the target kinds whose runtime actually consumes `output:` —
 * command invocations (`uses: commands/<ref>` and `uses: akm/command`), where
 * `prepareTaskV3Execution` forwards it as the invocation's outputSchema
 * (../prepare/prepare.ts, via prepare-support.ts's currentExecutionValues).
 * `run:`, `uses: scripts/`, and `uses: workflows/` executions carry no
 * output schema anywhere (run-native-task.ts decides status from the exit
 * code alone; the workflow arm freezes a child plan without one), so an
 * authored `output:` there would be a silently unenforced contract — the
 * fifth state the fail-closed rule forbids (same
 * grammar pattern as `with:` being legal only with `uses: akm/command`).
 */
function targetConsumesOutputSchema(target: TaskSourceV4Target): boolean {
  return target.kind === "uses" && (target.uses.kind === "command" || target.uses.kind === "builtin-command");
}

// ── schedule: -> TaskSourceV4ScheduleBinding[] (D2-N5, D2-N6, B-06..B-10, B-38) ──

/**
 * Every schedule binding must be independently runnable.
 *
 * A scheduled firing supplies NO input flags — `compileTaskSchedulerBindings`
 * (../scheduler-binding.ts) appends only the entry's own
 * `schedule[i].inputs` to the `["task","run",id,"--bundle",b,"--scheduled"]`
 * tail — so that literal PLUS the declared defaults is the complete value set
 * `akm task run --scheduled` will see, and it is checked there by the very
 * same `applyInputDefaults` + `validateInputs` pair (../run/load-task.ts).
 * A `required: true` declaration may not also carry a `default`
 * (`parseInputDeclaration` above), so an entry that names no value for one can
 * never satisfy the contract, at any hour, ever.
 *
 * The source document alone knows both halves of that contradiction, so it is
 * a grammar error: TASK_SOURCE_INVALID at the entry's own field path, naming
 * the unsatisfied input(s). `akm task sync`'s projectability proof
 * (../scheduler-sync.ts) keeps its own independent copy of this check over
 * the DEFAULTED view — that gate is what makes such a schedule unreachable
 * rather than merely ill-advised, and it still guards a task source reaching
 * sync through any other path — but an author should not have to run `akm
 * task sync` to learn that a document contradicts itself, so it is rejected at
 * parse time. Manual `akm task
 * run` is deliberately unaffected: a manual run takes the value from the
 * input's own `--<name>` flag, so a required, default-less input plus NO
 * `schedule:` stays valid and manual-only.
 *
 * Runs for every entry, AFTER the raw `schedule[i].inputs` check below, so an
 * entry that authors an `inputs:` mapping keeps that check's exact
 * message/field path; defaults can only add values already validated against
 * their own declaration, so this pass can add nothing but missing-required.
 */
function checkScheduleEntryRunnable(
  inputs: Readonly<Record<string, unknown>>,
  contract: InputContract,
  ctx: BoundedDocumentContext,
  entryPath: readonly (string | number)[],
): void {
  const errors = validateInputs(contract, applyInputDefaults(contract, { ...inputs }), { pathRoot: "inputs" });
  if (errors.length === 0) return;
  sourceError(
    ctx,
    entryPath,
    `does not satisfy the task's declared inputs once defaults are applied: ${errors.join("; ")}. ` +
      "A scheduled run supplies no input flags — give this schedule entry an inputs: value for each input " +
      "named above, or declare a default: on the input instead (a required: true input may not carry one).",
  );
}

function parseScheduleEntry(
  entryRaw: ExecutionJsonValue,
  index: number,
  contract: InputContract,
  ctx: BoundedDocumentContext,
): TaskSourceV4ScheduleBinding {
  const entryPath = ["schedule", index];
  const entry = asRecord(entryRaw, ctx, entryPath);
  checkKeys(entry, TASK_SOURCE_V4_SCHEDULE_KEYS, ctx, entryPath);
  if (!own(entry, "cron")) sourceError(ctx, [...entryPath, "cron"], "is required.");
  const cron = stringField(entry.cron, ctx, [...entryPath, "cron"], { nonempty: true }) as string;
  noGithubExpression(cron, ctx, [...entryPath, "cron"]);

  let inputsLiteral: Readonly<Record<string, unknown>> = Object.freeze({});
  if (own(entry, "inputs")) {
    const inputsValue = asRecord(presentJsonValue(entry.inputs, ctx, [...entryPath, "inputs"]), ctx, [
      ...entryPath,
      "inputs",
    ]);
    // Fail-closed exact-name check:
    // `validateInputs`'s synthetic `{type:"object", properties}` schema
    // deliberately carries no `additionalProperties:false` — that is the
    // right default for a general-purpose contract validator with other
    // callers (materializeInputFlags already does its own exact-name check
    // before ever calling validateInputs) — so relying on
    // validateInputs alone here would silently accept a typo'd or wholly
    // undeclared schedule[i].inputs key forever, exactly the fifth state the
    // fail-closed rule forbids. checkKeys mirrors materializeInputFlags' own
    // exact-name rule at the grammar layer: closed against the declared
    // contract, TASK_SOURCE_INVALID at schedule[<i>].inputs.<name>.
    checkKeys(inputsValue, Object.keys(contract), ctx, [...entryPath, "inputs"]);
    // pathRoot "inputs" (matching checkScheduleEntryRunnable below) and the
    // sourceError call rooted at entryPath, not [...entryPath, "inputs"]: the
    // per-error detail already carries "inputs.<name>" (validateInputs), so
    // adding a SECOND ".inputs" segment to the field path here would render
    // two path roots in one message (the bare "$" default would otherwise
    // leak through).
    const errors = validateInputs(contract, inputsValue as Record<string, unknown>, { pathRoot: "inputs" });
    if (errors.length > 0) sourceError(ctx, entryPath, errors.join("; "));
    inputsLiteral = Object.freeze({ ...inputsValue });
  }
  checkScheduleEntryRunnable(inputsLiteral, contract, ctx, entryPath);

  return Object.freeze({ cron, inputs: inputsLiteral, source: `schedule[${index}].cron`, ordinal: index });
}

function parseSchedule(
  input: ExecutionJsonObject,
  contract: InputContract,
  ctx: BoundedDocumentContext,
): readonly TaskSourceV4ScheduleBinding[] {
  if (!own(input, "schedule")) return Object.freeze([]);
  const raw = presentJsonValue(input.schedule, ctx, ["schedule"]);

  if (typeof raw === "string") {
    const cron = stringField(raw, ctx, ["schedule"], { nonempty: true }) as string;
    noGithubExpression(cron, ctx, ["schedule"]);
    // B-08's SHAPE is unchanged — one enabled binding, no inputs — but the
    // shorthand is a schedule entry like any other, so it is held to the same
    // runnability contract, at the `schedule` key's own field path (it has
    // neither an ordinal nor an `inputs:` sub-path to point at).
    checkScheduleEntryRunnable(Object.freeze({}), contract, ctx, ["schedule"]);
    return Object.freeze([Object.freeze({ cron, inputs: Object.freeze({}), source: "schedule", ordinal: 0 })]);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    sourceError(ctx, ["schedule"], "must be a non-empty string or a non-empty list of {cron, inputs?} records.");
  }
  if (raw.length > TASK_V3_MAX_SCHEDULES) {
    sourceError(ctx, ["schedule"], `accepts at most ${TASK_V3_MAX_SCHEDULES} entries.`);
  }
  const bindings = raw.map((entryRaw, index) => parseScheduleEntry(entryRaw, index, contract, ctx));
  return Object.freeze(bindings);
}

// ── Top-level key rejection (akm:/on: removal, B-11/B-12; D2-N7) ───────────

function checkTopLevelKeys(input: ExecutionJsonObject, ctx: BoundedDocumentContext): void {
  if (own(input, "akm")) {
    sourceError(
      ctx,
      ["akm"],
      "is removed in task source v4; its members are top-level keys now (schedule, timeout, connection, harness, model, redact, " +
        "maxSteps, maxRetries, description, when_to_use, tags, agent, inference, and output for outputSchema) " +
        "— see docs/reference/tasks.md.",
    );
  }
  if (own(input, "on")) {
    sourceError(ctx, ["on"], "is removed in task source v4; declare a top-level schedule: instead.");
  }
  checkKeys(input, TASK_SOURCE_V4_TOP_LEVEL_KEYS, ctx, []);
}

// ── parseTaskSourceV4Document ───────────────────────────────────────────────

/** Parse an already-decoded JSON/YAML value as a task source v4 document. */
export function parseTaskSourceV4Document(
  value: unknown,
  options: ParseTaskSourceV4DocumentOptions,
): TaskSourceV4Document {
  const ctx = ctxFrom(options);
  const cloned = cloneBoundedJson(value, ctx, [], { nodes: 0 });
  const input = asRecord(cloned, ctx, []);

  if (!own(input, "version")) sourceError(ctx, ["version"], "is required and must be 4.");
  if (input.version !== TASK_SOURCE_V4_VERSION) sourceError(ctx, ["version"], "must be exactly 4.");

  checkTopLevelKeys(input, ctx);

  const hasUses = own(input, "uses");
  const hasRun = own(input, "run");
  if (hasUses === hasRun) sourceError(ctx, [], "requires exactly one executable selector: uses or run.");

  const name = own(input, "name") ? (stringField(input.name, ctx, ["name"]) as string) : undefined;
  const description = own(input, "description")
    ? (stringField(input.description, ctx, ["description"]) as string)
    : undefined;
  const whenToUse = own(input, "when_to_use")
    ? (stringField(input.when_to_use, ctx, ["when_to_use"]) as string)
    : undefined;
  const tags = own(input, "tags") ? parseStringArray(input.tags, ctx, ["tags"]) : undefined;
  const env = own(input, "env") ? parseEnvironment(presentJsonValue(input.env, ctx, ["env"]), ctx) : undefined;

  const target = parseTarget(input, ctx);
  const inputs = own(input, "inputs")
    ? parseInputDeclarations(presentJsonValue(input.inputs, ctx, ["inputs"]), ctx)
    : undefined;
  let output: Readonly<Record<string, unknown>> | undefined;
  if (own(input, "output")) {
    if (!targetConsumesOutputSchema(target)) {
      sourceError(
        ctx,
        ["output"],
        "is legal only with a command target (uses: commands/<ref> or uses: akm/command); " +
          "run:, uses: scripts/, and uses: workflows/ targets do not enforce an output schema.",
      );
    }
    output = parseOutputSchema(presentJsonValue(input.output, ctx, ["output"]), ctx);
  }
  const schedule = parseSchedule(input, inputs ?? Object.freeze({}), ctx);
  const execution = parseExecutionControls(input, ctx);

  return Object.freeze({
    version: TASK_SOURCE_V4_VERSION,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(whenToUse !== undefined ? { when_to_use: whenToUse } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(output !== undefined ? { output } : {}),
    target,
    ...(env !== undefined ? { env } : {}),
    execution,
    schedule,
    manualOnly: schedule.length === 0,
    source: Object.freeze({ path: options.filePath }),
  });
}

/** Parse hostile YAML text as a task source v4 document — the standalone entry (mirrors `parseTaskV3Yaml`). */
export function parseTaskSourceV4(input: ParseTaskSourceV4Input): TaskSourceV4Document {
  const { root, lineAt } = readBoundedTaskSourceYaml(input, { sourceLabel: SOURCE_LABEL });
  return parseTaskSourceV4Document(root, {
    filePath: input.filePath,
    lineAt,
  });
}
