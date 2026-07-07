// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow watch <run>` — run-scoped event tail (redesign addendum R2).
 *
 * Prints the run's `workflow_*` / `workflow_unit_*` events from the state.db
 * `events` table (matched on `metadata.runId`) as NDJSON — one
 * {@link EventEnvelope} per line — and exits. With `stream: true` it keeps
 * polling from the last seen event id (monotonic rowid cursor, so concurrent
 * writers can never cause skips) and exits when the run reaches a terminal
 * status.
 *
 * Design constraints (pinned R2 decisions):
 *   - FOREGROUND poll loop only — no daemon, no background process, no
 *     `tailEvents` subscription held past the terminal status.
 *   - Reads go through the existing events repository (via
 *     {@link readEvents}); this module issues no SQL of its own.
 *   - "Terminal" means any non-`active` run status (`completed`, `failed`,
 *     `blocked`): in all three the engine has stopped driving, so no further
 *     events arrive until a human resumes the run. The status is read BEFORE
 *     each drain, so events written before the status flip are always
 *     emitted before the loop exits. The engine commits the status flip
 *     (workflow.db transaction) BEFORE it appends the terminal
 *     `workflow_step_completed` / `workflow_finished` events to state.db, so
 *     after first observing a terminal status the loop keeps performing
 *     grace polls (sleep + drain) until one drains nothing new — the
 *     terminal events landing in that commit→append window are never
 *     dropped.
 *   - Event lines are the raw envelopes (ids/status metadata only — event
 *     emitters never journal workflow-authored content, 07 P1-B rule).
 */

import { NotFoundError } from "../../core/errors";
import { type EventEnvelope, type ReadEventsOptions, type ReadEventsResult, readEvents } from "../../core/events";
import type { WorkflowRunStatus } from "../../sources/types";
import { withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";

/** Default `--stream` poll interval (ms). */
export const DEFAULT_WATCH_INTERVAL_MS = 1000;

export interface WatchWorkflowRunOptions {
  /** Workflow run id to watch (exact `workflow_runs.id`). */
  runId: string;
  /** Keep polling for new events until the run leaves `active`. Default: print the backlog and exit. */
  stream?: boolean;
  /** Poll interval for `stream` mode (ms). Default {@link DEFAULT_WATCH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Line sink. Default: `process.stdout.write(line + "\n")`. Test seam. */
  emit?: (line: string) => void;
  /** Events reader. Default: {@link readEvents} against the ambient state.db. Test seam. */
  readEventsFn?: (options: ReadEventsOptions) => ReadEventsResult;
  /** Run-status reader. Default: workflow-runs repository lookup. Test seam. */
  getRunStatus?: (runId: string) => Promise<WorkflowRunStatus>;
  /** Sleep shim for the poll loop. Default: `setTimeout`. Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WatchWorkflowRunResult {
  runId: string;
  /** Run status observed when the watch exited. */
  status: WorkflowRunStatus;
  /** Number of matching event lines emitted. */
  eventCount: number;
  /** Monotonic id cursor after the final drain (max event id seen, across ALL events). */
  lastEventId: number;
  /** Whether the watch ran in `--stream` mode. */
  streamed: boolean;
}

/**
 * True when `event` belongs to workflow run `runId`: the event type is in the
 * `workflow_*` family (which includes `workflow_unit_*`) AND the metadata
 * carries a matching `runId`. Events of other families that happen to carry
 * a `runId` (e.g. `llm_usage`) are excluded by design.
 */
export function isWorkflowRunEvent(event: EventEnvelope, runId: string): boolean {
  if (!event.eventType.startsWith("workflow_")) return false;
  return event.metadata?.runId === runId;
}

/** Default status reader — repository lookup; a missing run is a structured not-found. */
async function readRunStatus(runId: string): Promise<WorkflowRunStatus> {
  return withWorkflowRunsRepo((repo) => {
    const row = repo.getRunById(runId);
    if (!row) {
      throw new NotFoundError(
        `Workflow run "${runId}" not found.`,
        "WORKFLOW_NOT_FOUND",
        "Run `akm workflow list --active` to see runs.",
      );
    }
    return row.status;
  });
}

/**
 * Watch one workflow run's events. Emits each matching event envelope as a
 * single NDJSON line via `emit`, then returns a summary. See the module doc
 * for the backlog/stream/terminal-status contract.
 */
export async function watchWorkflowRun(options: WatchWorkflowRunOptions): Promise<WatchWorkflowRunResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const emit = options.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
  const read = options.readEventsFn ?? ((readOptions: ReadEventsOptions) => readEvents(readOptions));
  const getRunStatus = options.getRunStatus ?? readRunStatus;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Existence check first so an unknown run id is a structured error, not an
  // empty NDJSON stream.
  let status = await getRunStatus(options.runId);

  let eventCount = 0;
  let cursor = 0;

  const drain = (): void => {
    const { events, nextOffset } = read({ sinceOffset: cursor });
    cursor = nextOffset;
    for (const event of events) {
      if (!isWorkflowRunEvent(event, options.runId)) continue;
      emit(JSON.stringify(event));
      eventCount++;
    }
  };

  // Backlog: everything already journaled for this run.
  drain();

  if (options.stream === true) {
    // Foreground poll loop (NO daemon). Status is re-read BEFORE each drain
    // so events written before a terminal flip are emitted before exit.
    while (status === "active") {
      await sleep(intervalMs);
      status = await getRunStatus(options.runId);
      drain();
    }
    // Terminal grace polls: completeWorkflowStep commits the run-status flip
    // (workflow.db) BEFORE appending workflow_step_completed /
    // workflow_finished to state.db, so the drain that first observed the
    // terminal status can predate those events. Keep sleeping + draining
    // until an idle poll (a drain that emits nothing new for this run) —
    // the engine has stopped driving, so this converges after the terminal
    // events land (already-terminal runs pay exactly one idle poll).
    let emittedBefore: number;
    do {
      emittedBefore = eventCount;
      await sleep(intervalMs);
      drain();
    } while (eventCount > emittedBefore);
  }

  return {
    runId: options.runId,
    status,
    eventCount,
    lastEventId: cursor,
    streamed: options.stream === true,
  };
}
