// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure planner for one task file: task source v4 to task source v5, by the
 * design's "Names" table (`knowledge/akm/task-model/task-model.md`). It never
 * guesses: a v4 shell line becomes `exec:` as written, a v4 key v5 has no
 * name for blocks the file, and what v4 did that v5 does not (values given to
 * steps as `AKM_PARAMS`/`AKM_STEPS`, values appended to prompts) is listed as
 * a note for the person to change by hand. Whether the result is a task v5
 * accepts is the checker's (`./task-files.ts` calls `checkTaskV5`).
 */

import crypto from "node:crypto";
import { Document, isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from "yaml";
import { assertBoundedTaskYamlDocument } from "../../../src/tasks/source/bounded-document";
import {
  parseTaskSourceV4,
  type TaskSourceV4Document,
  type TaskSourceV4Step,
} from "../../../src/tasks/source/task-source-v4";
import { TASK_SOURCE_V5_VERSION, TASK_SOURCE_V5_VERSION_PATTERN } from "../../../src/tasks/v5/source";
import type { TaskFileInput } from "./task-files";

interface TaskToV5OutcomeBase {
  readonly filePath: string;
  readonly before: Buffer;
  readonly beforeHash: string;
  readonly mode: number;
  readonly reason: string;
  readonly detail?: string;
}

export interface TaskToV5Converted extends TaskToV5OutcomeBase {
  readonly status: "converted";
  readonly reason: "task-converted";
  readonly after: Buffer;
  readonly afterHash: string;
  /** What v4 did that v5 does not, to change by hand. */
  readonly notes: readonly string[];
}

export interface TaskToV5Skipped extends TaskToV5OutcomeBase {
  readonly status: "skipped";
  readonly reason: "already-v5";
}

export interface TaskToV5Blocked extends TaskToV5OutcomeBase {
  readonly status: "blocked";
}

export type TaskToV5Outcome = TaskToV5Converted | TaskToV5Skipped | TaskToV5Blocked;

/** v4 keys v5 has no name for: a file with one is left at v4. */
const UNCONVERTIBLE_KEYS = ["output", "agent", "engine", "inference", "tools", "redact", "maxSteps"] as const;
/** The shells whose lines `exec:` runs the same way. */
const EXEC_SHELLS = ["sh", "bash"];
const AKM_EXEC_ENV = /^akm exec((?: --env \S+)+) -- (\S[\s\S]*)$/;
/** The v5 names a v4 key's comments move to, in order of preference. */
const TOP_LEVEL_NAMES: Readonly<Record<string, readonly string[]>> = {
  run: ["exec"],
  uses: ["run", "prompt"],
  "working-directory": ["cwd"],
  maxRetries: ["max-retries"],
};
const STEP_NAMES: Readonly<Record<string, readonly string[]>> = {
  run: ["exec"],
  task: ["run"],
  prompt: ["prompt", "run"],
  retries: ["max-retries"],
};
/** Top-level values v5 keeps as written: their nodes, comments inside them included, are copied. */
const KEPT_AS_WRITTEN = new Set(["name", "description", "when_to_use", "tags", "inputs", "schedule"]);

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use a plain or null prototype`);
  }
  return value as Record<string, unknown>;
}

/**
 * Bounded-YAML raw-record reader: reading the RAW decoded record, not a typed parser's, keeps every field's original
 * value bytes (a duration string, a bare millisecond integer, an env value's exact type) intact for verbatim
 * re-emission.
 */
function parseRawTaskYaml(input: TaskFileInput): {
  data: Record<string, unknown>;
  source: string;
  document: ReturnType<typeof parseDocument>;
} {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    throw new Error("task YAML contains invalid UTF-8 bytes");
  }
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, { lineCounter, uniqueKeys: true });
  } catch (cause) {
    throw new Error(`invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const [parseError] = document.errors;
  if (parseError) throw new Error(`invalid YAML: ${parseError.message.split("\n")[0]}`);
  const [parseWarning] = document.warnings;
  if (parseWarning) throw new Error(`unsupported YAML construct: ${parseWarning.message}`);
  assertBoundedTaskYamlDocument(document, {
    filePath: input.filePath,
    sourceLabel: "task migration source",
    lineCounter,
  });
  return { data: plainRecord(document.toJS({ maxAliasCount: 0 }), "task YAML"), source, document };
}

function base(input: TaskFileInput): Omit<TaskToV5OutcomeBase, "reason"> {
  return {
    filePath: input.filePath,
    before: Buffer.from(input.bytes),
    beforeHash: crypto.createHash("sha256").update(input.bytes).digest("hex"),
    mode: input.mode,
  };
}

function blocked(input: TaskFileInput, reason: string, detail: string): TaskToV5Blocked {
  return Object.freeze({ status: "blocked" as const, ...base(input), reason, detail });
}

/** The `env:` list of v5: one entry per variable. */
function envList(map: Readonly<Record<string, string | number | boolean>> | undefined, refs: readonly string[]) {
  const entries: (string | Record<string, string | number | boolean>)[] = [...refs];
  for (const [name, value] of Object.entries(map ?? {})) entries.push({ [name]: value });
  return entries;
}

/** `exec:` and the env assets a shell line named, when it is exactly `akm exec --env <ref>... -- <command>`. */
function execLine(line: string): { exec: string; refs: string[] } {
  const match = AKM_EXEC_ENV.exec(line);
  if (!match) return { exec: line, refs: [] };
  return {
    exec: match[2] as string,
    refs: [...(match[1] as string).matchAll(/--env (\S+)/g)].map((m) => m[1] as string),
  };
}

function stepOut(step: TaskSourceV4Step): Record<string, unknown> {
  const out: Record<string, unknown> = { name: step.name };
  let refs: string[] = [];
  if (step.kind === "run") {
    const line = execLine(step.run);
    out.exec = line.exec;
    refs = line.refs;
  } else if (step.kind === "task") {
    out.run = step.ref;
  } else if (step.prompt.kind === "ref") {
    out.run = step.prompt.ref;
  } else {
    out.prompt = step.prompt.content;
  }
  const env = envList(step.env, refs);
  if (env.length > 0) out.env = env;
  if (step.timeout !== undefined) out.timeout = step.timeout;
  if (step.retries > 0) out["max-retries"] = step.retries;
  if (step.kind === "prompt") {
    for (const key of ["harness", "connection", "model"] as const) if (step[key] !== undefined) out[key] = step[key];
    if (step.expect) out.expect = step.expect;
  }
  return out;
}

/**
 * Move the v4 file's comments onto the v5 document: each key's comments go to the key it became, and a step's to the
 * step at the same place. A comment on a key v5 drops is dropped with it.
 */
function carryComments(
  from: YAMLMap,
  to: YAMLMap,
  names: Readonly<Record<string, readonly string[]>>,
  top: boolean,
): void {
  for (const pair of from.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const target = (names[key] ?? [key])
      .map((name) => to.items.find((p) => isScalar(p.key) && p.key.value === name))
      .find(Boolean);
    if (!target || !isScalar(target.key)) continue;
    target.key.commentBefore = pair.key.commentBefore;
    target.key.spaceBefore = pair.key.spaceBefore;
    if (top && KEPT_AS_WRITTEN.has(key)) {
      target.value = pair.value;
      continue;
    }
    const source = pair.value as { comment?: string | null; commentBefore?: string | null } | null;
    const value = target.value as { comment?: string | null; commentBefore?: string | null } | null;
    if (!source || !value) continue;
    value.comment = source.comment;
    value.commentBefore = source.commentBefore;
    if (top && key === "steps" && isSeq(pair.value) && isSeq(target.value)) {
      const steps = target.value.items;
      pair.value.items.forEach((step, index) => {
        if (isMap(step) && isMap(steps[index])) carryComments(step, steps[index] as YAMLMap, STEP_NAMES, false);
      });
    }
  }
}

function stepsNotes(document: TaskSourceV4Document, steps: readonly TaskSourceV4Step[]): string[] {
  const notes: string[] = [];
  const shellSteps = steps.filter((step) => step.kind === "run").map((step) => step.name);
  if (shellSteps.length > 0) {
    notes.push(
      `Steps ${shellSteps.join(", ")} received the task's values as AKM_PARAMS and the earlier steps' results as AKM_STEPS; a version 5 step receives neither. A step that reads them reads the state file at $AKM_TASK_STATE instead: change it by hand.`,
    );
  }
  const hasInputs = Object.keys(document.inputs ?? {}).length > 0;
  steps.forEach((step, index) => {
    if (step.kind !== "prompt") return;
    const appended = [
      ...(hasInputs ? ["the task's values"] : []),
      ...(index > 0 ? ["the earlier steps' results"] : []),
    ];
    if (appended.length === 0) return;
    notes.push(
      `Step ${step.name}: its prompt was sent with ${appended.join(" and ")} appended as text; a version 5 prompt is sent as written. Put \${name} where the prompt needs a value, by hand.`,
    );
  });
  return notes;
}

/**
 * Convert one v4 task file's bytes (`v4Bytes`, defaulting to the file's own) to v5. `input.bytes` are what the file
 * holds now and are the `before` of a converted outcome.
 */
export function planTaskToV5File(input: TaskFileInput, v4Bytes: Buffer = input.bytes): TaskToV5Outcome {
  const source = v4Bytes.toString("utf8");
  let data: Record<string, unknown>;
  let sourceDocument: ReturnType<typeof parseRawTaskYaml>["document"];
  try {
    ({ data, document: sourceDocument } = parseRawTaskYaml({ ...input, bytes: v4Bytes }));
  } catch (cause) {
    return blocked(input, "invalid-task-yaml", cause instanceof Error ? cause.message : String(cause));
  }
  if (typeof data.version === "string" && TASK_SOURCE_V5_VERSION_PATTERN.test(data.version)) {
    return Object.freeze({ status: "skipped" as const, ...base(input), reason: "already-v5" as const });
  }
  if (data.version !== 4) {
    return blocked(input, "unsupported-task-version", `expected version 4, got ${String(data.version)}`);
  }
  if (!input.writable || input.onDiskWritable === false) {
    return blocked(
      input,
      "read-only-source",
      !input.writable ? "the owning source is not writable" : "the source file or publication directory is read-only",
    );
  }

  let document: TaskSourceV4Document;
  try {
    document = parseTaskSourceV4({ yaml: source, filePath: input.filePath });
  } catch (cause) {
    return blocked(input, "invalid-v4-task", cause instanceof Error ? cause.message : String(cause));
  }
  const target = document.target;
  const stuck: string[] = UNCONVERTIBLE_KEYS.filter((key) => Object.hasOwn(data, key));
  if (target.kind === "uses" && target.uses.kind === "workflow") stuck.push("uses: workflows/...");
  const shell = target.kind === "uses" ? undefined : target.shell;
  if (shell !== undefined && !EXEC_SHELLS.includes(shell)) stuck.push(`shell: ${shell}`);
  if (stuck.length > 0) {
    return blocked(
      input,
      "no-version-5-form",
      `version 5 has no form for ${stuck.join(", ")}; the file is left at version 4`,
    );
  }

  const out: Record<string, unknown> = { version: TASK_SOURCE_V5_VERSION };
  for (const key of ["name", "description", "when_to_use", "tags", "inputs"] as const) {
    if (Object.hasOwn(data, key)) out[key] = data[key];
  }
  const notes: string[] = [];
  let refs: string[] = [];
  const command: Record<string, unknown> = {};
  if (target.kind === "steps") {
    out.lock = true;
  } else if (target.kind === "run") {
    const line = execLine(target.run);
    command.exec = line.exec;
    refs = line.refs;
  } else if (target.uses.kind === "builtin-command") {
    const action = target.command;
    if (action?.kind === "stored") command.run = action.ref;
    else command.prompt = action?.content;
    if (action?.arguments !== undefined) command.arguments = action.arguments;
  } else {
    command.run = target.uses.ref;
  }
  const env = envList(document.env, refs);
  if (env.length > 0) out.env = env;
  if (target.kind === "steps" || target.kind === "run") {
    if (target.workingDirectory !== undefined) out.cwd = target.workingDirectory;
  }
  const execution = document.execution;
  if (execution.timeout !== undefined) out.timeout = execution.timeout;
  if (execution.maxRetries !== undefined) out["max-retries"] = execution.maxRetries;
  for (const key of ["harness", "connection", "model"] as const)
    if (execution[key] !== undefined) out[key] = execution[key];
  if (target.kind === "steps") {
    out.steps = target.steps.map(stepOut);
    notes.push(...stepsNotes(document, target.steps));
  } else {
    Object.assign(out, command);
  }
  if (Object.hasOwn(data, "schedule")) out.schedule = data.schedule;
  if (shell === "bash") {
    notes.push("`shell: bash` is dropped: a version 5 exec: line is run by sh. Change a line that needs bash by hand.");
  }

  const converted = new Document(out);
  if (isMap(sourceDocument.contents) && isMap(converted.contents)) {
    carryComments(sourceDocument.contents, converted.contents, TOP_LEVEL_NAMES, true);
  }
  converted.commentBefore = sourceDocument.commentBefore;
  converted.comment = sourceDocument.comment;
  const after = Buffer.from(converted.toString({ lineWidth: 0 }), "utf8");
  return Object.freeze({
    status: "converted" as const,
    ...base(input),
    reason: "task-converted" as const,
    after,
    afterHash: crypto.createHash("sha256").update(after).digest("hex"),
    notes: Object.freeze(notes),
  });
}
