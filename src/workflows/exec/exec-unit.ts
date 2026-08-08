// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` unit runner — the ONE place a frozen workflow spawns a shell
 * command as a unit.
 *
 * ## Why argv, never a shell string
 *
 * {@link IrExecSpec.command} is an argv ARRAY and the format has no
 * shell-string spelling at all. The child is spawned directly
 * ({@link runManagedSubprocess} → the runtime spawn), so no shell ever parses
 * the words: `;`, `|`, `&&`, `$(…)`, backticks, `>` and `*` are inert literal
 * argument BYTES. The entire quoting/injection class that a
 * `sh -c "<string>"` surface opens is therefore structurally absent rather
 * than defended against. A workflow that genuinely wants a pipeline names the
 * interpreter itself (`["bash", "-lc", "a | b"]`) — which makes the decision
 * visible in the frontmatter diff instead of hiding it behind a convenience.
 *
 * ## Non-blocking, and no leaked children
 *
 * Everything here is async. `spawnSync` on the dispatch path would block the
 * event loop and with it every concurrently-scheduled unit, the run's lease
 * heartbeat, and abort handling — so it is never used.
 * {@link runManagedSubprocess} spawns the child DETACHED (its own process
 * group) and runs a SIGTERM→SIGKILL ladder against the whole group on timeout
 * or abort, so a killed command cannot leave orphaned descendants behind, and
 * `--timeout` / Ctrl-C really do stop a running command.
 *
 * ## Containment
 *
 * `exec.cwd` is relative and `..`-free by construction (the parser and the
 * frozen-plan decoder both reject anything else through
 * `isContainedRelativePath`). This module re-checks the RESOLVED path against
 * the resolved base with {@link isWithin} — symlinks included — immediately
 * before spawning, so a checkout that contains a symlinked subdirectory cannot
 * be used to step outside the unit's working tree (the run's work dir, or the
 * unit's fresh worktree under `isolation: worktree`).
 *
 * ## Everything the command can spend is BOUNDED
 *
 * A command is arbitrary code with no lifetime or resource discipline of its
 * own, so every resource it can consume on akm's behalf has a named ceiling in
 * `workflows/resource-limits.ts`:
 *
 *   - WALL CLOCK — {@link DEFAULT_EXEC_TIMEOUT_MS} (or the authored `timeout:`),
 *     enforced by the TERM→KILL ladder.
 *   - RETAINED OUTPUT — {@link WORKFLOW_MAX_EXEC_OUTPUT_BYTES} per pipe. Without
 *     it, capture is bounded only by the command's exit, so `yes` exhausts the
 *     akm process's memory long before the timeout fires. The cap bounds MEMORY
 *     ONLY: past it the reader drains-and-discards, the command runs to
 *     completion and its real exit code stands. What overflow costs is the
 *     ARTIFACT's completeness, and that is never hidden — see
 *     {@link runExecUnit}.
 *   - CONTEXT ENVIRONMENT — {@link execContextLimits} for THIS platform, checked
 *     BEFORE the spawn so an oversized artifact yields an actionable akm error
 *     rather than the OS's bare `E2BIG`.
 *
 * ## The child's environment is an ALLOWLIST
 *
 * The child does NOT inherit akm's environment. It starts EMPTY and receives
 * exactly {@link EXEC_DEFAULT_ENV_PASSTHROUGH} (plus the unit's own
 * `exec.passEnv` names), then the resolved `env:` bindings, then the
 * engine-authored `AKM_*` context. `exec.inheritEnv` opts back into full
 * inheritance. See {@link childEnv} for why.
 *
 * ## Secrets
 *
 * `env` values reaching this module are already resolved from `env:` bindings
 * by NAME (`resolveEnvBinding`) — the plan never carries inline secrets, and
 * the input hash only ever carries the names. The caller collects those exact
 * values through the shared `collectWorkflowDispatchSensitiveValues` and scrubs
 * the outcome with `redactUnitOutcome` BEFORE anything is journaled, which is
 * why this module may return raw stdout/stderr diagnostics without knowing
 * anything about redaction itself.
 *
 * Layering: a LEAF. It imports only node built-ins, `core/common`,
 * `core/spawn-env`, `core/subprocess` and the import-free
 * `workflows/resource-limits` (plus erased types), so the executor can consume
 * it without opening an import cycle.
 *
 * @module workflows/exec/exec-unit
 */

import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../../core/common";
import { collectAllowlistedEnv } from "../../core/spawn-env";
import {
  type ManagedSubprocessResult,
  runManagedSubprocess,
  type SpawnFn,
  streamCaptureFailure,
} from "../../core/subprocess";
import type { IrExecSpec } from "../ir/schema";
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
 * Max characters of a failed command's stderr retained in the unit's `error`
 * diagnostic.
 *
 * Deliberately BELOW {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP}: the composed
 * diagnostic reads `<what happened>. stderr (last N chars): <tail>`, and the
 * journal clips that COMPOSED string head-first. Reserving 500 characters for
 * the prefix keeps the whole stderr tail — the part that actually says why the
 * command failed — inside the journaled and displayed diagnostic, instead of
 * losing its final few hundred characters to the outer clip.
 */
export const EXEC_STDERR_DIAGNOSTIC_CLIP = WORKFLOW_UNIT_DIAGNOSTIC_CLIP - 500;

/**
 * The DEFAULT environment allowlist for an exec unit's child — the single
 * definition, mirrored nowhere else (the docs describe it, the tests assert
 * against it, and `exec.passEnv` extends it per unit).
 *
 * The child starts from an EMPTY environment and receives only these names,
 * matching how an agent harness child is already built
 * (`profile.envPassthrough` → `collectAllowlistedEnv`). Every entry earns its
 * place by being load-bearing for ordinary commands on some supported
 * platform:
 *
 *   - `PATH`        — command resolution. Without it only an absolute `argv[0]`
 *                     can ever be spawned.
 *   - `HOME`        — the config/cache root essentially every toolchain reads
 *                     (git, npm, bun, cargo, ssh). Absent, tools fall back to
 *                     `/` or fail outright.
 *   - `USER`, `LOGNAME` — process identity; git and ssh read them to attribute
 *                     and authenticate.
 *   - `SHELL`       — read by tools that re-exec a login shell for the user's
 *                     own environment (an explicit `["bash", "-lc", …]` argv
 *                     does not need it, but `git`'s pagers/editors do).
 *   - `LANG`, `LC_ALL`, `LC_CTYPE` — text encoding. Without a locale a command
 *                     falls back to the C locale and mangles non-ASCII stdout,
 *                     which IS this unit's artifact.
 *   - `TERM`        — some CLIs abort or emit raw escape bytes with no TERM.
 *   - `TZ`          — timestamps a command prints would otherwise silently
 *                     switch to the host default.
 *   - `TMPDIR`      — POSIX scratch space; absent, tools write to `/tmp` or
 *                     fail on read-only hosts.
 *   - `SystemRoot`, `SystemDrive`, `WINDIR` — Windows PROCESS CREATION itself
 *                     needs these: with an empty environment the loader cannot
 *                     find system DLLs and the spawn fails before the command
 *                     runs. Not optional on win32.
 *   - `COMSPEC`     — Windows resolves `.bat`/`.cmd` targets through cmd.exe.
 *   - `PATHEXT`     — Windows only treats these extensions as executable; an
 *                     absent PATHEXT makes `command: ["bun", …]` unresolvable
 *                     because `bun.exe`/`bun.cmd` are never tried.
 *   - `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` — the Windows `HOME` analogues.
 *   - `APPDATA`, `LOCALAPPDATA` — Windows config/cache roots (npm, bun, git).
 *   - `TEMP`, `TMP` — the Windows `TMPDIR` analogues.
 *   - `ProgramData`, `ProgramFiles` — machine-wide install roots that Windows
 *                     toolchain shims resolve against.
 *   - `AKM_EVENT_SOURCE` — provenance, never a secret: an exec unit that calls
 *                     `akm` must record machine traffic rather than user
 *                     demand, exactly as the agent passthrough list does
 *                     (`integrations/agent/profiles.ts`, DRIFT-6).
 *
 * Deliberately ABSENT and reachable only through `exec.passEnv` / `env:` /
 * `exec.inheritEnv`: credentials of every kind, cloud/CI vars, and the proxy
 * family (`HTTP_PROXY` & friends) — proxy URLs routinely embed credentials,
 * which is why akm's redaction policy already treats URL-shaped passthrough
 * values as credential-bearing.
 */
export const EXEC_DEFAULT_ENV_PASSTHROUGH: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramData",
  "ProgramFiles",
  "AKM_EVENT_SOURCE",
];

export interface RunExecUnitInput {
  /** Journal id of the attempt, for diagnostics. */
  unitId: string;
  exec: IrExecSpec;
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
}

/**
 * Run one exec unit and map its process outcome onto the dispatch vocabulary.
 *
 * Failure-reason mapping (all values are pre-existing `AgentFailureReason`
 * members — the taxonomy gains nothing, so `retry.on` keeps working unchanged
 * and `tests/integration/workflows/schema-drift.test.ts` stays green):
 *
 *   - non-zero exit          → `non_zero_exit`
 *   - wall-clock expiry      → `timeout`   (after the TERM→KILL ladder)
 *   - cancellation           → `aborted`
 *   - the child never started → `spawn_failed` (missing binary, unusable cwd)
 *   - the capture never completed → `spawn_failed`, matching the agent spawn
 *     path's treatment of the same condition (see below)
 *
 * The out-of-taxonomy `exec_cwd_escape`, `exec_output_limit` and
 * `exec_context_too_large` are deliberate: each is tampering, a runaway, or an
 * authoring bug — never a transient — so no `retry.on` value can ever
 * re-dispatch one, and `PROGRAM_RETRY_REASONS` (and the drift test that pins it)
 * stays exactly as it is.
 *
 * ## An INCOMPLETE capture is a failure, never a partial artifact
 *
 * `exitCode === 0` is not on its own proof that stdout was fully read. A pipe
 * can error, and `runManagedSubprocess`'s stream-drain timeout can fire while
 * the command LEADER has already exited 0 because a background descendant still
 * holds the stdout fd open. Both leave `result.stdout` holding a PREFIX of the
 * real output. Promoting that prefix would hand the next step, the gate judge
 * and `steps.<id>.output` a silently truncated artifact, so the unit fails
 * instead — and it fails with the same reason and the same shared classifier
 * (`streamCaptureFailure`) the agent spawn path uses, so the two dispatch paths
 * agree on what "the capture did not complete" means.
 *
 * ## Output OVERFLOW does not fail a command that passed
 *
 * Crossing {@link WORKFLOW_MAX_EXEC_OUTPUT_BYTES} is NOT the same condition. The
 * capture succeeded — the reader drained the pipe to its end — it just stopped
 * RETAINING past the cap, so the child never blocked and its exit code is real.
 * Failing a passing-but-chatty test suite over its log volume would be a
 * tripwire: machinery that makes a run fail where it would otherwise have
 * succeeded, for no benefit the cap needs. So overflow splits by what the unit
 * PROMISED about its output:
 *
 *   - NO declared `output:` schema → the unit succeeds on exit 0 and its
 *     artifact is the retained prefix with a
 *     {@link WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER} block appended naming the
 *     total and retained byte counts. Nothing is hidden and nothing is silently
 *     shortened — a reader (human, gate judge, or downstream step) sees the
 *     marker or sees a complete artifact, never a truncated one wearing a
 *     complete one's clothes.
 *   - a declared `output:` schema → `exec_output_limit`, still. stdout must
 *     parse as EXACTLY one JSON value; a truncated prefix cannot, validating it
 *     is meaningless, and promoting it would corrupt every downstream reference
 *     to a typed artifact. That is the residual failure the cap genuinely
 *     justifies, and it keeps its out-of-taxonomy no-retry rationale: the
 *     command is deterministic, so re-dispatching it can only spend the budget
 *     to produce the same oversized output again.
 *
 * stderr overflow never fails anything: stderr is a diagnostic channel, and
 * {@link EXEC_STDERR_DIAGNOSTIC_CLIP} already bounds and marks what reaches the
 * journal.
 */
export async function runExecUnit(input: RunExecUnitInput): Promise<UnitDispatchResult> {
  const cwd = resolveExecCwd(input);
  if (!cwd.ok) return { ok: false, text: "", failureReason: cwd.failureReason, error: cwd.error };
  const context = checkExecContextSize(input);
  if (context) return context;

  const result = await runManagedSubprocess([...input.exec.command], {
    capture: true,
    cwd: cwd.path,
    env: childEnv(input.exec, input.env, input.context),
    timeoutMs: input.timeoutMs,
    // stdout IS this unit's artifact, so RETENTION is BOUNDED: an unbounded
    // capture is memory the akm process spends on a command's behalf with no
    // ceiling at all until it exits or the (default 10-minute) budget expires.
    // The cap discards past the bound rather than killing — the command's own
    // outcome is not akm's memory problem to solve.
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
  const captureFailure = streamCaptureFailure(result.stdoutRead, result.stderrRead);
  if (captureFailure) {
    return {
      ok: false,
      text: "",
      failureReason: "spawn_failed",
      error:
        `exec unit "${input.unitId}" ran ${display} and it exited 0, but its output capture did not complete ` +
        `(${captureFailure}), so the stdout artifact would be incomplete. A background descendant still holding ` +
        `stdout open is the usual cause — have the command wait for its children, or redirect their output` +
        `${stderrTail(result.stderr)}`,
    };
  }
  // The command exited 0 and the pipes drained to their end. The ONE thing an
  // overflow can still ruin is a TYPED artifact: a truncated prefix is not one
  // JSON value, so there is nothing to validate and nothing safe to promote.
  if (result.stdoutRead.overflowed && input.hasOutputSchema) {
    return outputLimitFailure(input, display, result);
  }
  // The promoted artifact is STDOUT. Trailing newlines are stripped, exactly
  // like shell command substitution `$(…)`, so a one-line command's artifact is
  // the value an author expects rather than the value plus a `\n`. stderr is a
  // diagnostic channel only and never contributes to the artifact. When stdout
  // overflowed, `stdout` already carries the truncation marker (which is
  // deliberately the LAST thing in the artifact, so it survives the strip).
  return { ok: true, text: stripTrailingNewlines(stdout) };
}

/**
 * The captured stdout, with an unmistakable truncation block appended when the
 * retention cap discarded part of it.
 *
 * Same idiom, same reason as `WORKFLOW_EVIDENCE_TRUNCATED_MARKER`
 * (`runtime/runs.ts`): truncated data must never be mistakable for complete
 * data. The block names both byte counts, so a reader can see exactly how much
 * is missing rather than inferring it from a suspiciously round length.
 */
function markTruncatedStdout(result: ManagedSubprocessResult): string {
  const read = result.stdoutRead;
  if (!read.overflowed) return result.stdout;
  const total = read.bytesRead ?? 0;
  const retained = read.retainedBytes ?? 0;
  return (
    `${result.stdout}\n\n[${WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER}] ` +
    `stdout was TRUNCATED: the command wrote ${total} bytes and only the first ${retained} were retained ` +
    `(the ${WORKFLOW_MAX_EXEC_OUTPUT_BYTES}-byte per-pipe capture limit). ` +
    `The remaining ${total - retained} bytes were read and discarded — the command itself ran to completion, ` +
    `so its exit code is real, but THIS TEXT IS INCOMPLETE and must not be treated as the command's whole output. ` +
    `Have the command write bulk output to a file and print the path, or quiet it down.`
  );
}

/**
 * The output-cap failure for a unit that declared an `output:` schema —
 * deliberately UNMISTAKABLE.
 *
 * `text` is emptied rather than carrying the partial capture: for a failed unit
 * `text` is only a diagnostic (the durable evidence graph keeps a failure's
 * `failureReason` alone), and handing back several megabytes of a runaway
 * command's output as "the text" would just move the memory problem one layer
 * up. The byte counts go in the message instead, so the operator can see how far
 * past the cap the command ran.
 */
function outputLimitFailure(
  input: RunExecUnitInput,
  display: string,
  result: ManagedSubprocessResult,
): UnitDispatchResult {
  const total = result.stdoutRead.bytesRead ?? 0;
  const retained = result.stdoutRead.retainedBytes ?? 0;
  return {
    ok: false,
    text: "",
    failureReason: "exec_output_limit",
    error:
      `exec unit "${input.unitId}" ran ${display}, it exited 0, but it wrote ${total} bytes to stdout and only ` +
      `the first ${retained} were retained (the ${WORKFLOW_MAX_EXEC_OUTPUT_BYTES}-byte per-pipe capture limit). ` +
      `This unit declares an output: schema, so its stdout must parse as exactly one JSON value — a truncated ` +
      `prefix cannot, and promoting it would silently corrupt every downstream reference to the typed artifact. ` +
      `NO artifact was promoted. Have the command write bulk output to a file and print the path, quiet it down, ` +
      `or drop the output: schema if the step does not actually need a typed artifact.`,
  };
}

/**
 * Refuse to spawn when the engine-authored `AKM_*` context would not fit in the
 * child's environment ON THIS PLATFORM.
 *
 * A workflow artifact has no bound comparable to an OS environment entry, so a
 * perfectly legitimate declared input can serialize into an `AKM_INPUTS` far
 * past what `execve` accepts. Left unchecked that surfaces as a bare `E2BIG`
 * from the spawn syscall — reported as `spawn_failed` with a message about
 * "argument list too long" that names neither the variable nor the artifact
 * that produced it. Checking here converts it into a located, actionable
 * failure BEFORE process creation is attempted.
 *
 * ## The ceiling is the CURRENT platform's, never the smallest one
 *
 * That translation is this check's ONLY job, which fixes its bound exactly: the
 * limits come from {@link execContextLimits} for the platform the run is on. A
 * guard that applied Windows' 32 767-character ceiling on Linux would fail
 * spawns the kernel would happily have accepted — inventing a failure instead of
 * explaining an inevitable one, which is a tripwire and not a guard. Workflows
 * that must also run on Windows should stay under the smaller bound; that is
 * documented guidance (`docs/reference/workflow-schema.md`), not something a
 * Linux host enforces.
 *
 * Only the engine-authored context is measured. The unit's `env:` bindings are
 * authored values a human wrote and sized; this is the surface where the SIZE
 * is data-dependent and therefore surprising.
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
 * RESOLVED base (symlinks included). The syntactic checks the parser and the
 * decoder already ran are necessary but not sufficient: `reports` can be a
 * symlink to `/etc`, and only a realpath comparison catches that.
 */
function resolveExecCwd(input: RunExecUnitInput): ResolvedCwd {
  const base = path.resolve(input.baseDir);
  const target = input.exec.cwd ? path.resolve(base, input.exec.cwd) : base;
  if (!isWithin(target, base)) {
    return {
      ok: false,
      failureReason: "exec_cwd_escape",
      error:
        `exec unit "${input.unitId}" declares cwd ${JSON.stringify(input.exec.cwd ?? ".")}, which resolves to ` +
        `${target} — outside its working directory ${base}. Refusing to run outside the unit's tree.`,
    };
  }
  if (!isExistingDirectory(target)) {
    return {
      ok: false,
      failureReason: "spawn_failed",
      error: `exec unit "${input.unitId}" cannot run: its working directory ${target} does not exist or is not a directory.`,
    };
  }
  return { ok: true, path: target };
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The child's environment, in three layers with fixed precedence:
 *
 *   1. the BASE — an allowlist by default ({@link EXEC_DEFAULT_ENV_PASSTHROUGH}
 *      plus the unit's `exec.passEnv` names), or the akm process's whole
 *      environment when the unit opted in with `exec.inheritEnv`;
 *   2. the unit's resolved `env:` bindings;
 *   3. the engine-authored `AKM_*` context, LAST so a workflow-supplied binding
 *      can never shadow the ids/item the engine is telling the command the
 *      truth about.
 *
 * ## Why the default is an allowlist
 *
 * Not because it stops an attacker: a command that runs at all can read the
 * same credentials off disk that the environment would have handed it, and a
 * workflow source is executed code either way (`docs/guides/run-workflows.md`,
 * "workflow sources are executed code"). The allowlist earns its place for
 * three narrower, real reasons:
 *
 *   - it bounds ACCIDENTAL exposure — the ambient shell of whoever ran
 *     `akm workflow run` (or the CI job that did) routinely carries tokens for
 *     unrelated services, and a third-party workflow step that merely prints
 *     its environment, or a tool that ships one in a crash report, should not
 *     get them for free;
 *   - it makes the environment surface EXPLICIT and REVIEWABLE — what a
 *     command can see is this constant plus lines in the frontmatter diff,
 *     rather than "whatever the invoking shell happened to export";
 *   - it matches the convention akm already applies to spawned children —
 *     `profile.envPassthrough` in `integrations/agent/spawn.ts` has always
 *     built agent-harness children this way, and the SAME
 *     {@link collectAllowlistedEnv} does it here, so there is one mechanism to
 *     review instead of two.
 *
 * `inheritEnv` is the honest escape hatch for a command that genuinely needs
 * the caller's whole environment; it passes it through VERBATIM (no PATH
 * supplementation), which is precisely the pre-allowlist behavior.
 */
function childEnv(
  exec: IrExecSpec,
  bindings: Record<string, string> | undefined,
  context: Record<string, string> | undefined,
): Record<string, string> {
  const env = exec.inheritEnv ? inheritedProcessEnv() : collectAllowlistedEnv(execAllowlist(exec));
  for (const [name, value] of Object.entries(bindings ?? {})) env[name] = value;
  for (const [name, value] of Object.entries(context ?? {})) env[name] = value;
  return env;
}

/** The unit's effective allowlist: the shared default plus its own `passEnv` names. */
function execAllowlist(exec: IrExecSpec): string[] {
  return exec.passEnv ? [...EXEC_DEFAULT_ENV_PASSTHROUGH, ...exec.passEnv] : [...EXEC_DEFAULT_ENV_PASSTHROUGH];
}

/** The akm process's own environment, verbatim (`exec.inheritEnv`). */
function inheritedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
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
export function stripTrailingNewlines(text: string): string {
  return text.replace(/(?:\r?\n)+$/, "");
}
