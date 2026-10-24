// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Managed-subprocess primitive.
 *
 * The battle-tested spawn/timeout/abort/capture core, extracted from the agent
 * CLI spawn wrapper so non-agent subprocess callers (task commands, setup
 * probes/installers) get the same guarantees the agent path already had:
 *
 *   • Process-GROUP spawn (`detached: true` when capturing ON POSIX) so a
 *     negative-pid kill reaps the whole descendant tree — no orphaned children.
 *     See {@link spawnsOwnProcessGroup} for why Windows is excluded.
 *   • A SIGTERM→SIGKILL kill ladder on timeout/abort — a child that ignores
 *     SIGTERM is force-killed after a grace period instead of wedging forever.
 *   • Time-bounded output capture ({@link readStream}) that cannot block past
 *     the wall budget even when the child leaves a pipe endpoint open, plus an
 *     OPT-IN RETENTION cap (`maxOutputBytes`); see {@link readStream} for what
 *     the cap does and does not bound.
 *   • Injectable `spawnFn`/`setTimeoutFn`/`clearTimeoutFn` seams so callers
 *     can drive the machinery deterministically in tests.
 *
 * Runtime boundary: the default spawn comes from `../runtime`; this module
 * never touches `Bun.*` directly. It also never imports from `integrations/`
 * or `tasks/` — it is a leaf primitive those layers consume.
 */

import { spawn as runtimeSpawn } from "../runtime";

/** Minimum subprocess surface we need. The runtime spawn returns this shape. */
export interface SpawnedSubprocess {
  exitCode: number | null;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  stdin?: WritableStream<Uint8Array> | null;
  /** PID of the spawned process. Present on real Bun subprocesses; may be absent on test fakes. */
  pid?: number;
  kill(signal?: number | string): void;
}

/**
 * Function signature compatible with the runtime spawn. Tests inject a fake
 * implementation so the spawn machinery can be exercised deterministically
 * without poking at real binaries.
 */
export type SpawnFn = (
  cmd: string[],
  options: {
    stdin?: "inherit" | "pipe" | "ignore";
    stdout?: "inherit" | "pipe" | "ignore";
    stderr?: "inherit" | "pipe" | "ignore";
    env?: Record<string, string>;
    cwd?: string;
    detached?: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => SpawnedSubprocess;

/**
 * Kill the process group of `proc` with `signal`, falling back to
 * `proc.kill(signal)` when `proc.pid` is unavailable (e.g. test fakes).
 *
 * Passing a negative PID to `process.kill` targets the entire process
 * group, so opencode's child processes (the .opencode binary, etc.) are
 * reaped alongside the node wrapper. The fallback keeps test fakes working
 * without modification.
 */
/**
 * Whether a captured spawn should ask for its own process group.
 *
 * POSIX: yes. `detached` is `setsid()`, which is what makes {@link killGroup}'s
 * `process.kill(-pid, …)` reap the whole descendant tree. It does not touch the
 * child's stdio.
 *
 * Windows: no — the same flag means something unrelated and actively harmful.
 * There it maps to `DETACHED_PROCESS`, so the child is created WITHOUT A
 * CONSOLE; a console host started that way (powershell.exe, cmd.exe) allocates
 * its own console during startup, which REPLACES the std handles it was handed,
 * and everything it writes goes to that phantom console instead of our pipe.
 * The command still runs and its exit code still propagates — the output just
 * vanishes, which is exactly how it failed: a scheduled `akm --version` logged
 * `exit_code=0` with both captured streams empty. Windows gains nothing in
 * return, because `process.kill(-pid, …)` is a POSIX process-group call that
 * throws there; {@link killGroup} already falls back to `proc.kill(signal)`.
 *
 * Exported for direct unit testing with an explicit platform.
 */
export function spawnsOwnProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * The exact options one managed run hands its spawn — pure, so the platform
 * dependency above is testable on any host rather than only on the platform
 * that would break.
 */
export function buildSpawnOptions(
  opts: Pick<RunManagedSubprocessOptions, "capture" | "stdin" | "env" | "cwd" | "windowsVerbatimArguments">,
  platform: NodeJS.Platform = process.platform,
): Parameters<SpawnFn>[1] {
  const capture = opts.capture;
  return {
    stdin: capture ? (opts.stdin !== undefined ? "pipe" : "ignore") : "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    // Only in captured mode — interactive mode inherits the parent terminal's
    // process group intentionally — and only where the flag means a process
    // group at all (see spawnsOwnProcessGroup).
    ...(capture && spawnsOwnProcessGroup(platform) ? { detached: true } : {}),
    ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}

export function killGroup(proc: SpawnedSubprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Process may have already exited; fall through to direct kill.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    /* ignore */
  }
}

/**
 * SIGTERM→SIGKILL kill ladder shared by the timeout and abort paths (§4.6
 * dedup, H3). No-op when the child has already exited; otherwise runs
 * `onKill` (the caller's reason flag — `timedOut` / `aborted` — set BEFORE
 * the first signal, exactly as the inlined copies did), SIGTERMs the
 * process group, and schedules a follow-up SIGKILL after `graceMs` in case
 * the process ignores SIGTERM. The SIGKILL timer is unref'ed so it never
 * pins the event loop.
 */
export function scheduleKillLadder(
  proc: SpawnedSubprocess,
  opts: { onKill: () => void; setTimeoutFn: typeof setTimeout; graceMs?: number },
): void {
  if (!proc || proc.exitCode !== null) return;
  opts.onKill();
  killGroup(proc, "SIGTERM");
  const sigkillTimer = opts.setTimeoutFn(() => {
    if (!proc || proc.exitCode !== null) return;
    killGroup(proc, "SIGKILL");
  }, opts.graceMs ?? 5000);
  if (typeof sigkillTimer !== "number") sigkillTimer.unref?.();
}

/** Result of draining one captured pipe. */
export interface StreamReadResult {
  text: string;
  timedOut: boolean;
  error?: unknown;
  /**
   * The caller's `maxBytes` RETENTION cap was reached. The drain continues past
   * that point (see {@link readStream}), so the stream was still read to its end
   * — but `text` holds only the retained PREFIX and must never be promoted as if
   * it were the whole output. Always `false` when no cap was requested.
   */
  overflowed: boolean;
  /**
   * TOTAL raw bytes read off the pipe, including the ones discarded past the
   * cap. Together with {@link StreamReadResult.retainedBytes} this is what lets
   * a caller say honestly how much of the output it is holding.
   */
  bytesRead: number;
  /** Raw bytes actually RETAINED in `text`. */
  retainedBytes: number;
}

/**
 * The joined, human-readable reason ONE managed run's capture is incomplete, or
 * `undefined` when both pipes drained cleanly.
 *
 * Shared so every caller that promotes captured output treats an incomplete
 * capture the same way. A pipe that errored, or that hit the stream-drain
 * timeout because a background descendant kept the fd open after the leader
 * exited 0, yields a PARTIAL string — and a caller that reads only `exitCode`
 * would promote that partial as if it were the command's whole output.
 * `maxBytes` overflow is deliberately NOT reported here: it is a distinct,
 * caller-classified condition (see {@link StreamReadResult.overflowed}), not a
 * drain malfunction.
 */
export function streamCaptureFailure(stdout: StreamReadResult, stderr: StreamReadResult): string | undefined {
  const failures: string[] = [];
  if (stdout.error) failures.push(`stdout read failed: ${errorText(stdout.error)}`);
  if (stderr.error) failures.push(`stderr read failed: ${errorText(stderr.error)}`);
  if (stdout.timedOut) failures.push("stdout drain timed out");
  if (stderr.timedOut) failures.push("stderr drain timed out");
  return failures.length === 0 ? undefined : failures.join("; ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STREAM_READ_TIMEOUT = Symbol("stream-read-timeout");

/**
 * Index at or before `limit` where a UTF-8 CHARACTER starts, so a retention cut
 * never lands inside a multi-byte sequence. Continuation bytes are `10xxxxxx`;
 * a well-formed sequence has at most three of them, so this walks back at most
 * three positions.
 */
function utf8BoundaryAtOrBefore(value: Uint8Array, limit: number): number {
  let cut = limit;
  while (cut > 0 && (value[cut]! & 0xc0) === 0x80) cut--;
  return cut;
}

/**
 * Drain a readable stream to text, optionally racing each read against a
 * timeout so a process that is killed via SIGTERM/SIGKILL but whose pipe
 * endpoints stay open (e.g. background threads still holding the fd) cannot
 * block the caller indefinitely. On timeout we return whatever was decoded
 * before the pipe stopped draining.
 *
 * ## The `maxBytes` cap bounds MEMORY, not the child
 *
 * The drain ALWAYS runs to the end of the stream. `maxBytes` caps only what is
 * RETAINED: once the cap is reached the loop keeps calling `reader.read()` and
 * throws the bytes away. That is what makes the cap safe to impose on a
 * process that is still running — a reader that stopped pulling would fill the
 * pipe buffer and BLOCK the child on its next write, turning "the output got
 * long" into "the command hangs until the wall timeout". Draining and
 * discarding costs nothing but the reads, and the child finishes normally.
 */
export async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  opts?: {
    timeoutMs?: number;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    /**
     * Hard BYTE cap on what this drain RETAINS. Omitted = unbounded. Past the
     * cap the result is flagged {@link StreamReadResult.overflowed} with both
     * counts — the caller decides what a partial capture means, because only it
     * knows whether the stream was an artifact or a diagnostic.
     *
     * The retained text is at most `maxBytes` bytes: a cut landing inside a
     * multi-byte character is trimmed back to the character boundary. (In the
     * one case where the split spans a chunk boundary the decoder's trailing
     * partial flushes to a single U+FFFD, so the string can exceed `maxBytes`
     * by at most two bytes — still a hard bound, which is the property that
     * matters.)
     */
    maxBytes?: number;
    /**
     * Keep `timeoutMs` UNARMED until this settles (either way). Omitted, the
     * deadline starts with the drain.
     *
     * Arming at the drain's start would cap the RUN: a healthy process still
     * writing when the deadline expires loses its reader mid-stream. Passing
     * the moment the pipe stops belonging to a live process — the child's exit,
     * or for a bounded run the earlier of that and the wall budget — bounds only
     * what a pipe does AFTER the process that owned it is gone, which is the
     * leak this timeout exists for.
     */
    armTimeoutAfter?: Promise<unknown>;
  },
): Promise<StreamReadResult> {
  if (!stream) return { text: "", timedOut: false, overflowed: false, bytesRead: 0, retainedBytes: 0 };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maxBytes = opts?.maxBytes;
  let text = "";
  let bytesRead = 0;
  let retainedBytes = 0;
  let overflowed = false;
  /**
   * Common per-chunk accumulate. Uncapped it appends everything. Capped, it
   * appends until the cap and then only COUNTS — the caller's loop keeps reading
   * either way, which is the whole point.
   */
  const absorb = (value: Uint8Array): void => {
    bytesRead += value.byteLength;
    if (maxBytes === undefined) {
      retainedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      return;
    }
    // Already past the cap: discard. Never resume retaining — a gap in the
    // middle would splice two disjoint regions into one string.
    if (overflowed) return;
    if (retainedBytes + value.byteLength <= maxBytes) {
      retainedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      return;
    }
    overflowed = true;
    const keep = utf8BoundaryAtOrBefore(value, maxBytes - retainedBytes);
    if (keep > 0) {
      retainedBytes += keep;
      text += decoder.decode(value.subarray(0, keep), { stream: true });
    }
  };
  if (!opts?.timeoutMs) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        absorb(chunk.value);
      }
      text += decoder.decode();
      return { text, timedOut: false, overflowed, bytesRead, retainedBytes };
    } catch (error) {
      return { text, timedOut: false, error, overflowed, bytesRead, retainedBytes };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
  const setTimeoutImpl = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutFn ?? clearTimeout;
  const timeoutMs = opts.timeoutMs;
  let timer: ReturnType<typeof setTimeoutImpl> | undefined;
  let drained = false;
  const timeoutPromise = new Promise<typeof STREAM_READ_TIMEOUT>((resolve) => {
    const arm = () => {
      // The drain already finished while the deadline was still waiting to be
      // armed; a timer started now would belong to nobody.
      if (drained) return;
      timer = setTimeoutImpl(() => {
        timer = undefined;
        resolve(STREAM_READ_TIMEOUT);
      }, timeoutMs);
      if (typeof timer !== "number") timer.unref?.();
    };
    if (opts.armTimeoutAfter) void opts.armTimeoutAfter.then(arm, arm);
    else arm();
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeoutPromise]);
      if (chunk === STREAM_READ_TIMEOUT) {
        void reader.cancel().catch(() => {});
        return { text, timedOut: true, overflowed, bytesRead, retainedBytes };
      }
      if (chunk.done) break;
      absorb(chunk.value);
    }
    text += decoder.decode();
    return { text, timedOut: false, overflowed, bytesRead, retainedBytes };
  } catch (error) {
    return { text, timedOut: false, error, overflowed, bytesRead, retainedBytes };
  } finally {
    drained = true;
    if (timer !== undefined) {
      clearTimeoutImpl(timer);
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Per-call options for {@link runManagedSubprocess}. */
export interface RunManagedSubprocessOptions {
  /**
   * Captured = pipe stdout/stderr and spawn in an own process group
   * (`detached: true`) so the kill ladder can reap the whole tree.
   * Non-captured = inherit the parent stdio and process group (interactive).
   */
  capture: boolean;
  /** Child env. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /** Optional stdin payload (only written in captured mode). */
  stdin?: string;
  /** Hard timeout (ms). null = no kill timer (runs until the process exits). */
  timeoutMs: number | null;
  /**
   * Hard BYTE RETENTION cap per captured pipe, forwarded to {@link readStream}.
   * Omitted = unbounded capture. The per-stream
   * {@link StreamReadResult.overflowed} flag says which pipe crossed it.
   */
  maxOutputBytes?: number;
  /** Cooperative cancellation. Aborting runs the same TERM→KILL ladder. */
  signal?: AbortSignal;
  /** SIGTERM→SIGKILL grace period (ms). Defaults to 5000. */
  graceMs?: number;
  /**
   * Windows only: forwarded to the spawn call. Set when `cmd` is itself a
   * shell invocation (e.g. `cmd /S /C "<hand-quoted command line>"`) whose
   * tail argument must reach the child exactly as built. No-op elsewhere.
   */
  windowsVerbatimArguments?: boolean;
  /** Spawn function. Defaults to the runtime spawn. Tests inject a fake. */
  spawnFn?: SpawnFn;
  /** `setTimeout` shim. Defaults to the global. Tests pass a synchronous driver. */
  setTimeoutFn?: typeof setTimeout;
  /** `clearTimeout` shim. Defaults to the global. */
  clearTimeoutFn?: typeof clearTimeout;
  /** Invoked once, immediately after a successful spawn, with the live proc. */
  onSpawn?: (proc: SpawnedSubprocess) => void;
}

/**
 * Outcome of a managed run. `spawnError` is set (and stdout/stderr empty) when
 * the spawn call threw synchronously or `proc.exited` rejected — the caller
 * distinguishes that from a normal exit. `stdoutRead`/`stderrRead` expose the
 * per-stream drain diagnostics so callers can surface capture failures.
 */
export interface ManagedSubprocessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: Error;
  stdoutRead: StreamReadResult;
  stderrRead: StreamReadResult;
}

const EMPTY_READ: StreamReadResult = {
  text: "",
  timedOut: false,
  overflowed: false,
  bytesRead: 0,
  retainedBytes: 0,
};
/**
 * Drain deadline for a run with no wall budget, counted from the child's EXIT
 * (never from capture — see {@link runManagedSubprocess}). It bounds only the
 * window in which a descendant can keep an inherited pipe open after the leader
 * is gone, so it can be generous without ever capping the run itself.
 */
const UNBOUNDED_STREAM_READ_SAFETY_MS = 60 * 60 * 1000;
/**
 * Drain deadline for a run WITH a wall budget, counted from the moment the
 * pipe's owner left — the child exited, or (a child that survived its own kill
 * ladder) the budget expired. Anything still holding the fd open then is a
 * background descendant, not the command, so this is the same 2 s the old
 * capture-anchored deadline allowed past the budget; only its starting point
 * moved earlier.
 */
const POST_EXIT_STREAM_DRAIN_GRACE_MS = 2_000;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Spawn `cmd` and manage its lifecycle: process-group spawn, hard timeout and
 * cooperative abort (both via the SIGTERM→SIGKILL {@link scheduleKillLadder}),
 * bounded output capture, and an optional stdin payload. Never throws for a
 * spawn/exit failure — those surface as {@link ManagedSubprocessResult.spawnError}.
 */
export async function runManagedSubprocess(
  cmd: string[],
  opts: RunManagedSubprocessOptions,
): Promise<ManagedSubprocessResult> {
  const setTimeoutImpl = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutFn ?? clearTimeout;
  const spawnFn = opts.spawnFn ?? (runtimeSpawn as unknown as SpawnFn);
  const capture = opts.capture;
  const timeoutMs = opts.timeoutMs;

  // Refuse to spawn at all when the caller's signal is already aborted.
  if (opts.signal?.aborted) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true,
      stdoutRead: EMPTY_READ,
      stderrRead: EMPTY_READ,
    };
  }

  let proc: SpawnedSubprocess;
  try {
    proc = spawnFn(cmd, buildSpawnOptions(opts));
  } catch (err) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      spawnError: toError(err),
      stdoutRead: EMPTY_READ,
      stderrRead: EMPTY_READ,
    };
  }
  opts.onSpawn?.(proc);

  // Hard timeout: SIGTERM now, SIGKILL after the grace period if ignored.
  // Skipped entirely when timeoutMs is null.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeoutImpl> | undefined;
  // Settles when a bounded run's wall budget expires — the second way (after
  // the child's own exit) a captured pipe can stop belonging to a live command.
  // See the drain-deadline note below.
  let onBudgetExpiry: (() => void) | undefined;
  const budgetExpired =
    capture && timeoutMs !== null
      ? new Promise<void>((resolve) => {
          onBudgetExpiry = resolve;
        })
      : undefined;
  if (timeoutMs !== null) {
    timer = setTimeoutImpl(() => {
      onBudgetExpiry?.();
      scheduleKillLadder(proc, {
        onKill: () => {
          timedOut = true;
        },
        setTimeoutFn: setTimeoutImpl,
        ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
      });
    }, timeoutMs);
  }

  // Cooperative cancel: same ladder, flagged separately so the caller can tell
  // a budget/user abort from a wall-clock expiry.
  let aborted = false;
  const abortSignal = opts.signal;
  const onAbort = () => {
    scheduleKillLadder(proc, {
      onKill: () => {
        aborted = true;
      },
      setTimeoutFn: setTimeoutImpl,
      ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    });
  };
  if (abortSignal) {
    // A signal that aborted between the pre-spawn check and here fires the
    // listener directly (the "abort" event would otherwise never re-dispatch).
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  // Stream-drain timeout: a short grace once nothing living owns the pipe any
  // more, or a one-hour safety bound when execution itself is unbounded.
  //
  // Neither is armed while the command is still running: every byte up to then
  // is a live process's, and cancelling the reader would discard the output of
  // work that is still going. What ends that ownership is where the two cases
  // differ. Unbounded, the caller asked for NO cap on the run, so only the
  // child's own exit can end it. Bounded, the wall budget ends it too — a child
  // that outlived its own kill ladder is not something akm can keep waiting on
  // — which leaves the SAME budget + grace ceiling as before for a command that
  // really did spend its whole budget, and cuts the common case that used to
  // stall: a leader exiting in milliseconds no longer holds the drain (and with
  // it the unit, and with it a fan-out slot) open for a budget it never came
  // close to spending.
  const streamDrainTimeoutMs = timeoutMs !== null ? POST_EXIT_STREAM_DRAIN_GRACE_MS : UNBOUNDED_STREAM_READ_SAFETY_MS;
  // Settles on a rejected `proc.exited` too: either way the child is gone.
  const childSettled = capture ? proc.exited.catch(() => undefined) : undefined;
  const pipeOwnerGone = childSettled && budgetExpired ? Promise.race([childSettled, budgetExpired]) : childSettled;
  const readOpts = {
    timeoutMs: streamDrainTimeoutMs,
    setTimeoutFn: setTimeoutImpl,
    clearTimeoutFn: clearTimeoutImpl,
    ...(pipeOwnerGone ? { armTimeoutAfter: pipeOwnerGone } : {}),
    ...(opts.maxOutputBytes !== undefined ? { maxBytes: opts.maxOutputBytes } : {}),
  };
  const stdoutPromise = capture ? readStream(proc.stdout ?? null, readOpts) : Promise.resolve(EMPTY_READ);
  const stderrPromise = capture ? readStream(proc.stderr ?? null, readOpts) : Promise.resolve(EMPTY_READ);

  // Optional stdin payload (captured mode only). Race the write/close against
  // proc.exited so a child that never drains stdin cannot pin us past the
  // timeout.
  if (opts.stdin !== undefined && capture && proc.stdin) {
    const stdinPayload = opts.stdin;
    const stdinStream = proc.stdin;
    const stdinDone = (async () => {
      try {
        const writer = stdinStream.getWriter();
        await writer.write(new TextEncoder().encode(stdinPayload));
        await writer.close();
      } catch {
        // Best-effort: ignore stdin write failures, the child will get EOF.
      }
    })();
    await Promise.race([stdinDone, proc.exited.catch(() => undefined)]);
  }

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    if (timer !== undefined) clearTimeoutImpl(timer);
    abortSignal?.removeEventListener("abort", onAbort);
    // Drain readers so they don't surface as unhandled rejections. The streams
    // carry their own drain timeout so this cannot block indefinitely.
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      spawnError: toError(err),
      stdoutRead: EMPTY_READ,
      stderrRead: EMPTY_READ,
    };
  }
  clearTimeoutImpl(timer);
  abortSignal?.removeEventListener("abort", onAbort);

  const [stdoutRead, stderrRead] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    exitCode,
    stdout: stdoutRead.text,
    stderr: stderrRead.text,
    timedOut,
    aborted,
    stdoutRead,
    stderrRead,
  };
}
