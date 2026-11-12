// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A wall-clock deadline that aborts a caller's {@link AbortController}.
 *
 * Both surfaces that bound a whole workflow run — `akm workflow run --timeout`
 * (`commands/workflow-cli.ts`) and a scheduled workflow task (`tasks/runner.ts`)
 * — need the same four things: a timer, an abort carrying a reason, a flag
 * saying the deadline is why the run stopped, and an `unref` so a pending timer
 * cannot hold the process open. Written out per call site, the two copies had
 * already drifted apart in exactly the places that are easy to miss.
 *
 * The deadline arms a controller the CALLER owns rather than creating one,
 * because each caller composes it with something different: the CLI merges
 * SIGINT/SIGTERM into the same controller (and maps them to their own exit
 * codes), while a task has only the deadline. For the same reason this is not
 * an option on `runWorkflowSteps`: the engine already accepts a `signal`, so a
 * timer there would be a SECOND way to stop a run rather than one way, and the
 * CLI would still need its controller for signals.
 *
 * @module core/abort-deadline
 */

export interface AbortDeadlineOptions {
  /** Milliseconds until the abort. `null`/`undefined` arms nothing at all. */
  timeoutMs: number | null | undefined;
  /** Abort reason, surfaced to whatever inspects the signal. */
  reason: string;
  /** Timer seams for tests; default to the globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface AbortDeadline {
  /** Cancel the timer. Safe to call when nothing was armed, and idempotent. */
  disarm(): void;
  /** True once the deadline fired — i.e. the deadline is why the run stopped. */
  timedOut(): boolean;
}

export function armAbortDeadline(controller: AbortController, options: AbortDeadlineOptions): AbortDeadline {
  const { timeoutMs, reason } = options;
  if (timeoutMs === null || timeoutMs === undefined) {
    return { disarm: () => {}, timedOut: () => false };
  }
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;
  let fired = false;
  let timer: ReturnType<typeof setTimeoutImpl> | undefined = setTimeoutImpl(() => {
    timer = undefined;
    fired = true;
    controller.abort(new Error(reason));
  }, timeoutMs);
  // A pending deadline must never be the reason the process stays alive.
  (timer as unknown as { unref?: () => void } | undefined)?.unref?.();
  return {
    disarm: () => {
      if (timer !== undefined) {
        clearTimeoutImpl(timer);
        timer = undefined;
      }
    },
    timedOut: () => fired,
  };
}
