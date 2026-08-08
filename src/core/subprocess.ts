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
 *   • Time-bounded output capture ({@link readStream}) that cannot block past
 *     the wall budget even when the child leaves a pipe endpoint open, plus an
 *     OPT-IN RETENTION cap (`maxOutputBytes`): a caller that asks for one gets
 *     a bounded string plus `outputLimitExceeded`, instead of an unbounded
 *     string growing in the akm process. The cap never kills the child — past
 *     the cap the reader keeps DRAINING and stops RETAINING, so the command
 *     runs to completion and its real exit code stands. Callers that ask for no
 *     cap are unbounded, exactly as they always were.
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
  /**
   * Set when the caller's `maxBytes` RETENTION cap was reached. The drain
   * continues past that point (see {@link readStream}), so the stream was still
   * read to its end — but `text` holds only the retained PREFIX and must never
   * be promoted as if it were the whole output. Absent (not `false`) when no cap
   * was requested, so an uncapped caller's result shape is byte-identical to
   * before.
   */
  overflowed?: true;
  /**
   * TOTAL raw bytes read off the pipe, including the ones discarded past the
   * cap. Present only when a `maxBytes` cap was requested. Together with
   * {@link retainedBytes} this is what lets a caller say honestly how much of
   * the output it is holding.
   */
  bytesRead?: number;
  /** Raw bytes actually RETAINED in `text`. Present only when a `maxBytes` cap was requested. */
  retainedBytes?: number;
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
 * caller-classified condition (see {@link ManagedSubprocessResult}), not a
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
     * Hard BYTE cap on what this drain RETAINS. Omitted = unbounded, which is
     * the pre-existing behavior every caller had; only a caller that asks for a
     * cap gets one. Past the cap the drain continues and the bytes are
     * discarded, and the result is flagged {@link StreamReadResult.overflowed}
     * with both counts — the caller decides what a partial capture means,
     * because only it knows whether the stream was an artifact or a diagnostic.
     *
     * The retained text is at most `maxBytes` bytes: a cut landing inside a
     * multi-byte character is trimmed back to the character boundary. (In the
     * one case where the split spans a chunk boundary the decoder's trailing
     * partial flushes to a single U+FFFD, so the string can exceed `maxBytes`
     * by at most two bytes — still a hard bound, which is the property that
     * matters.)
     */
    maxBytes?: number;
  },
): Promise<StreamReadResult> {
  if (!stream) return { text: "", timedOut: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maxBytes = opts?.maxBytes;
  const capped = maxBytes !== undefined;
  let text = "";
  let bytesRead = 0;
  let retainedBytes = 0;
  let overflowed = false;
  /**
   * Common per-chunk accumulate. Uncapped it appends everything, byte for byte
   * as before. Capped, it appends until the cap and then only COUNTS — the
   * caller's loop keeps reading either way, which is the whole point.
   */
  const absorb = (value: Uint8Array): void => {
    bytesRead += value.byteLength;
    if (maxBytes === undefined) {
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
  const capFields = (): { bytesRead?: number; retainedBytes?: number } => (capped ? { bytesRead, retainedBytes } : {});
  const overflowField = (): { overflowed?: true } => (overflowed ? { overflowed: true } : {});
  if (!opts?.timeoutMs) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        absorb(chunk.value);
      }
      text += decoder.decode();
      return { text, timedOut: false, ...overflowField(), ...capFields() };
    } catch (error) {
      return { text, timedOut: false, error, ...overflowField(), ...capFields() };
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
        return { text, timedOut: true, ...overflowField(), ...capFields() };
      }
      if (chunk.done) break;
      absorb(chunk.value);
    }
    text += decoder.decode();
    return { text, timedOut: false, ...overflowField(), ...capFields() };
  } catch (error) {
    return { text, timedOut: false, error, ...overflowField(), ...capFields() };
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
  /**
   * Hard BYTE RETENTION cap per captured pipe. Omitted = unbounded capture,
   * which is what every caller got before this option existed — an uncapped
   * caller's behavior is unchanged.
   *
   * When a pipe crosses the cap the reader switches to drain-and-discard (see
   * {@link readStream}) and {@link ManagedSubprocessResult.outputLimitExceeded}
   * is set. The child is NOT killed: it keeps running, the pipe keeps draining
   * so it never blocks on backpressure, and its real exit code stands. The cap
   * bounds the memory this process spends on the child's behalf and nothing
   * else — deciding what a partial capture means is the caller's job, because
   * only the caller knows whether the stream was an artifact or a diagnostic.
   */
  maxOutputBytes?: number;
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
  /**
   * A captured pipe crossed {@link RunManagedSubprocessOptions.maxOutputBytes},
   * so everything past the cap was DISCARDED. Always `false` when no cap was
   * requested. The child still ran to completion and `exitCode` is its real
   * one; what is lost is completeness of `stdout`/`stderr`, which are then a
   * retained PREFIX and must not be promoted as the command's whole output. The
   * per-stream `overflowed` flags say which pipe crossed the cap, and their
   * `bytesRead`/`retainedBytes` say by how much.
   */
  outputLimitExceeded: boolean;
}

const EMPTY_READ: StreamReadResult = { text: "", timedOut: false };
const UNBOUNDED_STREAM_READ_SAFETY_MS = 60 * 60 * 1000;

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
      outputLimitExceeded: false,
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
      outputLimitExceeded: false,
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

  // Stream-drain timeout: the wall budget plus a 2 s grace, or a one-hour
  // safety bound when execution itself is unbounded. This timer starts with
  // capture, so the null-timeout path must not impose a short hidden deadline
  // on an otherwise healthy long-running process.
  const streamDrainTimeoutMs = timeoutMs !== null ? timeoutMs + 2_000 : UNBOUNDED_STREAM_READ_SAFETY_MS;
  // Retention cap on capture. Crossing it costs COMPLETENESS, not the run: the
  // reader keeps draining (so the child never blocks on backpressure) and the
  // command runs to completion. The flag is a report, not a verdict — the
  // caller decides whether a truncated capture is fatal for what it wanted.
  let outputLimitExceeded = false;
  const onDrained = (read: StreamReadResult): StreamReadResult => {
    if (read.overflowed) outputLimitExceeded = true;
    return read;
  };
  const readOpts = {
    timeoutMs: streamDrainTimeoutMs,
    setTimeoutFn: setTimeoutImpl,
    clearTimeoutFn: clearTimeoutImpl,
    ...(opts.maxOutputBytes !== undefined ? { maxBytes: opts.maxOutputBytes } : {}),
  };
  const stdoutPromise = capture
    ? readStream(proc.stdout ?? null, readOpts).then(onDrained)
    : Promise.resolve(EMPTY_READ);
  const stderrPromise = capture
    ? readStream(proc.stderr ?? null, readOpts).then(onDrained)
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
      outputLimitExceeded: false,
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
    outputLimitExceeded,
  };
}
