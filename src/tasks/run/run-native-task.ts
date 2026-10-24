// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The shell + frozen-script dispatch arm: `runNativeTask`, plus its
 * shell-command builders (`shellCommand`, `resolveLeadingBareAkmCommand`,
 * `quoteShellArgument`).
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:294-455).
 *
 * F-1 (spec §5.2 point 1): the child env's `AKM_EVENT_SOURCE` stamp now reads
 * `provenance.eventSource` instead of the hardcoded literal `"task"` — with
 * the default provenance context (run/provenance.ts) this is byte-equivalent
 * to before (P-06 stays green unchanged).
 *
 * F-2 (D8, spec §5.3): the result's `target` is now `{kind:"shell", cmd}` or
 * `{kind:"script", cmd}` — formerly one shared `{kind:"command", cmd}`.
 */

import path from "node:path";
import { assertNever } from "../../core/assert";
import type { TaskLogLineInput } from "../../core/logs-db";
import { runManagedSubprocess, type SpawnFn, streamCaptureFailure } from "../../core/subprocess";
import { assertFrozenDirectoryContained } from "../../execution/directory-identity";
import { cleanupFrozenScript, frozenScriptCommand, materializeFrozenScript } from "../frozen-script";
import type { ExecutionProvenanceContext } from "../model/invocation";
import type { PreparedTaskV3Script, PreparedTaskV3Shell } from "../prepare/prepared-execution";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { finishAttempt } from "./attempt-lifecycle";
import { DEFAULT_SCHEDULED_TASK_TIMEOUT_MS } from "./run-workflow-task";
import { appendHistory } from "./task-history";
import { persistRunLog, streamLines } from "./task-log";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

/**
 * Resolve the host shell to something spawnable in a scheduler-fired process.
 *
 * A scheduled run restores the PATH captured at install time
 * (scheduler-invocation.ts), which can be minimal — the native-scheduler CI
 * gate installs with PATH = System32 + SystemRoot, modeling what a real
 * scheduler hands a job. powershell.exe does not live in System32 itself but
 * in the WindowsPowerShell\v1.0 subdirectory, so a bare "powershell" spawn
 * resolves only when that PATH happens to carry the extra entry; cmd.exe has
 * a canonical ComSpec location for the same reason. Resolve both absolutely
 * on Windows. pwsh has no fixed install location and the POSIX shells always
 * live on the scheduler's default /bin:/usr/bin, so those stay PATH-resolved.
 *
 * Exported for direct unit testing with an explicit platform/env.
 */
export function shellExecutable(
  shell: PreparedTaskV3Shell["shell"],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return shell;
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  if (shell === "powershell") {
    return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  if (shell === "cmd") {
    return env.ComSpec ?? path.win32.join(systemRoot, "System32", "cmd.exe");
  }
  return shell;
}

/** Exported for direct unit testing with an explicit platform/env. */
export function shellCommand(
  task: Pick<PreparedTaskV3Shell, "command" | "shell">,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const command = resolveLeadingBareAkmCommand(task.command, task.shell);
  switch (task.shell) {
    case "sh":
    case "bash":
    case "zsh":
      return [task.shell, "-c", command];
    case "pwsh":
    case "powershell":
      return [
        shellExecutable(task.shell, platform, env),
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        withExitCodePropagation(command),
      ];
    case "cmd":
      return [shellExecutable("cmd", platform, env), "/d", "/s", "/c", command];
    default:
      return assertNever(task.shell, "shellCommand");
  }
}

/**
 * `-Command` (documented identically for powershell.exe 5.1 and pwsh 7+, in
 * about_PowerShell_exe / about_Pwsh) already derives its own process exit
 * code from `$?`, so a genuinely failing last statement already yields a
 * nonzero exit and status "failed" — but any native exit code outside {0, 1}
 * is collapsed to 1, discarding the real value that task history reports.
 *
 * Appending a bare `exit $LASTEXITCODE` to recover it is unsafe on its own:
 * `$LASTEXITCODE` stays `$null` for a command that never runs a native
 * executable (a pure PowerShell/cmdlet command), and `exit $null` resolves
 * to exit code 0 — turning a failed cmdlet into a false "completed".
 *
 * Reading `$?` first, before anything else can run, reproduces -Command's
 * own completed/failed determination exactly (immune to that regression and
 * to a `$LASTEXITCODE` left stale by an earlier native call in the same
 * command), then upgrades to the precise native exit code only when the
 * failing last statement actually set one.
 */
function withExitCodePropagation(command: string): string {
  return `${command}; if ($?) { exit 0 } elseif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE } else { exit 1 }`;
}

/**
 * Bind an unambiguous leading bare `akm` (including the task-v2 migrator's
 * quoted form) to this installation. Explicit paths and arbitrary shell
 * fragments remain author-controlled.
 */
function resolveLeadingBareAkmCommand(command: string, shell: PreparedTaskV3Shell["shell"]): string {
  const leadingBareAkm = /^(\s*)(?:akm(?:\.exe)?|'akm(?:\.exe)?'|"akm(?:\.exe)?")(?=$|[\s;|&])/i;
  if (!leadingBareAkm.test(command)) return command;
  const quoted = resolveAkmInvocation()
    .argv.map((part) => quoteShellArgument(part, shell))
    .join(" ");
  // PowerShell parses a quoted string in command position as a string
  // EXPRESSION, not an invocation — `'C:\akm.exe' --version` is a parse
  // error. The call operator makes it a command. sh and cmd both treat a
  // quoted word in command position as the command, so only PowerShell
  // needs the prefix.
  const invocation = shell === "pwsh" || shell === "powershell" ? `& ${quoted}` : quoted;
  return command.replace(leadingBareAkm, (_match, leadingWhitespace: string) => `${leadingWhitespace}${invocation}`);
}

function quoteShellArgument(value: string, shell: PreparedTaskV3Shell["shell"]): string {
  switch (shell) {
    case "sh":
    case "bash":
    case "zsh":
      return `'${value.replaceAll("'", `'"'"'`)}'`;
    case "pwsh":
    case "powershell":
      return `'${value.replaceAll("'", "''")}'`;
    case "cmd":
      return `"${value.replaceAll('"', '""')}"`;
    default:
      return assertNever(shell, "quoteShellArgument");
  }
}

export async function runNativeTask(input: {
  task: PreparedTaskV3Shell | PreparedTaskV3Script;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  historyReserved: boolean;
  provenance: ExecutionProvenanceContext;
  spawnFn?: SpawnFn;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, historyReserved, provenance } = input;
  let materialized: { directory: string; file: string } | undefined;
  let cmd: string[] = task.kind === "shell" ? shellCommand(task) : [];

  // Unset → the unattended default; `null` → the explicit no-timeout opt-out.
  const timeoutMs = task.timeoutMs !== undefined ? task.timeoutMs : DEFAULT_SCHEDULED_TASK_TIMEOUT_MS;

  const header =
    task.kind === "shell"
      ? `[akm task] task=${task.taskId} kind=run shell=${task.shell}`
      : `[akm task] task=${task.taskId} kind=script ref=${task.sourceRef} sha256=${task.sha256}`;
  const logLines: string[] = [header];
  const dbLines: TaskLogLineInput[] = [{ line: header }];

  let exitCode: number | null = null;

  // #956: the task runner's OWN process (`akm task run`, launched by cron /
  // launchd / schtasks, or forwarded a SIGTERM by the published launcher)
  // had no way to end its detached, own-process-group
  // child (spawned by `runManagedSubprocess` for the group-kill guarantee
  // above) — a timeout or SIGTERM to the direct child would reap the whole
  // group, but nothing tied THIS process's own termination to that same
  // ladder, so a signal to the runner left its child running as an orphan.
  // Aborting `runManagedSubprocess` here runs its normal SIGTERM→SIGKILL
  // kill ladder against the child's process group.
  const abortController = new AbortController();
  const forwardTerminationSignal = (signal: NodeJS.Signals): void => {
    abortController.abort(new Error(`task runner received ${signal}`));
  };
  const onSigterm = () => forwardTerminationSignal("SIGTERM");
  const onSigint = () => forwardTerminationSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    // Re-resolve the authored root/cwd immediately before spawn so a
    // symlink, ancestor, bundle-root, or directory/file swap cannot redirect
    // execution outside that physical workspace. This is a live containment
    // check, not an identity comparison — it does not care whether the
    // underlying device/inode changed (e.g. a remount), only whether the
    // resolved cwd still lives inside its root.
    assertFrozenDirectoryContained(task.cwdIdentity);
    if (task.kind === "script") {
      materialized = materializeFrozenScript(task);
      cmd = frozenScriptCommand(task, materialized.file);
    }
    // Managed spawn (src/core/subprocess.ts): process-GROUP kill so a timeout
    // reaps the whole command tree (no orphans), and a SIGTERM→SIGKILL ladder
    // so a child that ignores SIGTERM can't wedge the run forever. `signal`
    // ties that same ladder to a termination signal received by this
    // process itself (#956), not only to the timeout.
    const result = await runManagedSubprocess(cmd, {
      capture: true,
      cwd: task.cwd,
      // Stamp task-runner provenance so any akm invocation in the command tree
      // records usage events as machine traffic, not user demand (DRIFT-6).
      // A more specific stamp already in the environment (e.g. improve's
      // AKM_EVENT_SOURCE=improve on its child spawns) still wins in children.
      env: {
        ...process.env,
        ...task.environment,
        AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? provenance.eventSource,
      },
      // cmd.exe's `/S /C` reads its tail as one hand-quoted command line, not
      // standard argv — shellCommand() already built and quoted it for that.
      // The default per-argument escaping would add an incompatible second
      // layer on top and break any resolved path containing a space.
      windowsVerbatimArguments: task.kind === "shell" && task.shell === "cmd",
      timeoutMs,
      signal: abortController.signal,
      ...(input.spawnFn ? { spawnFn: input.spawnFn } : {}),
      ...(input.setTimeoutFn ? { setTimeoutFn: input.setTimeoutFn } : {}),
      ...(input.clearTimeoutFn ? { clearTimeoutFn: input.clearTimeoutFn } : {}),
    });
    // A synchronous spawn throw / exit rejection surfaces as spawn_error below.
    if (result.spawnError) throw result.spawnError;

    const { stdout, stderr, timedOut } = result;
    exitCode = result.exitCode ?? (timedOut ? 143 : 1);

    // A pipe that errored or stopped draining yields EMPTY output that is
    // otherwise indistinguishable from a command that printed nothing — the
    // log reads like a clean success. Say so instead, the way the workflow
    // (exec-unit.ts) and agent (agent/spawn.ts) capture paths already do.
    const captureFailure = streamCaptureFailure(result.stdoutRead, result.stderrRead);
    if (captureFailure) {
      const line = `output_capture_incomplete=${captureFailure}`;
      logLines.push(line);
      dbLines.push({ level: "warn", line });
    }

    if (timedOut) {
      logLines.push(`timed_out=true timeout_ms=${timeoutMs}`);
      dbLines.push({ level: "error", line: `timed_out=true timeout_ms=${timeoutMs}` });
    }
    logLines.push(`exit_code=${exitCode}`);
    dbLines.push({ level: exitCode === 0 ? "info" : "error", line: `exit_code=${exitCode}` });
    if (stdout) {
      logLines.push("--- stdout ---");
      logLines.push(stdout);
      dbLines.push(...streamLines(stdout, "stdout", "info"));
    }
    if (stderr) {
      logLines.push("--- stderr ---");
      logLines.push(stderr);
      dbLines.push(...streamLines(stderr, "stderr", "error"));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLines.push(`spawn_error=${msg}`);
    dbLines.push({ level: "error", line: `spawn_error=${msg}` });
    exitCode = 1;
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    if (materialized) cleanupFrozenScript(materialized);
  }

  const finishedAt = finishAttempt(startedAt, now());
  persistRunLog({
    taskId: task.taskId,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: `${logLines.join("\n")}\n`,
    dbLines,
    redactNames: task.redact,
    environment: task.environment,
  });
  const status: TaskRunStatus = exitCode === 0 ? "completed" : "failed";
  const result: TaskRunResult = {
    id: task.taskId,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: task.kind === "shell" ? { kind: "shell", cmd } : { kind: "script", cmd },
    detail: { exitCode },
  };
  appendHistory(result, historyReserved);
  return result;
}
