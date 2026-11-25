import { isRecord } from "../core/common";
import { formatExtraParamsIssue, validateExtraParams } from "../core/extra-params";
import { checkJsonSchemaDefinition, JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS } from "../core/json-schema";
import { warnOnce } from "../core/warn";
import { INPUT_NAME_PATTERN } from "../execution/input-contract";
import { warnRetiredEngineKey } from "../execution/source";
import { classifyTargetRef } from "../execution/target-ref";
import type {
  SourceRef,
  WorkflowError,
  WorkflowExec,
  WorkflowOnError,
  WorkflowReducer,
  WorkflowRetry,
  WorkflowUnitSettings,
} from "./plan";
import { parseReference } from "./program/expressions";
import {
  jsonBytes,
  WORKFLOW_ENGINE_NAME_PATTERN,
  WORKFLOW_ENV_VAR_NAME_PATTERN,
  WORKFLOW_MAX_CONCURRENCY,
  WORKFLOW_MAX_ENGINE_NAME_LENGTH,
  WORKFLOW_MAX_EXTRA_PARAMS_BYTES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_TIMEOUT_MS,
} from "./resource-limits";
// ── The Markdown grammar's vocabulary (pinned against schemas/akm-workflow.json) ──

export const PROGRAM_REDUCERS = ["collect", "vote"] as const;
export const PROGRAM_ON_ERROR = ["fail", "continue"] as const;

/** `retry.on`: exactly the persisted `AgentFailureReason` taxonomy (the `satisfies` fails typecheck on drift). */
const RETRY_REASON_SET = {
  timeout: true,
  spawn_failed: true,
  non_zero_exit: true,
  parse_error: true,
  cooldown: true,
  llm_rate_limit: true,
  llm_content_filter: true,
  llm_invalid_json: true,
  content_policy_reject: true,
  unsupported_type: true,
  no_change: true,
  quality_rejected: true,
  aborted: true,
} as const satisfies Record<import("../integrations/agent/spawn").AgentFailureReason, true>;
export const PROGRAM_RETRY_REASONS = Object.keys(RETRY_REASON_SET) as readonly string[];

/**
 * Step ids are exactly the `<ident>` grammar `steps.<id>.output` references
 * accept: no dots, so every step is addressable and `<stepId>.gate` can never
 * collide with a real step id.
 */
export const PROGRAM_STEP_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Param (and output) names: plain `params.<ident>`-addressable identifiers, shared with task inputs. */
export const PROGRAM_PARAM_NAME_PATTERN = INPUT_NAME_PATTERN;

/** One parsed `unit:` bag: its settings plus an optional argv and its frontmatter span. */
export type ProgramUnit = WorkflowUnitSettings & {
  exec?: WorkflowExec;
  /** Child workflow ref (Experimental) and its `with:` param bindings. */
  workflow?: string;
  with?: Record<string, unknown>;
  source: SourceRef;
};
export type ProgramGate = { maxLoops?: number };
export type ProgramMap = { over: string; concurrency?: number; reducer?: WorkflowReducer; unit?: ProgramUnit };
type LlmInvocationOverrides = import("../core/llm-inference").LlmInference;
export const UNIT_KEYS = [
  "exec",
  "workflow",
  "with",
  "connection",
  "harness",
  "engine",
  "model",
  "llm",
  "timeout",
  "retry",
  "on_error",
  "output",
  "env",
];
const EXEC_KEYS = ["command", "cwd", "pass_env"];
/** Unit keys that name a model or agent dispatch and therefore cannot appear beside `exec:`. `engine` is the retired spelling of `connection` / `harness`. */
const UNIT_ENGINE_KEYS = ["connection", "harness", "engine", "model", "llm"] as const;
const MAP_KEYS = ["over", "concurrency", "reducer", "unit"];
const RETRY_KEYS = ["max", "on"];
const GATE_KEYS = ["max_loops"];
const TIMEOUT_VALUE = /^(\d+)(ms|s|m)?$/;
const TIMEOUT_HINT = `Use "<n>ms", "<n>s", "<n>m" (e.g. "10m"), or "none"`;
export type Path = Array<string | number>;
export interface Ctx {
  readonly filePath: string;
  readonly errors: WorkflowError[];
  lineAt(path: Path): number;
  lineAtOffset(offset: number): number;
  refAt(path: Path): SourceRef;
  nodeAt(path: Path): unknown;
  err(path: Path, message: string): void;
  errAtLine(line: number, message: string): void;
}
// ---------------------------------------------------------------------------
// Step blocks
// ---------------------------------------------------------------------------

export function parseUnit(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  stepLabel: string,
  allowWorkflow = true,
): ProgramUnit | undefined {
  if (!isRecord(raw)) {
    ctx.err(path, `${stepLabel} "unit" must be a mapping (a dispatch-override bag).`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, UNIT_KEYS, `${stepLabel} "unit"`);

  const unit: ProgramUnit = { source: ctx.refAt(path) };

  if (raw.exec !== undefined) {
    const exec = parseExec(ctx, raw.exec, [...path, "exec"], stepLabel);
    if (exec !== undefined) unit.exec = exec;
    // An exec unit dispatches no model call, so every connection or harness selection key is
    // a contradiction rather than a harmless extra. Reported per key so the
    // author sees exactly which line to delete.
    for (const key of UNIT_ENGINE_KEYS) {
      if (raw[key] === undefined) continue;
      ctx.err(
        [...path, key],
        `${stepLabel} "unit" declares both "exec" and "${key}". An exec unit runs a shell command and never ` +
          `reaches an engine, so "${key}" would have no effect — remove one of the two.`,
      );
    }
  }

  if (raw.workflow !== undefined) {
    const workflow = parseChildWorkflowRef(ctx, raw.workflow, [...path, "workflow"], stepLabel, allowWorkflow);
    if (workflow !== undefined) unit.workflow = workflow;
    if (raw.exec !== undefined) {
      ctx.err(
        [...path, "workflow"],
        `${stepLabel} "unit" declares both "exec" and "workflow" — a unit runs one or the other.`,
      );
    }
    // A workflow unit starts a child run: it reaches no model and the child carries its own environment.
    for (const key of [...UNIT_ENGINE_KEYS, "env"]) {
      if (raw[key] === undefined) continue;
      ctx.err(
        [...path, key],
        `${stepLabel} "unit" declares both "workflow" and "${key}". A workflow unit starts a child run and never ` +
          `reaches an engine or an environment of its own, so "${key}" would have no effect — set it in the child workflow.`,
      );
    }
  }
  if (raw.with !== undefined) {
    if (raw.workflow === undefined) {
      ctx.err(
        [...path, "with"],
        `${stepLabel} "unit" declares "with" without "workflow" — it binds a child workflow's params.`,
      );
    } else if (!isRecord(raw.with)) {
      ctx.err(
        [...path, "with"],
        `${stepLabel} "with" must be a mapping of the child's param name to a literal value or { from: <reference> }.`,
      );
    } else {
      unit.with = raw.with;
    }
  }

  for (const key of ["connection", "harness", "engine"] as const) {
    if (raw[key] === undefined) continue;
    const name = parseEngineName(ctx, raw[key], [...path, key], `${stepLabel} "${key}"`);
    if (name !== undefined) unit[key] = name;
    if (key === "engine") warnRetiredEngineKey();
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && raw.model.trim() !== "") unit.model = raw.model.trim();
    else ctx.err([...path, "model"], `${stepLabel} "model" must be a non-empty string (a model alias or exact id).`);
  }
  const llm = parseLlmOverrides(ctx, raw.llm, [...path, "llm"], `${stepLabel} "llm"`);
  if (llm !== undefined) unit.llm = llm;

  const timeoutMs = parseTimeoutField(ctx, raw.timeout, [...path, "timeout"], `${stepLabel} "timeout"`);
  if (timeoutMs !== undefined) unit.timeoutMs = timeoutMs;

  const retry = parseRetry(ctx, raw.retry, [...path, "retry"], stepLabel);
  if (retry !== undefined) unit.retry = retry;

  const onError = parseEnumField(ctx, raw.on_error, [...path, "on_error"], `${stepLabel} "on_error"`, PROGRAM_ON_ERROR);
  if (onError !== undefined) unit.onError = onError as WorkflowOnError;

  const output = parseSchemaObject(ctx, raw.output, [...path, "output"], `${stepLabel} unit "output"`);
  if (output !== undefined) unit.output = output;

  if (raw.env !== undefined) {
    if (Array.isArray(raw.env) && raw.env.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
      const envRefs = raw.env.map((entry) => (entry as string).trim());
      // Same decoder uniqueness requirement as `inputs` above: duplicates linted
      // clean and then failed the run with an unlocated frozen-plan error.
      const duplicate = envRefs.find((ref, i) => envRefs.indexOf(ref) !== i);
      if (duplicate !== undefined) {
        ctx.err([...path, "env"], `${stepLabel} "env" contains a duplicate entry: "${duplicate}".`);
      } else {
        unit.env = envRefs;
      }
    } else {
      ctx.err([...path, "env"], `${stepLabel} "env" must be a list of non-empty env asset refs.`);
    }
  }

  return unit;
}

/** `unit.workflow` (Experimental): the canonical ref of a child workflow, `workflows/<name>` or `<bundle>//workflows/<name>`. */
function parseChildWorkflowRef(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  stepLabel: string,
  allowed: boolean,
): string | undefined {
  if (!allowed) {
    ctx.err(path, `${stepLabel} "workflow" is not supported inside "map.unit": a child workflow runs once per step.`);
    return undefined;
  }
  try {
    if (typeof raw === "string" && classifyTargetRef(raw).kind === "workflow") return raw;
  } catch {
    // falls through to the message below
  }
  ctx.err(path, `${stepLabel} "workflow" must be a canonical workflow ref such as "workflows/<name>".`);
  return undefined;
}

/**
 * Parse `unit.exec` — the argv-array shell-command surface.
 *
 * Deliberately NO shell-string spelling: the child is spawned directly from
 * this array, so shell metacharacters are inert literal bytes and the whole
 * quoting/injection class is structurally absent. An author who wants a
 * pipeline writes the interpreter explicitly (`["bash", "-lc", "…"]`), which
 * keeps that decision visible in the frontmatter diff.
 */
function parseExec(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): WorkflowExec | undefined {
  if (!isRecord(raw)) {
    ctx.err(path, `${stepLabel} "exec" must be a mapping with a "command" argv list.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, EXEC_KEYS, `${stepLabel} "exec"`);

  const command = parseExecCommand(ctx, raw.command, [...path, "command"], stepLabel);
  if (command === undefined) return undefined;

  const exec: WorkflowExec = { command };
  const cwd = parseExecCwd(ctx, raw.cwd, [...path, "cwd"], stepLabel);
  if (cwd !== undefined) exec.cwd = cwd;
  const passEnv = parseExecPassEnv(ctx, raw.pass_env, [...path, "pass_env"], stepLabel);
  if (passEnv !== undefined) exec.passEnv = passEnv;
  return exec;
}

/**
 * `pass_env:` — env var NAMES, recorded in the frozen plan. They select nothing:
 * an exec child inherits akm's environment, so a workflow written before that
 * still parses. NAMES ONLY: a value would be a plaintext secret in the frozen
 * plan, which is exactly what `env:` bindings exist to avoid.
 */
function parseExecPassEnv(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(
      path,
      `${stepLabel} "exec.pass_env" must be a non-empty list of environment variable NAMES, e.g. ` +
        `pass_env: [CARGO_HOME]. It has no effect: the command inherits akm's environment. Values never appear ` +
        `here — use "env:" bindings for those.`,
    );
    return undefined;
  }
  const names: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || !WORKFLOW_ENV_VAR_NAME_PATTERN.test(entry)) {
      ctx.err(
        path,
        `${stepLabel} "exec.pass_env[${index}]" must be an environment variable name matching ` +
          `${WORKFLOW_ENV_VAR_NAME_PATTERN.source}.`,
      );
      return undefined;
    }
    if (names.includes(entry)) {
      ctx.err(path, `${stepLabel} "exec.pass_env" lists "${entry}" more than once.`);
      return undefined;
    }
    names.push(entry);
  }
  return names;
}

/** The argv array itself: a non-empty list of non-empty strings. */
function parseExecCommand(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(
      path,
      `${stepLabel} "exec" requires "command": a non-empty argv list, e.g. command: ["bun", "run", "test:unit"]. ` +
        `A single shell string is not accepted — the command is spawned directly, never through a shell.`,
    );
    return undefined;
  }
  const argv: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry === "") {
      ctx.err(path, `${stepLabel} "exec.command[${index}]" must be a non-empty string.`);
      return undefined;
    }
    if (entry.includes("\0")) {
      ctx.err([...path, index], `${stepLabel} "exec.command[${index}]" may not contain NUL bytes.`);
      return undefined;
    }
    argv.push(entry);
  }
  return argv;
}

/**
 * The optional `cwd:`: a non-empty string, relative to the workflow's bundle root or absolute, and
 * free to carry `${ref}` tokens. Nothing else is checked here; the unit's working directory is
 * resolved at dispatch.
 */
function parseExecCwd(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    ctx.err(path, `${stepLabel} "exec.cwd" must be a non-empty string.`);
    return undefined;
  }
  return raw.trim();
}

export function parseMap(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramMap | undefined {
  if (!isRecord(raw)) {
    ctx.err(path, `${stepLabel} "map" must be a mapping with an "over" key.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, MAP_KEYS, `${stepLabel} "map"`);

  let over = "";
  if (typeof raw.over === "string" && raw.over.trim() !== "") {
    over = raw.over.trim();
    checkReferenceSyntax(ctx, over, [...path, "over"], `${stepLabel} "over"`);
  } else {
    ctx.err(
      [...path, "over"],
      `${stepLabel} "map" requires "over": a reference naming the item list (e.g. steps.discover.output.files).`,
    );
  }

  let concurrency: number | undefined;
  if (raw.concurrency !== undefined) {
    if (typeof raw.concurrency === "number" && Number.isInteger(raw.concurrency) && raw.concurrency > 0) {
      concurrency = Math.min(raw.concurrency, WORKFLOW_MAX_CONCURRENCY);
    } else {
      ctx.err([...path, "concurrency"], `${stepLabel} "concurrency" must be a positive integer.`);
    }
  }

  const reducer = parseEnumField(ctx, raw.reducer, [...path, "reducer"], `${stepLabel} "reducer"`, PROGRAM_REDUCERS);
  const unit = raw.unit !== undefined ? parseUnit(ctx, raw.unit, [...path, "unit"], stepLabel, false) : undefined;

  const map: ProgramMap = { over };
  if (concurrency !== undefined) map.concurrency = concurrency;
  if (reducer !== undefined) map.reducer = reducer as WorkflowReducer;
  if (unit !== undefined) map.unit = unit;
  return map;
}

export function parseInputs(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.err(path, `${stepLabel} "inputs" must be a non-empty list of reference strings.`);
    return undefined;
  }
  const out: string[] = [];
  // The frozen-plan decoder requires uniqueness (validateStringArray(..., true)),
  // so duplicates parsed and linted clean and then failed the run with an
  // unlocated "Invalid frozen workflow plan". Reject them here, on the entry.
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      ctx.err([...path, i], `${stepLabel} "inputs[${i}]" must be a non-empty reference string.`);
      return;
    }
    const value = entry.trim();
    if (seen.has(value)) {
      ctx.err([...path, i], `${stepLabel} "inputs[${i}]" duplicates an earlier entry: "${value}".`);
      return;
    }
    seen.add(value);
    checkReferenceSyntax(ctx, value, [...path, i], `${stepLabel} "inputs[${i}]"`);
    out.push(value);
  });
  return out.length > 0 ? out : undefined;
}

export function parseGate(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): ProgramGate | undefined {
  if (!isRecord(raw)) {
    ctx.err(path, `${stepLabel} "gate" must be a mapping with any of: ${GATE_KEYS.join(", ")}.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, GATE_KEYS, `${stepLabel} "gate"`);

  const gate: ProgramGate = {};
  if (raw.max_loops !== undefined) {
    if (typeof raw.max_loops === "number" && Number.isInteger(raw.max_loops) && raw.max_loops >= 1) {
      gate.maxLoops = raw.max_loops;
    } else {
      ctx.err([...path, "max_loops"], `${stepLabel} "gate.max_loops" must be an integer of at least 1.`);
    }
  }
  return gate;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/**
 * Connection and harness names must already satisfy the frozen-plan grammar
 * (`WORKFLOW_ENGINE_NAME_PATTERN`, max 63 chars) at parse time — the decoder
 * enforces the same bound on persisted plans, and a name that only fails there
 * surfaces as an unlocated "Invalid frozen workflow plan" at `workflow run`.
 */
export function parseEngineName(ctx: Ctx, raw: unknown, path: Path, label: string): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    ctx.err(path, `${label} must be a non-empty name.`);
    return undefined;
  }
  const name = raw.trim();
  if (!WORKFLOW_ENGINE_NAME_PATTERN.test(name) || name.length > WORKFLOW_MAX_ENGINE_NAME_LENGTH) {
    ctx.err(
      path,
      `${label} has an invalid name ${JSON.stringify(name)}. Names are lowercase words of letters ` +
        `and digits separated by single dashes, starting with a letter (e.g. "code-review-llm"), at most ` +
        `${WORKFLOW_MAX_ENGINE_NAME_LENGTH} characters.`,
    );
    return undefined;
  }
  return name;
}

function parseRetry(ctx: Ctx, raw: unknown, path: Path, stepLabel: string): WorkflowRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    ctx.err(path, `${stepLabel} "retry" must be a mapping: { max: <n>, on: [<failure_reason>, …] }.`);
    return undefined;
  }
  checkUnknownKeys(ctx, raw, path, RETRY_KEYS, `${stepLabel} "retry"`);

  let ok = true;
  if (!(typeof raw.max === "number" && Number.isInteger(raw.max) && raw.max >= 0)) {
    ctx.err([...path, "max"], `${stepLabel} "retry.max" is required and must be a non-negative integer.`);
    ok = false;
  }
  const on: WorkflowRetry["on"] = [];
  if (Array.isArray(raw.on) && raw.on.length > 0) {
    raw.on.forEach((reason, i) => {
      if (typeof reason === "string" && (PROGRAM_RETRY_REASONS as readonly string[]).includes(reason)) {
        on.push(reason as WorkflowRetry["on"][number]);
      } else {
        ctx.err(
          [...path, "on", i],
          `${stepLabel} "retry.on" has unknown failure reason ${JSON.stringify(reason)}. Valid reasons: ${PROGRAM_RETRY_REASONS.join(", ")}.`,
        );
        ok = false;
      }
    });
  } else {
    ctx.err(
      [...path, "on"],
      `${stepLabel} "retry.on" is required and must be a non-empty list of failure reasons (${PROGRAM_RETRY_REASONS.join(", ")}).`,
    );
    ok = false;
  }
  return ok ? { max: raw.max as number, on } : undefined;
}

export function parseTimeoutField(ctx: Ctx, raw: unknown, path: Path, label: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw > 0) return checkTimeoutCeiling(ctx, raw, path, label, String(raw));
    ctx.err(path, `${label} has a non-positive timeout ${JSON.stringify(raw)}. ${TIMEOUT_HINT}.`);
    return undefined;
  }
  if (typeof raw !== "string") {
    ctx.err(path, `${label} must be a duration string. ${TIMEOUT_HINT}.`);
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "none") return null;
  const match = value.match(TIMEOUT_VALUE);
  if (!match) {
    ctx.err(path, `${label} has an invalid timeout "${raw}". ${TIMEOUT_HINT}.`);
    return undefined;
  }
  const n = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? "ms";
  const timeoutMs = unit === "m" ? n * 60_000 : unit === "s" ? n * 1_000 : n;
  if (timeoutMs <= 0) {
    ctx.err(path, `${label} has a non-positive timeout "${raw}". Use a positive duration or "none".`);
    return undefined;
  }
  return checkTimeoutCeiling(ctx, timeoutMs, path, label, raw);
}

/**
 * Timeouts freeze into `IrInvocation.timeoutMs`, whose decoder bound is
 * `WORKFLOW_MAX_TIMEOUT_MS` (setTimeout's 32-bit signed ceiling). Enforce the
 * same ceiling here so an oversized duration fails with a line anchor instead
 * of an unlocated decode error at `workflow run`.
 */
function checkTimeoutCeiling(ctx: Ctx, timeoutMs: number, path: Path, label: string, raw: string): number | undefined {
  if (timeoutMs <= WORKFLOW_MAX_TIMEOUT_MS) return timeoutMs;
  ctx.err(
    path,
    `${label} has a timeout "${raw}" above the maximum of ${WORKFLOW_MAX_TIMEOUT_MS} ms (about 24.8 days). ` +
      `Use a shorter duration or "none" for no timeout.`,
  );
  return undefined;
}

export function parseEnumField(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  label: string,
  allowed: readonly string[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && allowed.includes(raw)) return raw;
  ctx.err(path, `${label} must be one of: ${allowed.join(" | ")} (got ${JSON.stringify(raw)}).`);
  return undefined;
}

/** Keys a unit's `llm:` once took and akm no longer reads: warned about once, then ignored. */
const RETIRED_LLM_KEYS: Readonly<Record<string, string>> = {
  supports_json_schema: "akm retries without a schema when the endpoint rejects one",
  context_length: "the context window is a connection's setting (contextLength)",
};

/** Parse only invocation tuning. Where it is sent belongs to a named connection. */
export function parseLlmOverrides(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  label: string,
): LlmInvocationOverrides | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    ctx.err(path, `${label} must be a mapping of LLM invocation overrides.`);
    return undefined;
  }
  const keys = [
    "temperature",
    "max_tokens",
    "supports_json_schema",
    "extra_params",
    "context_length",
    "enable_thinking",
    "reasoning_effort",
  ];
  checkUnknownKeys(ctx, raw, path, keys, label);
  const result: LlmInvocationOverrides = {};
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) result.temperature = raw.temperature;
    else ctx.err([...path, "temperature"], `${label}.temperature must be a finite number.`);
  }
  if (raw.max_tokens !== undefined) {
    if (typeof raw.max_tokens === "number" && Number.isInteger(raw.max_tokens) && raw.max_tokens > 0) {
      result.maxTokens = raw.max_tokens;
    } else ctx.err([...path, "max_tokens"], `${label}.max_tokens must be a positive integer.`);
  }
  for (const [key, why] of Object.entries(RETIRED_LLM_KEYS)) {
    if (raw[key] !== undefined) warnOnce(`workflow-llm-${key}`, `A workflow's llm.${key} is ignored: ${why}.`);
  }
  if (raw.extra_params !== undefined) {
    if (!isRecord(raw.extra_params)) {
      ctx.err([...path, "extra_params"], `${label}.extra_params must be a JSON object.`);
    } else {
      const issues = validateExtraParams(raw.extra_params);
      for (const issue of issues) {
        ctx.err([...path, "extra_params", ...issue.path], `${formatExtraParamsIssue(`${label}.extra_params`, issue)}.`);
      }
      if (jsonBytes(raw.extra_params) > WORKFLOW_MAX_EXTRA_PARAMS_BYTES) {
        ctx.err([...path, "extra_params"], `${label}.extra_params exceeds the 64 KiB resource limit.`);
      }
      if (issues.length === 0 && jsonBytes(raw.extra_params) <= WORKFLOW_MAX_EXTRA_PARAMS_BYTES) {
        result.extraParams = raw.extra_params;
      }
    }
  }
  if (raw.enable_thinking !== undefined) {
    if (typeof raw.enable_thinking === "boolean") result.enableThinking = raw.enable_thinking;
    else ctx.err([...path, "enable_thinking"], `${label}.enable_thinking must be a boolean.`);
  }
  if (raw.reasoning_effort !== undefined) {
    if (typeof raw.reasoning_effort === "string" && raw.reasoning_effort.trim().length > 0) {
      result.reasoningEffort = raw.reasoning_effort;
    } else ctx.err([...path, "reasoning_effort"], `${label}.reasoning_effort must be a non-empty string.`);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseSchemaObject(
  ctx: Ctx,
  raw: unknown,
  path: Path,
  label: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    ctx.err(path, `${label} must be a JSON Schema object (e.g. { type: object, properties: { … } }).`);
    return undefined;
  }
  if (jsonBytes(raw) > WORKFLOW_MAX_SCHEMA_BYTES) {
    ctx.err(path, `${label} exceeds the 256 KiB resource limit.`);
  }
  checkSchemaDefinition(ctx, raw, path, label);
  return raw;
}

/**
 * Validate an author-declared schema AS a schema (`output:` and `params`
 * declarations). The runtime enforces only a JSON Schema subset
 * (`core/json-schema.ts`); a typo'd `type` or a keyword the subset ignores
 * would silently constrain nothing at run time — a gate depending on a no-op
 * schema is worse than a loud failure here, so both are parse ERRORS.
 */
export function checkSchemaDefinition(ctx: Ctx, schema: Record<string, unknown>, path: Path, label: string): void {
  for (const issue of checkJsonSchemaDefinition(schema)) {
    const issuePath = [...path, ...issue.path];
    if (issue.kind === "unsupported") {
      ctx.err(
        issuePath,
        `${label} (at ${issue.pointer}): ${issue.message}. Supported JSON Schema keywords: ` +
          `${JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS}.`,
      );
    } else {
      ctx.err(issuePath, `${label} is not a valid JSON Schema (at ${issue.pointer}): ${issue.message}.`);
    }
  }
}

function checkReferenceSyntax(ctx: Ctx, text: string, path: Path, label: string): void {
  const result = parseReference(text);
  if (!result.ok) ctx.err(path, `${label}: ${result.message}`);
}

export function checkUnknownKeys(
  ctx: Ctx,
  obj: Record<string, unknown>,
  path: Path,
  allowed: readonly string[],
  label: string,
  hint: (key: string) => string = () => "",
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      ctx.err([...path, key], `Unknown ${label} key "${key}"${hint(key)}. Allowed keys: ${allowed.join(", ")}.`);
    }
  }
}
