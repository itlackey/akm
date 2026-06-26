// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R8 — the improve-run lifecycle, lifted out of `improveCommand.run` so it can
 * be driven in-process by a test without spawning a child + sending a real OS
 * signal.
 *
 * The lifecycle owns: the SIGTERM/SIGINT/SIGHUP signal table, the signal
 * handlers (each persists a terminated-run row BEFORE exiting), the 2000ms
 * watchdog that force-exits if persistence hangs, `process.once` semantics, and
 * the success `exit(0)` path. The signal source and `process.exit` are injected
 * so a fake SIGTERM and a spy exit make the persist-before-exit ordering
 * (MEMORY: improve sync-only-on-clean-finish) assertable without a subprocess.
 *
 * Production wiring (improve-cli.ts) passes the real `process` signal source +
 * real `process.exit`, an `onTerminate` that calls `recordTerminatedImproveRun`,
 * and a `runWork` that awaits `akmImprove(...)`.
 */

import type { TerminationReason } from "./improve-result-file";

/** Signal -> {exit code, reason, ack message}. */
export const SIGNAL_TABLE = {
  SIGTERM: { code: 143, reason: "SIGTERM" as const, ack: true },
  SIGINT: { code: 130, reason: "SIGINT" as const, ack: true },
  SIGHUP: { code: 129, reason: "SIGHUP" as const, ack: false },
} satisfies Record<string, { code: number; reason: TerminationReason; ack: boolean }>;

/** The subset of `process` the lifecycle needs to register signal handlers. */
export interface SignalSource {
  once(signal: string, handler: () => void): unknown;
  removeListener(signal: string, handler: () => void): unknown;
}

export interface RunImproveSessionOptions<T> {
  /** The in-flight work to await (the real wiring passes `() => akmImprove(...)`). */
  runWork: () => Promise<T>;
}

export interface RunImproveSessionDeps {
  /** Source of process signals; pass `process` in production, a fake in tests. */
  signalSource: SignalSource;
  /** Process-exit injection; pass `process.exit` in production, a spy in tests. */
  exit: (code: number) => never;
  /**
   * Persist the terminated-run row for an abnormal exit. Called synchronously
   * inside the signal handler BEFORE `exit` so a SIGTERM'd run (cron timeout)
   * always leaves a row. Production passes a closure over
   * `recordTerminatedImproveRun`.
   */
  onTerminate: (reason: TerminationReason) => void;
  /** Optional ack writer (defaults to a no-op); production passes a stderr write. */
  ack?: (message: string) => void;
}

/**
 * Drive the improve-run lifecycle: register signal handlers, await `runWork`,
 * and on clean completion remove the handlers and resolve with the result. The
 * caller (improve-cli.ts) owns success-path result persistence + the final
 * `exit(0)`; this function returns the work result so that choreography stays
 * in the CLI exactly as before.
 *
 * Abnormal paths:
 *   - A registered signal fires -> persist terminated row (watchdog-guarded) ->
 *     optional ack -> `exit(code)`.
 *   - `runWork` rejects -> handlers are removed and the rejection propagates so
 *     the CLI's existing catch can persist `"exception"` and rethrow.
 */
export async function runImproveSession<T>(opts: RunImproveSessionOptions<T>, deps: RunImproveSessionDeps): Promise<T> {
  const { signalSource, exit, onTerminate, ack } = deps;

  const makeSignalHandler = (sig: keyof typeof SIGNAL_TABLE) => () => {
    const { code, reason, ack: shouldAck } = SIGNAL_TABLE[sig];
    // Hard-exit fallback: if the synchronous persist ever hangs (e.g. a stuck
    // sqlite lock under contention), the watchdog still exits with the correct
    // code instead of leaving a zombie process. .unref() keeps the timer from
    // holding the loop open on the normal (fast) path.
    const watchdog = setTimeout(() => exit(code), 2000);
    if (typeof watchdog.unref === "function") watchdog.unref();
    try {
      onTerminate(reason);
    } finally {
      clearTimeout(watchdog);
    }
    if (shouldAck) ack?.(`received ${sig}`);
    exit(code);
  };

  const sigtermHandler = makeSignalHandler("SIGTERM");
  const sigintHandler = makeSignalHandler("SIGINT");
  const sighupHandler = makeSignalHandler("SIGHUP");
  signalSource.once("SIGTERM", sigtermHandler);
  signalSource.once("SIGINT", sigintHandler);
  signalSource.once("SIGHUP", sighupHandler);

  try {
    return await opts.runWork();
  } finally {
    signalSource.removeListener("SIGTERM", sigtermHandler);
    signalSource.removeListener("SIGINT", sigintHandler);
    signalSource.removeListener("SIGHUP", sighupHandler);
  }
}
