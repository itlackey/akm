// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` unit runner — the one place a frozen workflow spawns a command:
 * argv-only, detached with a SIGTERM→SIGKILL ladder against the process group,
 * cwd-contained by a resolved-path recheck, bounded (timeout, output bytes,
 * context size), with an allowlisted environment ({@link childEnv}). The
 * caller redacts the outcome before anything is journaled.
 * See docs/architecture/decisions/0003-child-env-allowlist-and-provenance.md.
 */

import fs from "node:fs";
import path from "node:path";
import { isWithinAsync } from "../../core/common";
import { COMMON_SPAWN_ENV_PASSTHROUGH, collectAllowlistedEnv, WIN32_SPAWN_ENV_FLOOR } from "../../core/spawn-env";
import {
  type ManagedSubprocessResult,
  runManagedSubprocess,
  type SpawnFn,
  type StreamReadResult,
  streamCaptureFailure,
} from "../../core/subprocess";
import { warn } from "../../core/warn";
import type { WorkflowExecSpec } from "../plan";
import {
  type ExecContextLimits,
  execContextLimits,
  utf8Bytes,
  WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER,
  WORKFLOW_MAX_EXEC_OUTPUT_BYTES,
  WORKFLOW_UNIT_DIAGNOSTIC_CLIP,
} from "../resource-limits";
import type { UnitDispatchResult } from "./unit-dispatch";

/**
 * Max characters of a failed command's stderr tail kept in its diagnostic —
 * below {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP} so the journal's head-first clip
 * of the composed message never cuts the tail.
 */
const EXEC_STDERR_DIAGNOSTIC_CLIP = WORKFLOW_UNIT_DIAGNOSTIC_CLIP - 500;

/**
 * The default environment allowlist for an exec unit's child (`exec.passEnv`
 * extends it): the agent-harness baseline plus names ordinary commands need
 * and `AKM_EVENT_SOURCE`. Credentials, cloud/CI vars, and proxies reach a
 * child only through `pass_env` or `env:`.
 */
export const EXEC_DEFAULT_ENV_PASSTHROUGH: readonly string[] = [
  // PATH, HOME, USER, LANG, LC_ALL, TERM, TMPDIR, AKM_EVENT_SOURCE
  ...COMMON_SPAWN_ENV_PASSTHROUGH,
  // POSIX names a raw shell command needs beyond the agent baseline
  "LOGNAME",
  "SHELL",
  "LC_CTYPE",
  "TZ",
  // SystemRoot, SystemDrive, WINDIR, COMSPEC, PATHEXT, USERPROFILE, HOMEDRIVE,
  // HOMEPATH, TEMP, TMP. Named here as well as appended by `spawnEnvNamesFor`
  // because this list is consumed on POSIX too, where nothing is appended.
  ...WIN32_SPAWN_ENV_FLOOR,
  // Windows toolchain roots, deliberately not part of the floor
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
];

export interface RunExecUnitInput {
  /** Journal id of the attempt, for diagnostics. */
  unitId: string;
  exec: WorkflowExecSpec;
  /**
   * Base working directory the unit's `cwd` resolves inside: the unit's fresh
   * detached worktree under `isolation: worktree`, otherwise the engine's work
   * dir (`ctx.workDir`, default `process.cwd()`).
   */
  baseDir: string;
  /** Resolved `env:` binding values, merged on top of the allowlisted base environment. */
  env?: Record<string, string>;
  /**
   * Engine-authored `AKM_*` context (ids, params, fan-out item + index,
   * declared inputs). Applied LAST so a binding can never shadow it, and size-
   * checked against {@link execContextLimits} for the CURRENT platform before
   * any spawn is attempted.
   */
  context?: Record<string, string>;
  /**
   * The unit declares an `output:` schema, so its stdout will be strictly JSON-
   * parsed and validated. Decides what an output-cap overflow means: a
   * truncated JSON prefix cannot be validated or promoted, so overflow is fatal
   * here and merely marked when absent. See {@link runExecUnit}.
   */
  hasOutputSchema?: boolean;
  /** Resolved wall-clock budget; `null` = the author's explicit `timeout: none`. */
  timeoutMs: number | null;
  signal?: AbortSignal;
  /** Test seam: injected spawn (defaults to the runtime spawn inside `runManagedSubprocess`). */
  spawnFn?: SpawnFn;
  /** Test seam: the platform whose spawn ceilings the context check uses. Defaults to the host's. */
  platform?: string;
  /** The task runner's provenance event source; ambient and authored values still win. */
  eventSource?: string;
}

/**
 * Run one exec unit and map its outcome onto the dispatch vocabulary
 * (`non_zero_exit`, `timeout`, `aborted`, `spawn_failed` — retryable). The
 * `exec_*` reasons (cwd escape, output limit, context too large, incomplete
 * capture) are deliberately outside `retry.on`. Output overflow fails only a
 * unit that declared an `output:` schema.
 */
export async function runExecUnit(input: RunExecUnitInput): Promise<UnitDispatchResult> {
  const cwd = await resolveExecCwd(input);
  if (!cwd.ok) return { ok: false, text: "", failureReason: cwd.failureReason, error: cwd.error };
  const context = checkExecContextSize(input);
  if (context) return context;

  const result = await runManagedSubprocess([...input.exec.command], {
    capture: true,
    cwd: cwd.path,
    env: childEnv(input.exec, input.env, input.context, input.eventSource),
    timeoutMs: input.timeoutMs,
    // stdout is the artifact; retention is bounded (discarding past the cap, never killing).
    maxOutputBytes: WORKFLOW_MAX_EXEC_OUTPUT_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.spawnFn ? { spawnFn: input.spawnFn } : {}),
  });

  const display = describeCommand(input.exec.command);
  if (result.spawnError) {
    return {
      ok: false,
      text: "",
      failureReason: "spawn_failed",
      error: `exec unit "${input.unitId}" could not start ${display}: ${result.spawnError.message}`,
    };
  }
  // Whatever this unit hands back as `text` is marked when stdout was truncated
  // — on the failure paths too, where `text` is a diagnostic that would
  // otherwise read like the command's whole output.
  const stdout = markTruncatedStdout(result);
  // Abort is checked BEFORE timeout: a budget/user cancellation that raced a
  // wall-clock expiry is still a cancellation, and reporting it as `timeout`
  // would let a `retry.on: [timeout]` policy re-dispatch work the caller just
  // cancelled.
  if (result.aborted) {
    return {
      ok: false,
      text: stdout,
      failureReason: "aborted",
      error: `exec unit "${input.unitId}" was cancelled while running ${display}${stderrTail(result.stderr)}`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      text: stdout,
      failureReason: "timeout",
      error:
        `exec unit "${input.unitId}" exceeded its ${input.timeoutMs}ms timeout running ${display} ` +
        `and its process group was terminated${stderrTail(result.stderr)}`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      text: stdout,
      failureReason: "non_zero_exit",
      error: `exec unit "${input.unitId}" ran ${display} and it exited ${result.exitCode}${stderrTail(result.stderr)}`,
    };
  }
  // An exit code of 0 does NOT prove the output was fully captured — see the
  // module note above. Checked before the artifact is promoted, so a partial
  // stdout can never become `steps.<id>.output`.
  const captureFailure = streamCaptureFailure(result.stdoutRead, DRAINED_CLEAN);
  if (captureFailure) {
    return {
      ok: false,
      text: "",
      failureReason: "exec_capture_incomplete",
      error:
        `exec unit "${input.unitId}" ran ${display} and the command COMPLETED (it exited 0), but its stdout could ` +
        `not be fully captured (${captureFailure}), so the stdout artifact would be incomplete. The unit is NOT ` +
        `retried: the command already ran, and re-dispatching identical argv to fix a capture problem would run its ` +
        `side effects a second time. A background descendant still holding stdout open is the usual cause — have ` +
        `the command wait for its children, or redirect their output${stderrTail(result.stderr)}`,
    };
  }
  reportStderrCaptureFailure(input, display, result);
  // The command exited 0 and the pipes drained to their end. The ONE thing an
  // overflow can still ruin is a TYPED artifact: a truncated prefix is not one
  // JSON value, so there is nothing to validate and nothing safe to promote.
  if (result.stdoutRead.overflowed && input.hasOutputSchema) {
    return outputLimitFailure(input, display, result);
  }
  // The artifact is stdout with trailing newlines stripped, like `$(…)`; stderr is diagnostic only.
  return { ok: true, text: stripTrailingNewlines(stdout) };
}

/** A clean drain report, passed as the other pipe so {@link streamCaptureFailure} classifies one. */
const DRAINED_CLEAN: StreamReadResult = {
  text: "",
  timedOut: false,
  overflowed: false,
  bytesRead: 0,
  retainedBytes: 0,
};

/** Warn about an unfinished stderr drain on an otherwise successful unit (its stdout artifact is whole). */
function reportStderrCaptureFailure(input: RunExecUnitInput, display: string, result: ManagedSubprocessResult): void {
  const stderrFailure = streamCaptureFailure(DRAINED_CLEAN, result.stderrRead);
  if (!stderrFailure) return;
  warn(
    `exec unit "${input.unitId}" ran ${display} and it exited 0 with its stdout fully captured, but ` +
      `${stderrFailure}. stderr is a diagnostic channel and never contributes to the artifact, so the unit stands; ` +
      `any stderr shown for it may be missing its tail. A background descendant still holding stderr open is the ` +
      `usual cause.`,
  );
}

/** The sentence naming what the retention cap discarded, shared by both reports below. */
function truncationNote(read: StreamReadResult): string {
  return (
    `the command wrote ${read.bytesRead} bytes to stdout and only the first ${read.retainedBytes} were retained ` +
    `(the ${WORKFLOW_MAX_EXEC_OUTPUT_BYTES}-byte per-pipe capture limit)`
  );
}

/** The captured stdout, with a truncation block naming both byte counts when the cap discarded some. */
function markTruncatedStdout(result: ManagedSubprocessResult): string {
  const read = result.stdoutRead;
  if (!read.overflowed) return result.stdout;
  const discarded = read.bytesRead - read.retainedBytes;
  return (
    `${result.stdout}\n\n[${WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER}] ` +
    `stdout was TRUNCATED: ${truncationNote(read)}. ` +
    `The remaining ${discarded} bytes were read and discarded — the command itself ran to completion, ` +
    `so its exit code is real, but THIS TEXT IS INCOMPLETE and must not be treated as the command's whole output. ` +
    `Have the command write bulk output to a file and print the path, or quiet it down.`
  );
}

/** The output-cap failure for a unit with an `output:` schema: no partial text, byte counts in the message. */
function outputLimitFailure(
  input: RunExecUnitInput,
  display: string,
  result: ManagedSubprocessResult,
): UnitDispatchResult {
  return {
    ok: false,
    text: "",
    failureReason: "exec_output_limit",
    error:
      `exec unit "${input.unitId}" ran ${display}, it exited 0, but ${truncationNote(result.stdoutRead)}. ` +
      `This unit declares an output: schema, so its stdout must parse as exactly one JSON value — a truncated ` +
      `prefix cannot, and promoting it would silently corrupt every downstream reference to the typed artifact. ` +
      `NO artifact was promoted. Have the command write bulk output to a file and print the path, quiet it down, ` +
      `or drop the output: schema if the step does not actually need a typed artifact.`,
  };
}

/**
 * Name the `AKM_*` variable that would not fit in the child's environment on
 * this platform ({@link execContextLimits}), instead of a bare E2BIG from the
 * spawn. Only the engine-authored context is measured.
 */
function checkExecContextSize(input: RunExecUnitInput): UnitDispatchResult | undefined {
  const limits = execContextLimits(input.platform ?? process.platform);
  const entries = Object.entries(input.context ?? {});
  let total = 0;
  for (const [name, value] of entries) {
    const bytes = utf8Bytes(value);
    total += bytes + utf8Bytes(name) + 1;
    if (bytes > limits.perVarBytes) {
      return contextTooLarge(
        input,
        `its ${name} context variable is ${bytes} bytes, over the ${limits.perVarBytes}-byte per-variable limit`,
        name,
        limits,
      );
    }
  }
  if (total > limits.totalBytes) {
    return contextTooLarge(
      input,
      `its AKM_* context variables total ${total} bytes, over the ${limits.totalBytes}-byte limit`,
      entries.map(([name]) => name).join(", "),
      limits,
    );
  }
  return undefined;
}

function contextTooLarge(
  input: RunExecUnitInput,
  what: string,
  names: string,
  limits: ExecContextLimits,
): UnitDispatchResult {
  return {
    ok: false,
    text: "",
    failureReason: "exec_context_too_large",
    error:
      `exec unit "${input.unitId}" cannot be spawned: ${what}. ` +
      `Environment variables (${names}) are how a frozen argv receives data, and this platform caps them ` +
      `(${limits.source}) — spawning would fail with a bare E2BIG. ` +
      `Have the producing step emit a REFERENCE (a file path, an id) instead of inline bulk data, narrow the step's ` +
      `declared inputs:, or reduce the fan-out item size.`,
  };
}

type ResolvedCwd = { ok: true; path: string } | { ok: false; failureReason: string; error: string };

/**
 * Resolve `exec.cwd` inside `baseDir` and prove containment against the
 * resolved base (a symlinked `reports` could point at `/etc`). Async: it runs
 * per unit on the dispatch path.
 */
async function resolveExecCwd(input: RunExecUnitInput): Promise<ResolvedCwd> {
  const base = path.resolve(input.baseDir);
  const target = input.exec.cwd ? path.resolve(base, input.exec.cwd) : base;
  if (!(await isWithinAsync(target, base))) {
    return {
      ok: false,
      failureReason: "exec_cwd_escape",
      error:
        `exec unit "${input.unitId}" declares cwd ${JSON.stringify(input.exec.cwd ?? ".")}, which resolves to ` +
        `${target} — outside its working directory ${base}. Refusing to run outside the unit's tree.`,
    };
  }
  if (!(await isExistingDirectory(target))) {
    return {
      ok: false,
      failureReason: "spawn_failed",
      error: `exec unit "${input.unitId}" cannot run: its working directory ${target} does not exist or is not a directory.`,
    };
  }
  return { ok: true, path: target };
}

async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The child's environment, in precedence order: the allowlist plus
 * `exec.passEnv`; the resolved `env:` bindings; then the engine's `AKM_*`
 * context, last so a binding cannot shadow it.
 */
function childEnv(
  exec: WorkflowExecSpec,
  bindings: Record<string, string> | undefined,
  context: Record<string, string> | undefined,
  eventSource: string | undefined,
): Record<string, string> {
  const env = collectAllowlistedEnv(execAllowlist(exec));
  // Only when absent from the base, and before the overlays, so ambient and authored values win.
  if (eventSource !== undefined && env.AKM_EVENT_SOURCE === undefined) {
    env.AKM_EVENT_SOURCE = eventSource;
  }
  for (const [name, value] of Object.entries(bindings ?? {})) env[name] = value;
  for (const [name, value] of Object.entries(context ?? {})) env[name] = value;
  return env;
}

/** The unit's effective allowlist: the shared default plus its own `passEnv` names. */
function execAllowlist(exec: WorkflowExecSpec): string[] {
  return exec.passEnv ? [...EXEC_DEFAULT_ENV_PASSTHROUGH, ...exec.passEnv] : [...EXEC_DEFAULT_ENV_PASSTHROUGH];
}

/** `argv[0]` plus its argument count — never the full argv, which can carry values. */
function describeCommand(command: readonly string[]): string {
  const rest = command.length - 1;
  return `${JSON.stringify(command[0])} (${rest} argument${rest === 1 ? "" : "s"})`;
}

/** The tail of a failed command's stderr, clipped and explicitly marked when truncated. */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  if (trimmed.length <= EXEC_STDERR_DIAGNOSTIC_CLIP) return `. stderr:\n${trimmed}`;
  return `. stderr (last ${EXEC_STDERR_DIAGNOSTIC_CLIP} chars):\n…${trimmed.slice(-EXEC_STDERR_DIAGNOSTIC_CLIP)}`;
}

/** Strip trailing line terminators, matching shell `$(…)` command substitution. */
function stripTrailingNewlines(text: string): string {
  return text.replace(/(?:\r?\n)+$/, "");
}
