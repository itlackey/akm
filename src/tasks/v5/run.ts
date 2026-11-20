// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Running a version 5 task: a start or a `--resume`, its steps in order, the tasks they run as runs of their own, the
 * state, the working folder, the lock and the history. What a start accepts is `checkTaskV5`'s (`./check.ts`), which
 * is called with the start's inputs and flags before anything runs. Every other rule is called from the component that
 * owns it: `runProgram` runs `exec:` and script steps, `akmAgentDispatch` and the command path run the agent steps,
 * `buildChildEnv` makes a step's clean environment, `redactSensitiveValue` removes secret values from a result.
 *
 * A run keeps its state in `$AKM_STATE_DIR/runs/<task>/<run>.state.json` while it can be resumed, and works in
 * `$AKM_STATE_DIR/runs/<task>/<run>/` unless `cwd:` or `--cwd` names a folder. Both are removed when the run succeeds.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createParsedInvocation } from "../../cli/invocation";
import { parseTimeoutValue } from "../../cli/parse-args";
import { selectionFromArgs } from "../../cli/selection";
import { akmAgentDispatch } from "../../commands/agent/agent-dispatch";
import {
  dispatchPreparedCommandInvocation,
  executeCommandInvocation,
  prepareCommandInvocation,
} from "../../commands/command/command-execution";
import { buildChildEnv } from "../../commands/env/child-env";
import { ensureWorkingFolder, resolveInjections, runProgram } from "../../commands/env/injection";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { TransientError, UsageError } from "../../core/errors";
import { releaseLock } from "../../core/file-lock";
import type { TaskLogLineInput } from "../../core/logs-db";
import { getStateDir } from "../../core/paths";
import { collectInferredSecretValues, collectSensitiveValues, redactSensitiveValue } from "../../core/redaction";
import { REF_TOKEN_RE } from "../../core/ref-token";
import { formatLockHolderPid, tryAcquireRunLock } from "../../core/run-lock";
import { streamCaptureFailure } from "../../core/subprocess";
import { warn } from "../../core/warn";
import {
  applyInputDefaults,
  type InputFlag,
  materializeInputFlags,
  validateInputs,
} from "../../execution/input-contract";
import { withRetries } from "../../execution/retry";
import { resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import type { TaskHistoryRun, TaskHistoryStep } from "../../storage/repositories/task-history-repository";
import { scriptProgram } from "../frozen-script";
import { reserveTaskAttempt, skippedActiveRun, taskRunLockPath } from "../run/attempt-lifecycle";
import { resolveProvenanceContext } from "../run/provenance";
import { reconcileAbandonedExecutionState } from "../run/reconcile-abandoned";
import { shellCommand } from "../run/run-native-task";
import { expectLoop, summarize } from "../run/run-steps-task";
import { appendHistory, readTaskHistory } from "../run/task-history";
import { persistRunLog, resolveTaskLogPath, streamLines } from "../run/task-log";
import type { RunTaskOptions, TaskRunResult } from "../run/task-result";
import { parseTaskSource } from "../source/parse-task-source";
import { TASK_INPUT_DIAGNOSTICS } from "../source/task-input-diagnostics";
import { checkTaskV5, locateTaskV5Asset, type TaskV5Bundle } from "./check";
import type { StartedWith, TaskV5Start } from "./flags";
import { TASK_V5_SINGLE_STEP, type TaskSourceV5Document, type TaskSourceV5Step, type TaskV5Options } from "./source";

/** A version 5 task found by `loadPreparedTask`: what `runTask` needs to run it. */
export interface PreparedTaskV5 {
  readonly kind: "v5";
  /** The id its history rows carry. */
  readonly taskId: string;
  /** `tasks/<name>`, read from `bundle`. */
  readonly ref: string;
  readonly bundle: TaskV5Bundle;
}

/** The limit of a step that has no `timeout:` on it or at the top of its task. */
const DEFAULT_STEP_TIMEOUT = "30m";
const WHOLE_TOKEN = /^\$\{([^}\s]+)\}$/;
const NO_START: TaskV5Start = { flags: {}, resume: false, skipIfLocked: false, inputs: [] };

type StepStatus = "pending" | "completed";
type Values = Record<string, string | number | boolean>;

/** What is kept of a run while it can be resumed: written after every step, and gone when the run succeeds. */
interface RunRecord {
  ref: string;
  taskId: string;
  bundle: TaskV5Bundle;
  runId: string;
  parent?: NonNullable<TaskHistoryRun["parent"]>;
  /** The inputs the start gave, for the check a resume makes again. */
  values: Values;
  /** The inputs as the run has them, and then each finished step's result under its name. */
  state: Record<string, unknown>;
  steps: { name: string; status: StepStatus }[];
  /** The run each step that runs a task started. */
  children: Record<string, { task: string; run: string }>;
  flags: StartedWith;
  dir: string;
  /** True when akm made `dir` for this run, and so removes it when the run succeeds. */
  madeDir: boolean;
}

interface Resolved {
  env: Record<string, string>;
  secretValues: string[];
}

interface Context {
  options: RunTaskOptions;
  host: NodeJS.ProcessEnv;
  now: () => Date;
  scheduled: boolean;
  eventSource: UsageEventSource;
  /** Every secret value the run can set, in its task and every task it runs, known from the start. */
  secrets: Set<string>;
  abort: AbortController;
  environments: Map<string, Resolved>;
}

interface StepOutcome {
  ok: boolean;
  value?: unknown;
  reason?: string;
  startedAt?: string;
  attempts: number;
  lines: string[];
  dbLines: TaskLogLineInput[];
}

/** A value as text: text as it is, anything else as JSON. */
const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
const stepLabel = (name: string): string => (name === TASK_V5_SINGLE_STEP ? "(only)" : name);

function taskIdOf(ref: string): string {
  const { conceptId } = parseBundleRef(ref);
  return conceptId.slice(conceptId.indexOf("/") + 1);
}

function runsFolder(taskId: string): string {
  return path.join(getStateDir(), "runs", encodeURIComponent(taskId));
}
const recordPath = (taskId: string, runId: string): string => path.join(runsFolder(taskId), `${runId}.state.json`);

function newRunId(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

function writeRecord(record: RunRecord): void {
  const file = recordPath(record.taskId, record.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(record));
  fs.renameSync(pending, file);
}

function readRecord(taskId: string, runId: string): RunRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordPath(taskId, runId), "utf8")) as RunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A run that will not be resumed: the folder akm made for it and for the runs it started, and what is kept of it. */
function discard(record: RunRecord): void {
  if (record.madeDir) fs.rmSync(record.dir, { recursive: true, force: true });
  fs.rmSync(recordPath(record.taskId, record.runId), { force: true });
  for (const child of Object.values(record.children)) {
    const kept = readRecord(child.task, child.run);
    if (kept) discard(kept);
  }
}

/** The failed or interrupted runs of a task that were started directly, newest first, that can still be resumed. */
function resumableRuns(taskId: string): RunRecord[] {
  const found: RunRecord[] = [];
  for (const row of readTaskHistory({ id: taskId, limit: 500 })) {
    if (!row.run || row.run.parent || (row.status !== "failed" && row.status !== "interrupted")) continue;
    const kept = readRecord(taskId, row.run.id);
    if (kept && !found.some((earlier) => earlier.runId === kept.runId)) found.push(kept);
  }
  return found;
}

/**
 * The inputs a run has: those given, converted to their types, with their defaults; one not given is empty text.
 * `literals` are values a calling step gives that no flag can carry: an input that declares no type takes them as they are.
 */
function resolveInputs(
  document: TaskSourceV5Document,
  flags: readonly InputFlag[],
  literals: Record<string, unknown> = {},
): Record<string, unknown> {
  const contract = document.inputs ?? {};
  const given = { ...materializeInputFlags(contract, flags, TASK_INPUT_DIAGNOSTICS), ...literals };
  const defaulted = applyInputDefaults(contract, given);
  const errors = validateInputs(contract, defaulted);
  if (errors.length > 0) throw TASK_INPUT_DIAGNOSTICS.contractViolation(errors);
  const state: Record<string, unknown> = {};
  for (const name of Object.keys(contract)) state[name] = name in defaulted ? defaulted[name] : "";
  return state;
}

/** What a calling step's `args:` give a task: as the command line gives them, or, for a value of no type, as it is. */
function stepInputs(
  child: TaskSourceV5Document,
  step: TaskSourceV5Step,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const flags: InputFlag[] = [];
  const literals: Record<string, unknown> = {};
  for (const { name, value } of step.taskInputs ?? []) {
    const given = argument(value, state);
    if (typeof given === "string" || typeof given === "boolean") flags.push({ name, value: given });
    else if (typeof given === "object" && given !== null && child.inputs?.[name]?.schema.type === undefined) {
      literals[name] = given;
    } else flags.push({ name, value: JSON.stringify(given) });
  }
  return resolveInputs(child, flags, literals);
}

function inputValues(flags: readonly InputFlag[]): Values {
  const values: Values = {};
  for (const flag of flags) {
    if (flag.name in values) throw TASK_INPUT_DIAGNOSTICS.duplicateNonArray(flag.name);
    values[flag.name] = flag.value;
  }
  return values;
}

function parseDocument(file: string): TaskSourceV5Document {
  const parsed = parseTaskSource({ yaml: fs.readFileSync(file, "utf8"), filePath: file });
  if (parsed.version === 4) {
    throw new UsageError(`${file} is a version 4 task, and a version 5 task does not run one.`, "TASK_SOURCE_INVALID");
  }
  return parsed.v5;
}

/** The options of a step: its own, or those at the top of its task. */
function option<K extends keyof TaskV5Options>(
  document: TaskSourceV5Document,
  step: TaskSourceV5Step,
  key: K,
): TaskV5Options[K] {
  return step.options[key] ?? document.options[key];
}

// ── Starting and resuming ───────────────────────────────────────────────────

export interface PreparedRunV5 {
  readonly task: PreparedTaskV5;
  readonly start: TaskV5Start;
  readonly document: TaskSourceV5Document;
  /** The run a `--resume` continues. */
  readonly resume?: RunRecord;
  /** The inputs of a new run, as its task has them. */
  readonly inputs?: Record<string, unknown>;
  readonly values: Values;
}

/**
 * Everything checked before anything runs: the task and every task it runs, for this start's inputs and flags
 * (`checkTaskV5`), and, for a `--resume`, that there is a run to continue.
 */
export async function prepareRunV5(task: PreparedTaskV5, options: RunTaskOptions): Promise<PreparedRunV5> {
  const start = options.start ?? NO_START;
  try {
    reconcileAbandonedExecutionState();
  } catch {
    // Settling abandoned state is housekeeping; it never prevents a run.
  }
  if (start.resume) {
    const [resume] = resumableRuns(task.taskId);
    if (!resume) {
      throw new UsageError(
        `Task ${JSON.stringify(task.taskId)} has no failed run to resume. Run it without --resume.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const document = await checkTaskV5({
      ref: task.ref,
      bundle: task.bundle,
      values: resume.values,
      flags: resume.flags,
    });
    return { task, start, document, resume, values: resume.values };
  }
  const values = inputValues(start.inputs);
  const document = await checkTaskV5({ ref: task.ref, bundle: task.bundle, values, flags: start.flags });
  return { task, start, document, inputs: resolveInputs(document, start.inputs), values };
}

/** Run a prepared start. A held lock is `RUN_LEASE_HELD` (exit 75), or a skipped start when `--scheduled` or `--skip-if-locked` says so. */
export async function runPreparedV5(prepared: PreparedRunV5, options: RunTaskOptions): Promise<TaskRunResult> {
  const { task, start, document } = prepared;
  const provenance = resolveProvenanceContext(options.provenance, options.scheduled === true);
  const now = options.now ?? (() => new Date());
  const host = options.hostEnv ?? process.env;
  const flags = prepared.resume?.flags ?? start.flags;
  const context: Context = {
    options,
    host,
    now,
    scheduled: provenance.scheduled,
    eventSource: resolveUsageEventSource(host, provenance.eventSource as UsageEventSource),
    secrets: new Set(),
    abort: new AbortController(),
    environments: new Map(),
  };
  const lock = document.lock === true ? acquireLock(task.taskId) : undefined;
  if (lock?.state === "held") {
    const message = `Task ${task.taskId} is still running (PID ${formatLockHolderPid(lock.holder)}, started ${lock.holder.startedAt}); not starting another run.`;
    if (!(provenance.scheduled || start.skipIfLocked)) throw new TransientError(message, "RUN_LEASE_HELD");
    warn(message);
    return skippedActiveRun(task.taskId, now());
  }
  // akm's own termination signal stops the running step's whole process group.
  const onSignal = (signal: NodeJS.Signals) => context.abort.abort(new Error(`task runner received ${signal}`));
  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  try {
    await collectSecrets(context, task.ref, task.bundle, flags, new Set());
    const record =
      prepared.resume ??
      newRecord(context, task.ref, task.taskId, task.bundle, document, flags, prepared.inputs ?? {}, prepared.values);
    const until =
      flags.timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + parseTimeoutValue(String(flags.timeout));
    const result = await runAttempt(context, record, document, until);
    if (result.status === "completed") discardEarlierFailedRuns(record);
    return result;
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    if (lock) releaseLock(lock.ownership);
  }
}

function acquireLock(taskId: string): ReturnType<typeof tryAcquireRunLock> {
  return tryAcquireRunLock(taskRunLockPath(taskId), { label: "task" });
}

/** When a run of a task succeeds, the failed runs before it are not resumed: what is kept of them goes too. */
function discardEarlierFailedRuns(record: RunRecord): void {
  if (record.parent) return;
  for (const earlier of resumableRuns(record.taskId)) if (earlier.runId !== record.runId) discard(earlier);
}

/** A new run: its inputs, and a working folder of its own unless `--cwd` or the task's `cwd:` names one. */
function newRecord(
  context: Context,
  ref: string,
  taskId: string,
  bundle: TaskV5Bundle,
  document: TaskSourceV5Document,
  flags: StartedWith,
  state: Record<string, unknown>,
  values: Values,
  parent?: RunRecord,
  stepName?: string,
): RunRecord {
  const runId = newRunId(context.now());
  const named =
    parent === undefined && flags.cwd !== undefined
      ? flags.cwd
      : document.options.cwd === undefined
        ? undefined
        : path.resolve(bundle.dir, document.options.cwd);
  // A folder that is named is made if it is not there, and never removed.
  const dir = named === undefined ? path.join(runsFolder(taskId), runId) : ensureWorkingFolder(named);
  if (named === undefined) fs.mkdirSync(dir, { recursive: true });
  const record: RunRecord = {
    ref,
    taskId,
    bundle,
    runId,
    ...(parent ? { parent: { task: parent.taskId, run: parent.runId, step: stepName as string } } : {}),
    values,
    state,
    steps: document.steps.map((step) => ({ name: step.name, status: "pending" as StepStatus })),
    children: {},
    flags,
    dir,
    madeDir: named === undefined,
  };
  writeRecord(record);
  return record;
}

// ── Running ─────────────────────────────────────────────────────────────────

/** One attempt at a run, from its first unfinished step: one history row, and the steps it ran. */
async function runAttempt(
  context: Context,
  record: RunRecord,
  document: TaskSourceV5Document,
  until: number,
): Promise<TaskRunResult> {
  const attempt = reserveTaskAttempt(record.taskId, context.now(), {
    id: record.runId,
    ...(record.parent ? { parent: record.parent } : {}),
  });
  const startedAt = attempt.startedAt;
  const lines: string[] = [`[akm task] task=${record.taskId} run=${record.runId} steps=${document.steps.length}`];
  const dbLines: TaskLogLineInput[] = [{ line: lines[0] as string }];
  const steps: TaskHistoryStep[] = [];
  let failure: { name: string; reason: string } | undefined;
  let result: unknown;
  for (const [index, step] of document.steps.entries()) {
    const kept = record.steps[index] as { name: string; status: StepStatus };
    const kind = historyKind(step);
    const name = stepLabel(step.name);
    if (kept.status === "completed") {
      result = record.state[step.name];
      steps.push({ name, kind, status: "reused", durationMs: 0, attempts: 0 });
      continue;
    }
    if (failure) {
      steps.push({ name, kind, status: "skipped", durationMs: 0, attempts: 0 });
      continue;
    }
    const begun = context.now();
    const outcome = await runStep(context, record, document, step, until);
    const durationMs = Math.max(0, context.now().getTime() - begun.getTime());
    const header = `[akm task] step=${name} kind=${kind} attempts=${outcome.attempts} ok=${outcome.ok}`;
    lines.push(header, ...outcome.lines);
    dbLines.push({ level: outcome.ok ? "info" : "error", line: header }, ...outcome.dbLines);
    const text = outcome.value === undefined ? "" : asText(outcome.value);
    steps.push({
      name,
      kind,
      status: outcome.ok ? "completed" : "failed",
      durationMs,
      attempts: outcome.attempts,
      ...(text ? { summary: summarize(text) } : {}),
      ...(!outcome.ok && outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.startedAt ? { startedAt: outcome.startedAt } : {}),
    });
    if (outcome.ok) {
      result = outcome.value ?? "";
      kept.status = "completed";
      if (step.name !== TASK_V5_SINGLE_STEP) record.state[step.name] = result;
      writeRecord(record);
    } else {
      failure = { name, reason: outcome.reason ?? "failed" };
    }
  }
  const finishedAt = context.now() < startedAt ? startedAt : context.now();
  const logPath = resolveTaskLogPath(context.options.logDir, record.taskId, startedAt.toISOString());
  persistRunLog({
    taskId: record.taskId,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: `${lines.join("\n")}\n`,
    dbLines,
  });
  const outcome: TaskRunResult = {
    id: record.taskId,
    status: failure ? "failed" : "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "steps" },
    ...(failure ? { detail: { reason: "step_failed", error: `${failure.name}: ${failure.reason}` } } : { result }),
    steps,
    run: { id: record.runId, ...(record.parent ? { parent: record.parent } : {}) },
  };
  appendHistory(outcome, attempt.historyReserved, context.scheduled);
  if (!failure) discard(record);
  return outcome;
}

function historyKind(step: TaskSourceV5Step): TaskHistoryStep["kind"] {
  switch (step.kind) {
    case "tasks":
      return "task";
    case "scripts":
      return "run";
    case "exec":
      return "exec";
    default:
      return "prompt";
  }
}

/** The limit of a step: its own `timeout:`, or its task's, or 30 minutes. The run's limit holds as well. */
function limitOf(until: number, document: TaskSourceV5Document, step: TaskSourceV5Step): number {
  const timeout = option(document, step, "timeout") ?? DEFAULT_STEP_TIMEOUT;
  return Math.min(until, Date.now() + parseTimeoutValue(String(timeout)));
}

/** A step, run again as `max-retries:` says whatever made it fail; each try has the step's whole limit. */
async function runStep(
  context: Context,
  record: RunRecord,
  document: TaskSourceV5Document,
  step: TaskSourceV5Step,
  until: number,
): Promise<StepOutcome> {
  const retries = option(document, step, "max-retries") ?? record.flags.maxRetries ?? 0;
  const lines: string[] = [];
  const dbLines: TaskLogLineInput[] = [];
  let attempts = 0;
  const last = await withRetries(
    retries,
    async (): Promise<StepOutcome> => {
      attempts += 1;
      try {
        const remaining = limitOf(until, document, step) - Date.now();
        if (remaining <= 0) return { ok: false, reason: "timeout", attempts, lines, dbLines };
        const outcome = await doStep(context, record, document, step, remaining, until, { lines, dbLines });
        return { ...outcome, attempts, lines, dbLines };
      } catch (error) {
        return {
          ok: false,
          reason: scrub(context, error instanceof Error ? error.message : String(error)) as string,
          attempts,
          lines,
          dbLines,
        };
      }
    },
    (outcome) => !outcome.ok && !context.abort.signal.aborted,
  );
  return last;
}

interface Sink {
  lines: string[];
  dbLines: TaskLogLineInput[];
}

type Done = Pick<StepOutcome, "ok" | "value" | "reason" | "startedAt">;

async function doStep(
  context: Context,
  record: RunRecord,
  document: TaskSourceV5Document,
  step: TaskSourceV5Step,
  timeoutMs: number,
  until: number,
  sink: Sink,
): Promise<Done> {
  if (step.kind === "tasks") return runTaskStep(context, record, document, step, until, sink);
  const { env } = environmentOf(context, record.flags, document, step);
  const cwd =
    step.options.cwd === undefined
      ? record.dir
      : ensureWorkingFolder(path.resolve(record.bundle.dir, step.options.cwd));
  if (step.kind === "exec" || step.kind === "scripts") {
    return runProcessStep(context, record, step, { env, cwd, timeoutMs }, sink);
  }
  return runAgentStep(context, record, document, step, { env, cwd, timeoutMs }, sink);
}

/** `${name}` becomes that entry of the state, once: text as it is, anything else as JSON. */
function fill(text: string, state: Record<string, unknown>): string {
  return text.replace(REF_TOKEN_RE, (token, body: string) => (body in state ? asText(state[body]) : token));
}

/** An `args:` item when the step runs: a `${name}` item is that state entry, anything else is as written. */
function argument(item: unknown, state: Record<string, unknown>): unknown {
  const body = typeof item === "string" ? WHOLE_TOKEN.exec(item)?.[1] : undefined;
  return body === undefined ? item : state[body];
}

function scrub(context: Context, value: unknown): unknown {
  return context.secrets.size === 0 ? value : redactSensitiveValue(value, collectSensitiveValues(context.secrets));
}

/** A script or `exec:` command: a real process that reads the state from a file written for this step. */
async function runProcessStep(
  context: Context,
  record: RunRecord,
  step: TaskSourceV5Step,
  run: { env: Record<string, string>; cwd: string; timeoutMs: number },
  sink: Sink,
): Promise<Done> {
  const argv =
    step.kind === "scripts"
      ? scriptProgram(
          step.run as string,
          (await locateTaskV5Asset(record.bundle, step.run as string, "scripts", `${record.ref} step ${step.name}`))
            .file,
          (step.args ?? []).map((item) => asText(argument(item, record.state))),
        )
      : shellCommand({ command: step.exec as string, shell: process.platform === "win32" ? "cmd" : "sh" });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-state-"));
  const statePath = path.join(stateDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(record.state, null, 2));
  try {
    const result = await runProgram({
      argv,
      env: { ...run.env, AKM_TASK_STATE: statePath },
      cwd: run.cwd,
      timeoutMs: run.timeoutMs,
      capture: true,
      signal: context.abort.signal,
    });
    const stdout = scrub(context, result.stdout) as string;
    const stderr = scrub(context, result.stderr) as string;
    sink.lines.push(`exit_code=${result.exitCode}`);
    if (stdout) {
      sink.lines.push("--- stdout ---", stdout);
      sink.dbLines.push(...streamLines(stdout, "stdout", "info"));
    }
    if (stderr) {
      sink.lines.push("--- stderr ---", stderr);
      sink.dbLines.push(...streamLines(stderr, "stderr", "error"));
    }
    if (result.aborted) return { ok: false, reason: "aborted" };
    if (result.timedOut) return { ok: false, reason: "timeout" };
    if (result.exitCode !== 0) return { ok: false, reason: `exit code ${result.exitCode}` };
    const incomplete = streamCaptureFailure(result.stdoutRead, result.stderrRead);
    if (incomplete) return { ok: false, reason: incomplete };
    return { ok: true, value: stdout };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

/** A prompt, an agent or a prompt asset: the agent's reply is the result, held to `expect:` when the step has it. */
async function runAgentStep(
  context: Context,
  record: RunRecord,
  document: TaskSourceV5Document,
  step: TaskSourceV5Step,
  run: { env: Record<string, string>; cwd: string; timeoutMs: number },
  sink: Sink,
): Promise<Done> {
  const selection = selectionFromArgs({
    harness: option(document, step, "harness"),
    connection: option(document, step, "connection"),
    model: option(document, step, "model"),
  });
  const runAgent = context.options.runAgentImpl;
  const dispatch = async (correction?: { text: string }) => {
    const extra = correction ? `\n\n${correction.text}` : "";
    const reply =
      step.kind === "commands"
        ? await dispatchPromptAsset(
            context,
            step,
            `${fill(step.arguments ?? "", record.state)}${extra}`,
            selection,
            run,
          )
        : await akmAgentDispatch(
            {
              prompt: `${fill(step.prompt as string, record.state)}${extra}`,
              ...(step.kind === "agents" ? { agentRef: step.run as string } : {}),
              agentConfig: loadConfig(),
              baseEnv: run.env,
              cwd: run.cwd,
              timeoutMs: run.timeoutMs,
              signal: context.abort.signal,
              ...(Object.keys(selection).length === 0 ? {} : { selection }),
            },
            runAgent
              ? {
                  executeCommand: (prepare, dispatchOptions) =>
                    executeCommandInvocation(prepare, { ...dispatchOptions, runAgent }),
                }
              : {},
          );
    sink.lines.push(`engine=${reply.engine} ok=${reply.ok} exit_code=${reply.exitCode ?? "null"}`);
    const stdout = scrub(context, reply.stdout) as string;
    const stderr = scrub(context, reply.stderr) as string;
    if (stdout) {
      sink.lines.push("--- agent stdout ---", stdout);
      sink.dbLines.push(...streamLines(stdout, "stdout", "info"));
    }
    if (stderr) {
      sink.lines.push("--- agent stderr ---", stderr);
      sink.dbLines.push(...streamLines(stderr, "stderr", "error"));
    }
    if (!reply.ok) return { ok: false, failure: reply.reason ?? reply.error ?? "dispatch failed" } as const;
    return { ok: true, raw: reply.stdout } as const;
  };
  if (!step.expect) {
    const reply = await dispatch();
    return reply.ok ? { ok: true, value: scrub(context, reply.raw) } : { ok: false, reason: reply.failure };
  }
  const loop = await expectLoop(step.expect, dispatch);
  if (loop.ok) return { ok: true, value: scrub(context, loop.value) };
  if ("errors" in loop) return { ok: false, reason: `reply_check_failed: ${loop.errors.join("; ")}` };
  return { ok: false, reason: loop.failure };
}

async function dispatchPromptAsset(
  context: Context,
  step: TaskSourceV5Step,
  text: string,
  selection: ReturnType<typeof selectionFromArgs>,
  run: { env: Record<string, string>; cwd: string; timeoutMs: number },
) {
  const prepared = await prepareCommandInvocation({
    action: { ref: step.run, ...(text === "" ? {} : { arguments: text }) },
    config: loadConfig(),
    current: { ...selection, workspace: run.cwd, timeout: run.timeoutMs },
  });
  return dispatchPreparedCommandInvocation(prepared, {
    ...(context.options.runAgentImpl ? { runAgent: context.options.runAgentImpl } : {}),
    baseEnv: run.env,
    signal: context.abort.signal,
    eventSource: context.eventSource,
  });
}

/** A task that a step runs is a run of its own: its own state, options, working folder and history. */
async function runTaskStep(
  context: Context,
  record: RunRecord,
  document: TaskSourceV5Document,
  step: TaskSourceV5Step,
  until: number,
  sink: Sink,
): Promise<Done> {
  const ref = step.run as string;
  const found = await locateTaskV5Asset(record.bundle, ref, "tasks", `${record.ref} step ${step.name}`);
  const child = parseDocument(found.file);
  const taskId = taskIdOf(ref);
  const limit = limitOf(until, document, step);
  const lock = child.lock === true ? acquireLock(taskId) : undefined;
  if (lock?.state === "held") throw new Error(`task ${ref} is still running, and it runs one at a time`);
  try {
    const kept = record.children[step.name];
    let run = kept === undefined ? undefined : readRecord(kept.task, kept.run);
    if (run === undefined) {
      run = newRecord(
        context,
        ref,
        taskId,
        found.bundle,
        child,
        record.flags,
        stepInputs(child, step, record.state),
        {},
        record,
        step.name,
      );
      record.children[step.name] = { task: taskId, run: run.runId };
      writeRecord(record);
    }
    const result = await runAttempt(context, run, child, limit);
    sink.lines.push(`task=${ref} status=${result.status} started_at=${result.startedAt}`);
    if (result.status === "completed") return { ok: true, value: result.result, startedAt: result.startedAt };
    return {
      ok: false,
      reason: `task ${ref} ${result.status}${result.detail?.error ? `: ${result.detail.error}` : ""}`,
      startedAt: result.startedAt,
    };
  } finally {
    if (lock) releaseLock(lock.ownership);
  }
}

// ── The environment and secrets ─────────────────────────────────────────────

/**
 * A step's environment: what `--clean` keeps, akm's own location variables, what `inherit:` and `--inherit` name; then
 * the task's `env:` and `secret:`, then the step's, then what the run was started with, each over the one before.
 */
function environmentOf(
  context: Context,
  flags: StartedWith,
  document: TaskSourceV5Document,
  step: TaskSourceV5Step,
): Resolved {
  const key = `${document.source.path}#${step.name}#${JSON.stringify(flags)}`;
  const cached = context.environments.get(key);
  if (cached) return cached;
  const inherit = [...(flags.inherit ?? []), ...(document.options.inherit ?? []), ...(step.options.inherit ?? [])];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(buildChildEnv(context.host, { clean: true, inherit }))) {
    if (value !== undefined) env[name] = value;
  }
  env.AKM_EVENT_SOURCE = context.eventSource;
  const secretValues: string[] = [];
  const apply = (tokens: string[]): void => {
    const injected = resolveInjections(createParsedInvocation(["", "", ...tokens]));
    Object.assign(env, injected.values);
    secretValues.push(...injected.secretValues);
  };
  for (const layer of [document.options, step.options, flags] as const) {
    for (const entry of layer.env ?? []) {
      if (typeof entry === "string") apply(["--env", entry]);
      else for (const [name, value] of Object.entries(entry)) env[name] = String(value);
    }
    if (layer.secret?.length) apply(layer.secret.flatMap((spec) => ["--secret", spec]));
  }
  secretValues.push(...collectInferredSecretValues(env));
  const resolved = { env, secretValues };
  context.environments.set(key, resolved);
  return resolved;
}

/** Every secret value the run can set, in its task and every task it runs, is known from the start. */
async function collectSecrets(
  context: Context,
  ref: string,
  bundle: TaskV5Bundle,
  flags: StartedWith,
  seen: Set<string>,
): Promise<void> {
  const found = await locateTaskV5Asset(bundle, ref, "tasks", ref);
  if (seen.has(found.file)) return;
  seen.add(found.file);
  const document = parseDocument(found.file);
  for (const step of document.steps) {
    if (step.kind === "tasks") await collectSecrets(context, step.run as string, found.bundle, flags, seen);
    else for (const value of environmentOf(context, flags, document, step).secretValues) context.secrets.add(value);
  }
}
