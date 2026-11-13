// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Experimental: the `steps:` dispatch arm. Runs the prepared steps in order,
 * stops at the first failure, and records every step in the run's history row
 * (`metadata_json.steps`). A shell step runs like a `run:` task; a prompt step
 * dispatches like a command task; a `task:` step runs another task through the
 * injected `taskStepRunner`.
 *
 * Values: every step sees the run's inputs as `AKM_PARAMS` and the earlier
 * steps' results as `AKM_STEPS` (JSON keyed by step name). `AKM_INPUTS` is
 * never set. A prompt step has no child env on a direct-model connection, so
 * the same two values are appended to its prompt as text.
 */

import { dispatchPreparedCommandInvocation } from "../../commands/command/command-execution";
import { isRecord } from "../../core/common";
import { UsageError } from "../../core/errors";
import type { TaskLogLineInput } from "../../core/logs-db";
import { childProcessEnv } from "../../core/paths";
import type { Parsed } from "../../core/structured";
import { runManagedSubprocess } from "../../core/subprocess";
import type { ExecutionJsonValue } from "../../execution/json";
import { sortExecutionJson } from "../../execution/json";
import { type Correction, isRefused, jsonParser, structuredLoop } from "../../llm/structured";
import type { TaskHistoryStep } from "../../storage/repositories/task-history-repository";
import type { ExecutionProvenanceContext } from "../model/invocation";
import type { PreparedTaskStep, PreparedTaskV3Steps } from "../prepare/prepared-execution";
import { finishAttempt } from "./attempt-lifecycle";
import { withUnattendedTimeout } from "./run-command-task";
import { shellCommand } from "./run-native-task";
import { DEFAULT_SCHEDULED_TASK_TIMEOUT_MS } from "./run-workflow-task";
import { appendHistory, readTaskHistory } from "./task-history";
import { persistRunLog, scrubTaskOutput, streamLines } from "./task-log";
import type { RunTaskOptions, TaskRunResult } from "./task-result";

/** A step's result is kept to this many bytes of text. */
export const STEP_RESULT_MAX_BYTES = 32 * 1024;
/** A `run:` step's stdout is read up to this many bytes; the result keeps a prefix. */
const STEP_CAPTURE_MAX_BYTES = 64 * 1024;
/** The serialized `AKM_STEPS` handed to a step may not exceed this. */
export const STEPS_CONTEXT_MAX_BYTES = 96 * 1024;
const SUMMARY_MAX_CHARS = 200;

type StepValue = string | Record<string, unknown>;

interface StepOutcome {
  ok: boolean;
  value?: StepValue;
  reason?: string;
  startedAt?: string;
  lines: string[];
  dbLines: TaskLogLineInput[];
}

function bound(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= STEP_RESULT_MAX_BYTES) return text;
  return `${Buffer.from(text).subarray(0, STEP_RESULT_MAX_BYTES).toString("utf8")}\n[truncated ${bytes - STEP_RESULT_MAX_BYTES} bytes]`;
}

function summarize(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS)}...` : line;
}

function stepKind(step: PreparedTaskStep): TaskHistoryStep["kind"] {
  return step.kind === "shell" ? "run" : step.kind === "command" ? "prompt" : "task";
}

/**
 * `--resume`: the leading steps of this task's latest run that completed (or
 * were themselves reused), with their stored results. Runs before the new
 * attempt is reserved, so the latest history row is the previous run.
 */
export function resolveResume(task: PreparedTaskV3Steps): { restart: number; reused: TaskHistoryStep[] } {
  const previous = readTaskHistory({ id: task.taskId, limit: 1 })[0];
  if (!previous || previous.status !== "failed" || !previous.steps) {
    throw new UsageError(
      `Task ${JSON.stringify(task.taskId)} has no failed steps run to resume. Run it without --resume.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const names = task.steps.map((step) => `${step.name}:${stepKind(step)}`);
  const before = previous.steps.map((step) => `${step.name}:${step.kind}`);
  if (names.length !== before.length || names.some((entry, index) => entry !== before[index])) {
    throw new UsageError(
      `Task ${JSON.stringify(task.taskId)} changed its steps since the failed run. Run it without --resume.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const reused: TaskHistoryStep[] = [];
  for (const step of previous.steps) {
    if ((step.status !== "completed" && step.status !== "reused") || step.result === undefined) break;
    reused.push(step);
  }
  return { restart: reused.length, reused };
}

function jsonBlock(label: string, value: unknown): string {
  return `## ${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** The prompt with the run's values and earlier results appended as text, plus any correction. */
function promptContent(
  content: string,
  params: Readonly<Record<string, unknown>>,
  stepValues: Record<string, StepValue>,
  correction?: Correction,
): string {
  const parts = [content];
  if (Object.keys(params).length > 0) parts.push(jsonBlock("Task values", params));
  if (Object.keys(stepValues).length > 0) parts.push(jsonBlock("Earlier steps", stepValues));
  if (correction) parts.push(correction.text);
  return parts.join("\n\n");
}

function replyCheck(expect: readonly string[]): (raw: string) => Parsed<Record<string, unknown>> {
  return jsonParser((candidate) => {
    if (!isRecord(candidate)) {
      return { ok: false, errors: ["the reply is not a JSON object"], reason: "validation_error" };
    }
    const missing = expect.filter((key) => candidate[key] === undefined);
    return missing.length === 0
      ? { ok: true, value: candidate }
      : { ok: false, errors: [`the reply lacks: ${missing.join(", ")}`], reason: "validation_error" };
  });
}

export async function runStepsTask(input: {
  task: PreparedTaskV3Steps;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  historyReserved: boolean;
  provenance: ExecutionProvenanceContext;
  options: RunTaskOptions;
  resume?: { restart: number; reused: TaskHistoryStep[] };
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, provenance, options } = input;
  const params = task.params;
  const paramsJson = JSON.stringify(sortExecutionJson(params as ExecutionJsonValue));
  const lines: string[] = [`[akm task] task=${task.taskId} kind=steps steps=${task.steps.length}`];
  const dbLines: TaskLogLineInput[] = [{ line: lines[0] as string }];
  const records: TaskHistoryStep[] = [];
  const values: Record<string, StepValue> = {};
  const stored = new Map<string, string>();

  for (const step of input.resume?.reused ?? []) {
    const result = step.result as string;
    const planned = task.steps[records.length];
    values[step.name] = planned?.kind === "command" && planned.expect ? safeParseObject(result) : result;
    stored.set(step.name, result);
    records.push({ ...step, status: "reused", durationMs: 0, attempts: 0 });
  }

  // akm's own termination signal stops the running step's whole process group.
  const abort = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => abort.abort(new Error(`task runner received ${signal}`));
  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  let failure: { name: string; reason: string } | undefined;
  try {
    for (let index = records.length; index < task.steps.length; index++) {
      const step = task.steps[index] as PreparedTaskStep;
      if (failure) {
        records.push({ name: step.name, kind: stepKind(step), status: "skipped", durationMs: 0, attempts: 0 });
        continue;
      }
      const stepsJson = JSON.stringify(values);
      let outcome: StepOutcome = { ok: false, reason: "not run", lines: [], dbLines: [] };
      let attempts = 0;
      const begun = now();
      for (let attempt = 0; attempt <= step.retries; attempt++) {
        attempts += 1;
        if (Buffer.byteLength(stepsJson) > STEPS_CONTEXT_MAX_BYTES) {
          outcome = {
            ok: false,
            reason: `earlier step results total over ${STEPS_CONTEXT_MAX_BYTES} bytes (AKM_STEPS limit)`,
            lines: [],
            dbLines: [],
          };
          break;
        }
        outcome = await runStep(step, { task, options, provenance, paramsJson, stepsJson, values, abort });
        if (outcome.ok || abort.signal.aborted) break;
      }
      const durationMs = Math.max(0, now().getTime() - begun.getTime());
      const header = `[akm task] step=${step.name} kind=${stepKind(step)} attempts=${attempts} ok=${outcome.ok}`;
      lines.push(header, ...outcome.lines);
      dbLines.push({ level: outcome.ok ? "info" : "error", line: header }, ...outcome.dbLines);
      const text =
        outcome.value === undefined
          ? ""
          : typeof outcome.value === "string"
            ? outcome.value
            : JSON.stringify(outcome.value);
      const record: TaskHistoryStep = {
        name: step.name,
        kind: stepKind(step),
        status: outcome.ok ? "completed" : "failed",
        durationMs,
        attempts,
        ...(text ? { summary: scrubTaskOutput(task, summarize(text)) } : {}),
        ...(!outcome.ok && outcome.reason ? { reason: scrubTaskOutput(task, outcome.reason) } : {}),
        ...(outcome.startedAt ? { startedAt: outcome.startedAt } : {}),
      };
      if (outcome.ok) {
        values[step.name] = outcome.value ?? "";
        stored.set(step.name, text);
      } else {
        failure = { name: step.name, reason: record.reason ?? "failed" };
      }
      records.push(record);
    }
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }

  const finishedAt = finishAttempt(startedAt, now());
  persistRunLog({
    taskId: task.taskId,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: `${lines.join("\n")}\n`,
    dbLines,
    redactNames: task.redact,
    environment: task.environment,
  });
  // The bounded results are kept only for a failed run, where `--resume` reuses them.
  const steps = records.map((record) =>
    failure && (record.status === "completed" || record.status === "reused") && stored.has(record.name)
      ? { ...record, result: scrubTaskOutput(task, stored.get(record.name) as string) }
      : stripResult(record),
  );
  const result: TaskRunResult = {
    id: task.taskId,
    status: failure ? "failed" : "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "steps" },
    ...(failure ? { detail: { reason: "step_failed", error: `${failure.name}: ${failure.reason}` } } : {}),
    steps,
  };
  appendHistory(result, input.historyReserved, provenance.scheduled);
  return result;
}

function stripResult(record: TaskHistoryStep): TaskHistoryStep {
  const { result: _result, ...rest } = record;
  return rest;
}

function safeParseObject(text: string): StepValue {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : text;
  } catch {
    return text;
  }
}

async function runStep(
  step: PreparedTaskStep,
  ctx: {
    task: PreparedTaskV3Steps;
    options: RunTaskOptions;
    provenance: ExecutionProvenanceContext;
    paramsJson: string;
    stepsJson: string;
    values: Record<string, StepValue>;
    abort: AbortController;
  },
): Promise<StepOutcome> {
  if (step.kind === "shell") return runShellStep(step, ctx);
  if (step.kind === "command") return runPromptStep(step, ctx);
  return runTaskStep(step, ctx);
}

type Ctx = Parameters<typeof runStep>[1];

async function runShellStep(step: Extract<PreparedTaskStep, { kind: "shell" }>, ctx: Ctx): Promise<StepOutcome> {
  const { options, provenance } = ctx;
  const env: Record<string, string> = {
    ...childProcessEnv(),
    ...step.environment,
    AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? provenance.eventSource,
    AKM_PARAMS: ctx.paramsJson,
    AKM_STEPS: ctx.stepsJson,
  };
  // A step reads AKM_STEPS; the retired AKM_INPUTS must stay unset so a script still reading it fails.
  delete env.AKM_INPUTS;
  const timeoutMs = step.timeoutMs !== undefined ? step.timeoutMs : DEFAULT_SCHEDULED_TASK_TIMEOUT_MS;
  const result = await runManagedSubprocess(shellCommand(step), {
    capture: true,
    cwd: step.cwd,
    env,
    windowsVerbatimArguments: step.shell === "cmd",
    timeoutMs,
    maxOutputBytes: STEP_CAPTURE_MAX_BYTES,
    signal: ctx.abort.signal,
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
    ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
  });
  const out: StepOutcome = { ok: false, lines: [], dbLines: [] };
  if (result.spawnError) {
    out.reason = `spawn_error: ${result.spawnError.message}`;
    out.lines.push(`spawn_error=${result.spawnError.message}`);
    out.dbLines.push({ level: "error", line: `spawn_error=${result.spawnError.message}` });
    return out;
  }
  const exitCode = result.exitCode ?? (result.timedOut ? 143 : 1);
  out.lines.push(`exit_code=${exitCode}`);
  out.dbLines.push({ level: exitCode === 0 ? "info" : "error", line: `exit_code=${exitCode}` });
  if (result.timedOut) {
    out.lines.push(`timed_out=true timeout_ms=${timeoutMs}`);
    out.dbLines.push({ level: "error", line: `timed_out=true timeout_ms=${timeoutMs}` });
  }
  if (result.stdout) {
    out.lines.push("--- stdout ---", result.stdout);
    out.dbLines.push(...streamLines(result.stdout, "stdout", "info"));
  }
  if (result.stderr) {
    out.lines.push("--- stderr ---", result.stderr);
    out.dbLines.push(...streamLines(result.stderr, "stderr", "error"));
  }
  if (result.timedOut) out.reason = "timeout";
  else if (exitCode !== 0) out.reason = `exit code ${exitCode}`;
  else {
    out.ok = true;
    out.value = bound(result.stdout);
  }
  return out;
}

async function runPromptStep(step: Extract<PreparedTaskStep, { kind: "command" }>, ctx: Ctx): Promise<StepOutcome> {
  const params = ctx.task.params;
  const invocation = withUnattendedTimeout(step.invocation);
  const out: StepOutcome = { ok: false, lines: [], dbLines: [] };
  const dispatch = async (correction?: Correction) => {
    const content = promptContent(invocation.request.command.content, params, ctx.values, correction);
    const rebuilt = {
      ...invocation,
      request: { ...invocation.request, command: { ...invocation.request.command, content } },
    };
    const result = await dispatchPreparedCommandInvocation(rebuilt, {
      ...(ctx.options.runAgentImpl ? { runAgent: ctx.options.runAgentImpl } : {}),
      eventSource: ctx.provenance.eventSource,
      signal: ctx.abort.signal,
    });
    out.lines.push(`engine=${result.engine} ok=${result.ok} exit_code=${result.exitCode ?? "null"}`);
    if (result.stdout) {
      out.lines.push("--- agent stdout ---", result.stdout);
      out.dbLines.push(...streamLines(result.stdout, "stdout", "info"));
    }
    if (result.stderr) {
      out.lines.push("--- agent stderr ---", result.stderr);
      out.dbLines.push(...streamLines(result.stderr, "stderr", "error"));
    }
    return result.ok
      ? ({ ok: true, raw: result.stdout } as const)
      : ({ ok: false, failure: result.reason ?? result.error ?? "dispatch failed" } as const);
  };

  if (!step.expect) {
    const first = await dispatch();
    if (!first.ok) out.reason = first.failure;
    else {
      out.ok = true;
      out.value = bound(first.raw);
    }
    return out;
  }

  const expect = step.expect;
  const loop = await structuredLoop<Record<string, unknown>, { failure: string }>({
    dispatch,
    parse: replyCheck(expect),
    attempts: 2,
    correct: (refusal) =>
      `Your previous reply failed the check: ${refusal.errors.join("; ")}. ` +
      `Reply again with ONLY a JSON object containing the keys: ${expect.join(", ")}.`,
  });
  if (loop.ok) {
    out.ok = true;
    out.value = loop.value;
  } else if (isRefused(loop)) {
    out.reason = `reply_check_failed: ${loop.errors.join("; ")}`;
  } else {
    out.reason = loop.failure;
  }
  return out;
}

async function runTaskStep(step: Extract<PreparedTaskStep, { kind: "task" }>, ctx: Ctx): Promise<StepOutcome> {
  const runner = ctx.options.taskStepRunner;
  const out: StepOutcome = { ok: false, lines: [], dbLines: [] };
  if (!runner) {
    out.reason = "task steps need the CLI task runner";
    return out;
  }
  try {
    const result = await runner.run(step.ref);
    out.startedAt = result.startedAt;
    out.lines.push(`task=${step.ref} status=${result.status} started_at=${result.startedAt}`);
    if (result.status === "completed") {
      out.ok = true;
      out.value = "";
    } else {
      out.reason = `task ${step.ref} ${result.status}${result.detail?.error ? `: ${result.detail.error}` : ""}`;
    }
  } catch (error) {
    out.reason = `task ${step.ref} could not run: ${error instanceof Error ? error.message : String(error)}`;
  }
  return out;
}
