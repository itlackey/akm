// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task source version 5: the reader for one task file. Every rule of the design's
 * "Checked before anything runs" that needs nothing but the file itself is here,
 * so `akm lint`, an import, the index and `checkTaskV5` (`./check.ts`, which adds
 * what needs other files) all read a file through this one function.
 *
 * A build reads only its own `5-beta.<n>` (`TASK_SOURCE_V5_BETA`); `n` goes up
 * only when the syntax changes.
 */

import { parseTimeoutValue } from "../../cli/parse-args";
import { bundleRefToString, parseBundleRef } from "../../core/asset/asset-ref";
import { UsageError } from "../../core/errors";
import { isSecretRefToken, parseSecretSpec, REF_TOKEN_RE } from "../../core/ref-token";
import { warnOnce } from "../../core/warn";
import type { InputContract } from "../../execution/input-contract";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { WORKFLOW_ENV_VAR_NAME_PATTERN } from "../../workflows/resource-limits";
import {
  asRecord,
  type BoundedDocumentContext,
  cloneBoundedJson,
  own,
  parseStringArray,
  sourceError,
  stringField,
} from "../source/bounded-document";
import { parseInputDeclarations, parseSchedule, type TaskSourceV4ScheduleBinding } from "../source/task-source-v4";

/** The one beta this build reads. */
export const TASK_SOURCE_V5_BETA = 1;
export const TASK_SOURCE_V5_VERSION = `5-beta.${TASK_SOURCE_V5_BETA}` as const;
/** Any `5-beta.<n>`: the router sends these here, and `parseTaskSourceV5Document` refuses all but this build's own. */
export const TASK_SOURCE_V5_VERSION_PATTERN = /^5-beta\.\d+$/;

const SOURCE_LABEL = "task source v5";
/** The name of the one step of a task that is one command: it adds no entry to the state. */
export const TASK_V5_SINGLE_STEP = "";
/** The flags a start of a version 5 task takes, beside those in `TASK_RUN_RESERVED_FLAG_NAMES`, that can be an input's name: an input may not be named like one. */
const START_FLAG_NAMES = ["env", "secret", "cwd", "timeout", "resume", "inherit"];
const STEP_NAME = /^[A-Za-z0-9_-]+$/;
const FLAG = /^--([A-Za-z_][A-Za-z0-9_-]*)$/;
const WHOLE_TOKEN = /^\$\{([^}\s]+)\}$/;
const COMMAND_KEYS = ["run", "exec", "prompt", "args", "arguments", "expect"];
/** Options of a step; at the top of a task each is the default for every step. */
const OPTION_KEYS = [
  "env",
  "secret",
  "inherit",
  "cwd",
  "timeout",
  "max-retries",
  "harness",
  "connection",
  "model",
] as const;
const TASK_KEYS = [
  "version",
  "name",
  "description",
  "when_to_use",
  "tags",
  "schedule",
  "inputs",
  "steps",
  "lock",
  ...OPTION_KEYS,
];
const STEP_KEYS = ["name", ...COMMAND_KEYS, ...OPTION_KEYS];
const SCHEDULE_ENTRY_KEYS = ["cron", "inputs", "env", "secret", "timeout"] as const;
const FAMILY_KIND = { tasks: "tasks", commands: "commands", scripts: "scripts", agents: "agents" } as const;

export type TaskV5RefKind = (typeof FAMILY_KIND)[keyof typeof FAMILY_KIND];
export type TaskV5CommandKind = TaskV5RefKind | "exec" | "prompt";
/** An `env:` entry: an env asset's ref, as `--env` takes, or one variable and its value. */
export type TaskV5EnvEntry = string | Readonly<Record<string, string | number | boolean>>;

export interface TaskV5Options {
  readonly env?: readonly TaskV5EnvEntry[];
  readonly secret?: readonly string[];
  readonly inherit?: readonly string[];
  readonly cwd?: string;
  readonly timeout?: string | number;
  readonly "max-retries"?: number;
  readonly harness?: string;
  readonly connection?: string;
  readonly model?: string;
}

export interface TaskSourceV5Step {
  /** `TASK_V5_SINGLE_STEP` for a task that is one command. */
  readonly name: string;
  readonly kind: TaskV5CommandKind;
  readonly run?: string;
  readonly exec?: string;
  readonly prompt?: string;
  readonly args?: readonly unknown[];
  readonly arguments?: string;
  readonly expect?: readonly string[];
  /** For a step that runs a task: its `args:` as the input flags they are. The value is as written. */
  readonly taskInputs?: readonly { readonly name: string; readonly value: unknown }[];
  /** The step's own options. For a task that is one command they are the document's `options`. */
  readonly options: TaskV5Options;
}

export interface TaskSourceV5ScheduleBinding extends TaskSourceV4ScheduleBinding {
  readonly env?: readonly TaskV5EnvEntry[];
  readonly secret?: readonly string[];
  readonly timeout?: string | number;
}

export interface TaskSourceV5Document {
  readonly version: typeof TASK_SOURCE_V5_VERSION;
  readonly name?: string;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly inputs?: InputContract;
  readonly lock?: boolean;
  /** The task's own options: the default for every step. */
  readonly options: TaskV5Options;
  /** True for a task that is one command and has no `steps:`. */
  readonly single: boolean;
  readonly steps: readonly TaskSourceV5Step[];
  readonly schedule: readonly TaskSourceV5ScheduleBinding[];
  readonly source: Readonly<{ path: string }>;
}

export interface ParseTaskSourceV5DocumentOptions {
  readonly filePath: string;
  readonly lineAt?: BoundedDocumentContext["lineAt"];
}

type Path = readonly (string | number)[];
/** Where a rule reports: a file's field, or a flag of the start. */
export type TaskV5Fail = (path: Path, detail: string) => never;

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What `akm run` refuses when asked to run a version 5 file before the build that runs them. */
export function refuseRunningTaskV5(filePath: string): never {
  throw new UsageError(
    `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} is version ${TASK_SOURCE_V5_VERSION}; this build reads and checks it, and running version 5 tasks arrives in a later build.`,
    "TASK_SCHEMA_VERSION_UNSUPPORTED",
  );
}

/** The kind of asset a `run:` value names, or undefined when it is no ref to a task, prompt asset, script or agent. */
export function taskV5RefKind(ref: string): TaskV5RefKind | undefined {
  let parsed: ReturnType<typeof parseBundleRef>;
  try {
    parsed = parseBundleRef(ref);
  } catch {
    return undefined;
  }
  if (parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) return undefined;
  const slash = parsed.conceptId.indexOf("/");
  if (slash < 0 || slash === parsed.conceptId.length - 1) return undefined;
  const family = parsed.conceptId.slice(0, slash);
  return Object.hasOwn(FAMILY_KIND, family) ? FAMILY_KIND[family as keyof typeof FAMILY_KIND] : undefined;
}

const isSecretRef = (body: string): boolean => isSecretRefToken(`\${${body}}`);

/**
 * The shape of `env:`, `secret:`, `inherit:`, `cwd:`, `timeout:`, `max-retries:` and the agent selectors, on a task, a
 * step, a schedule entry or the flags of a start. `keys` are the ones this place takes. A task file names a secret only
 * by its ref. What the refs name is `checkTaskV5`'s.
 */
export function readTaskV5Options(
  source: Record<string, unknown>,
  keys: readonly (typeof OPTION_KEYS)[number][],
  base: Path,
  stateNames: ReadonlySet<string>,
  fail: TaskV5Fail,
): TaskV5Options {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!own(source, key)) continue;
    const value = source[key];
    const at = [...base, key];
    if (key === "env" || key === "secret" || key === "inherit") {
      if (!Array.isArray(value)) fail(at, "is a list.");
    } else if (key === "cwd" || key === "harness" || key === "connection" || key === "model") {
      if (typeof value !== "string") fail(at, "is text.");
    }
    switch (key) {
      case "env":
        for (const [index, entry] of (value as unknown[]).entries())
          readEnvEntry(entry, [...at, index], stateNames, fail);
        break;
      case "secret":
        for (const [index, entry] of (value as unknown[]).entries()) {
          if (typeof entry !== "string" || parseSecretSpec(entry) === undefined)
            fail([...at, index], "is not <secret ref>:<VAR>.");
        }
        break;
      case "inherit":
        for (const [index, name] of (value as unknown[]).entries()) {
          if (typeof name !== "string" || !WORKFLOW_ENV_VAR_NAME_PATTERN.test(name))
            fail([...at, index], "is not a variable name.");
        }
        break;
      case "cwd":
        for (const [, body] of (value as string).matchAll(REF_TOKEN_RE)) {
          if (stateNames.has(body as string))
            fail(at, "does not take a state entry; a state entry does not go into cwd:.");
        }
        break;
      case "timeout":
        try {
          parseTimeoutValue(String(value), `${key}:`);
        } catch (cause) {
          fail(at, `is not a duration. ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        break;
      case "max-retries":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
          fail(at, "takes a whole number, 0 or more.");
        break;
    }
    out[key] = value;
  }
  return out as TaskV5Options;
}

function readEnvEntry(entry: unknown, at: Path, stateNames: ReadonlySet<string>, fail: TaskV5Fail): void {
  if (typeof entry === "string") {
    if (isSecretRef(entry)) fail(at, `names a secret; a secret goes under secret:, not env:.`);
    return;
  }
  if (!isMap(entry)) fail(at, "is an env asset's ref or NAME: value.");
  for (const [name, value] of Object.entries(entry)) {
    if (!["string", "number", "boolean"].includes(typeof value)) fail([...at, name], "is text.");
    if (!WORKFLOW_ENV_VAR_NAME_PATTERN.test(name)) fail([...at, name], `${name} is not a variable name.`);
    for (const [, body] of String(value).matchAll(REF_TOKEN_RE)) {
      if (isSecretRef(body as string))
        fail([...at, name], "holds a secret ref; a secret goes under secret:, not here.");
      if (stateNames.has(body as string))
        fail([...at, name], "does not take a state entry; a state entry does not go into env:.");
    }
  }
}

/** Parse an already-decoded YAML value as a task source version 5 document. */
export function parseTaskSourceV5Document(
  value: unknown,
  options: ParseTaskSourceV5DocumentOptions,
): TaskSourceV5Document {
  const ctx: BoundedDocumentContext = {
    filePath: options.filePath,
    sourceLabel: SOURCE_LABEL,
    ...(options.lineAt ? { lineAt: options.lineAt } : {}),
  };
  const fail: TaskV5Fail = (path, detail) => sourceError(ctx, path, detail);
  const root = asRecord(cloneBoundedJson(value, ctx, [], { nodes: 0 }), ctx, []);
  const label = options.filePath;
  const ignoreKeys = (source: object, allowed: readonly string[], where: string): void => {
    for (const key of Object.keys(source)) {
      if (!allowed.includes(key)) warnOnce(`${where}: ${key}`, `${where}: ${key}: is not a key taken here; ignored`);
    }
  };

  if (root.version !== TASK_SOURCE_V5_VERSION) fail(["version"], `must be exactly "${TASK_SOURCE_V5_VERSION}".`);

  let inputs: InputContract | undefined;
  if (own(root, "inputs")) {
    inputs = parseInputDeclarations(root.inputs as ExecutionJsonValue, ctx);
    for (const name of Object.keys(inputs)) {
      if (START_FLAG_NAMES.includes(name)) {
        fail(["inputs", name], `collides with akm run's own --${name} flag; declare the input under a different name.`);
      }
    }
  }
  if (own(root, "lock") && typeof root.lock !== "boolean") fail(["lock"], "is true or false.");
  if (own(root, "steps") && !(Array.isArray(root.steps) && root.steps.length > 0 && root.steps.every(isMap))) {
    fail(["steps"], "is a list of steps, and has one.");
  }
  const single = !own(root, "steps");
  if (!single && (own(root, "run") || own(root, "exec") || own(root, "prompt"))) {
    fail([], "is one command or steps:, not both.");
  }

  const rawSteps: Record<string, unknown>[] = single ? [root] : (root.steps as Record<string, unknown>[]);
  const declaredNames = Object.keys(inputs ?? {});
  const stateNames = new Set<string>([
    ...declaredNames,
    ...(single ? [] : rawSteps.map((step) => step.name).filter((name): name is string => typeof name === "string")),
  ]);
  const taskOptions = readTaskV5Options(root, OPTION_KEYS, [], stateNames, fail);
  ignoreKeys(root, single ? [...TASK_KEYS, ...COMMAND_KEYS] : TASK_KEYS, label);

  const steps: TaskSourceV5Step[] = [];
  const seen: string[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const base: Path = single ? [] : ["steps", index];
    if (!single && (typeof raw.name !== "string" || !STEP_NAME.test(raw.name))) {
      fail([...base, "name"], "is needed: letters, digits, _ and - only.");
    }
    const name = single ? TASK_V5_SINGLE_STEP : (raw.name as string);
    const where = single ? label : `${label} step ${name}`;
    if (!single) ignoreKeys(raw, STEP_KEYS, where);
    if (seen.includes(name)) fail([...base, "name"], `has two steps named ${name}.`);
    if (declaredNames.includes(name)) fail([...base, "name"], `${name} has the name of an input.`);
    const known = (state: string): boolean => declaredNames.includes(state) || seen.includes(state);
    for (const key of ["run", "exec", "prompt", "arguments"] as const) {
      if (own(raw, key) && typeof raw[key] !== "string") fail([...base, key], "is text.");
    }
    if (own(raw, "expect") && !(Array.isArray(raw.expect) && raw.expect.every((key) => typeof key === "string"))) {
      fail([...base, "expect"], "is a list of keys.");
    }
    const kind = commandKind(raw, base, fail);
    const options = single ? {} : readTaskV5Options(raw, OPTION_KEYS, base, stateNames, fail);
    for (const key of ["harness", "connection", "model"] as const) {
      const given = single ? taskOptions[key] : options[key];
      if (given !== undefined && kind !== "agents" && kind !== "commands" && kind !== "prompt") {
        warnOnce(`${where}: ${key}`, `${where}: ${key}: is for a step an agent runs; ignored`);
      }
    }
    const args = own(raw, "args") ? raw.args : undefined;
    if (args !== undefined && kind !== "tasks" && kind !== "scripts")
      fail([...base, "args"], "are the arguments of a task or a script.");
    if (args !== undefined && !Array.isArray(args)) fail([...base, "args"], "is a list.");
    for (const [position, item] of (args ?? []).entries()) checkArg(item, known, [...base, "args", position], fail);
    if (own(raw, "arguments") && kind !== "commands") fail([...base, "arguments"], "is for a prompt asset.");
    if (own(raw, "expect") && (kind === "exec" || kind === "scripts" || kind === "tasks")) {
      fail([...base, "expect"], "checks an agent's reply.");
    }
    if (own(raw, "exec")) checkExec(raw.exec as string, stateNames, [...base, "exec"], fail);
    if (own(raw, "prompt")) checkText(raw.prompt as string, known, [...base, "prompt"], fail);
    if (own(raw, "arguments")) checkText(raw.arguments as string, known, [...base, "arguments"], fail);
    const taskInputs = kind === "tasks" ? inputFlags((args ?? []) as unknown[], [...base, "args"], fail) : undefined;
    steps.push({
      name,
      kind,
      ...(own(raw, "run") ? { run: raw.run as string } : {}),
      ...(own(raw, "exec") ? { exec: raw.exec as string } : {}),
      ...(own(raw, "prompt") ? { prompt: raw.prompt as string } : {}),
      ...(args !== undefined ? { args: args as readonly unknown[] } : {}),
      ...(own(raw, "arguments") ? { arguments: raw.arguments as string } : {}),
      ...(own(raw, "expect") ? { expect: raw.expect as readonly string[] } : {}),
      ...(taskInputs ? { taskInputs } : {}),
      options,
    });
    seen.push(name);
  }

  const bindings = parseSchedule(root as ExecutionJsonObject, inputs ?? Object.freeze({}), ctx, SCHEDULE_ENTRY_KEYS);
  const rawSchedule = Array.isArray(root.schedule) ? (root.schedule as Record<string, unknown>[]) : [];
  const schedule = bindings.map((binding, index) => {
    const entry = rawSchedule[index];
    const extras =
      entry === undefined
        ? {}
        : readTaskV5Options(entry, ["env", "secret", "timeout"], ["schedule", index], new Set(), fail);
    return Object.freeze({ ...binding, ...extras });
  });

  const text = (key: string): string | undefined =>
    own(root, key) ? (stringField(root[key], ctx, [key]) as string) : undefined;
  const name = text("name");
  const description = text("description");
  const whenToUse = text("when_to_use");
  const tags = own(root, "tags") ? parseStringArray(root.tags, ctx, ["tags"]) : undefined;
  return Object.freeze({
    version: TASK_SOURCE_V5_VERSION,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(whenToUse !== undefined ? { when_to_use: whenToUse } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(own(root, "lock") ? { lock: root.lock as boolean } : {}),
    options: taskOptions,
    single,
    steps: Object.freeze(steps),
    schedule: Object.freeze(schedule),
    source: Object.freeze({ path: options.filePath }),
  });
}

/** A step is exactly one command. Returns what it runs. */
function commandKind(step: Record<string, unknown>, base: Path, fail: TaskV5Fail): TaskV5CommandKind {
  if (own(step, "run")) {
    const kind = taskV5RefKind(step.run as string);
    if (!kind) fail([...base, "run"], "takes a ref; use exec: for anything else.");
    if (own(step, "exec")) fail(base, "is one command.");
    if (own(step, "prompt") !== (kind === "agents")) {
      fail([...base, "prompt"], "goes with run: only when run: names an agent, and an agent needs one.");
    }
    return kind;
  }
  if (own(step, "exec")) {
    if (own(step, "prompt")) fail(base, "is one command.");
    return "exec";
  }
  if (own(step, "prompt")) return "prompt";
  return fail(base, "is one command: run:, exec: or prompt:.");
}

/** `prompt:` and `arguments:`: `${name}` is an input or an earlier step. A secret is never named here. */
function checkText(text: string, known: (name: string) => boolean, at: Path, fail: TaskV5Fail): void {
  for (const [, body] of text.matchAll(REF_TOKEN_RE)) {
    if (isSecretRef(body as string)) fail(at, "holds a secret ref; a secret goes under secret:, never into a prompt.");
    if (!known(body as string)) fail(at, `\${${body}} is not an input or an earlier step.`);
  }
}

/** An `args:` item is one argument: text or a number as written, or one state entry as the whole item. */
function checkArg(value: unknown, known: (name: string) => boolean, at: Path, fail: TaskV5Fail): void {
  if (value === null || typeof value === "object") fail(at, "is one argument.");
  if (typeof value !== "string" || !value.includes("${")) return;
  const whole = WHOLE_TOKEN.exec(value)?.[1];
  for (const [, body] of value.matchAll(REF_TOKEN_RE)) {
    if (isSecretRef(body as string)) fail(at, "holds a secret ref; a secret goes under secret:, and is not an input.");
  }
  if (whole === undefined) fail(at, "must be a whole item: ${name} is one argument.");
  if (!known(whole)) fail(at, `\${${whole}} is not an input or an earlier step, and no shell expands it here.`);
}

/** An `exec:` command is run as written. A state entry is never put into it. */
function checkExec(command: string, stateNames: ReadonlySet<string>, at: Path, fail: TaskV5Fail): void {
  for (const [, body] of command.matchAll(REF_TOKEN_RE)) {
    if (isSecretRef(body as string)) fail(at, "holds a secret ref; a secret goes under secret:, not into a command.");
    if (stateNames.has(body as string))
      fail(at, `does not put \${${body}} into a command; the command reads the state file.`);
  }
}

/** A task's `args:` are its input flags as on the command line: `--<name> <value>`, in pairs. */
function inputFlags(args: readonly unknown[], at: Path, fail: TaskV5Fail): { name: string; value: unknown }[] {
  const flags: { name: string; value: unknown }[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const name = typeof args[i] === "string" ? FLAG.exec(args[i] as string)?.[1] : undefined;
    if (name === undefined || i + 1 === args.length) fail(at, "of a task are --<name> <value> pairs.");
    flags.push({ name, value: args[i + 1] });
  }
  return flags;
}
