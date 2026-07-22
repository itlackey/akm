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
 *   • Process-GROUP spawn (`detached: true` when capturing) so a negative-pid
 *     kill reaps the whole descendant tree — no orphaned children.
 *   • A SIGTERM→SIGKILL kill ladder on timeout/abort — a child that ignores
 *     SIGTERM is force-killed after a grace period instead of wedging forever.
 *   • Bounded output capture ({@link readStream}) that cannot block past the
 *     wall budget even when the child leaves a pipe endpoint open.
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
}

const STREAM_READ_TIMEOUT = Symbol("stream-read-timeout");

/**
 * Drain a readable stream to text, optionally racing each read against a
 * timeout so a process that is killed via SIGTERM/SIGKILL but whose pipe
 * endpoints stay open (e.g. background threads still holding the fd) cannot
 * block the caller indefinitely. On timeout we return whatever was decoded
 * before the pipe stopped draining.
 */
export async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  opts?: {
    timeoutMs?: number;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
  },
): Promise<StreamReadResult> {
  if (!stream) return { text: "", timedOut: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (!opts?.timeoutMs) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return { text, timedOut: false };
    } catch (error) {
      return { text, timedOut: false, error };
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
  let timer: ReturnType<typeof setTimeoutImpl> | undefined;
  const timeoutPromise = new Promise<typeof STREAM_READ_TIMEOUT>((resolve) => {
    timer = setTimeoutImpl(() => {
      timer = undefined;
      resolve(STREAM_READ_TIMEOUT);
    }, opts.timeoutMs);
    if (typeof timer !== "number") timer.unref?.();
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeoutPromise]);
      if (chunk === STREAM_READ_TIMEOUT) {
        void reader.cancel().catch(() => {});
        return { text, timedOut: true };
      }
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, timedOut: false };
  } catch (error) {
    return { text, timedOut: false, error };
  } finally {
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
  /** Cooperative cancellation. Aborting runs the same TERM→KILL ladder. */
  signal?: AbortSignal;
  /** SIGTERM→SIGKILL grace period (ms). Defaults to 5000. */
  graceMs?: number;
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

const EMPTY_READ: StreamReadResult = { text: "", timedOut: false };

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
    proc = spawnFn(cmd, {
      stdin: capture ? (opts.stdin !== undefined ? "pipe" : "ignore") : "inherit",
      stdout: capture ? "pipe" : "inherit",
      stderr: capture ? "pipe" : "inherit",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      // Spawn in its own process group so killGroup(-pid, signal) reaches all
      // descendants. Only in captured mode — interactive mode inherits the
      // parent terminal's process group intentionally.
      ...(capture ? { detached: true } : {}),
    });
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
  if (timeoutMs !== null) {
    timer = setTimeoutImpl(() => {
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

  // Stream-drain timeout: the wall budget plus a 2 s grace, or 30 s when there
  // is no kill timer. Ensures the caller never hangs past the budget even if a
  // killed child leaves a pipe write-end open in a background thread.
  const streamDrainTimeoutMs = timeoutMs !== null ? timeoutMs + 2_000 : 30_000;
  const stdoutPromise = capture
    ? readStream(proc.stdout ?? null, {
        timeoutMs: streamDrainTimeoutMs,
        setTimeoutFn: setTimeoutImpl,
        clearTimeoutFn: clearTimeoutImpl,
      })
    : Promise.resolve(EMPTY_READ);
  const stderrPromise = capture
    ? readStream(proc.stderr ?? null, {
        timeoutMs: streamDrainTimeoutMs,
        setTimeoutFn: setTimeoutImpl,
        clearTimeoutFn: clearTimeoutImpl,
      })
    : Promise.resolve(EMPTY_READ);

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
  return { exitCode, stdout: stdoutRead.text, stderr: stderrRead.text, timedOut, aborted, stdoutRead, stderrRead };
}
