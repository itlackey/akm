// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Append-only events stream — backed by state.db (#204, Phase 3).
 *
 * Every mutating CLI verb funnels through `appendEvent` so external
 * observers (sync, replication, audit, dashboards) can react to stash
 * changes. Events are stored in the `events` table in `state.db`
 * (SQLite, WAL mode) instead of a flat `events.jsonl` file.
 *
 * The helper is the only thing in akm that writes to the events table. It
 * accepts an injectable `dbPath` (via `EventsContext`) so tests can pin a
 * tmpdir without any global mutation.
 *
 * Format (each EventEnvelope):
 *   { "schemaVersion": 1, "id": <number>, "ts": "<ISO>",
 *     "eventType": "<verb>", "ref"?: "<asset-ref>", ... }
 *
 * - `id` is a monotonic SQLite AUTOINCREMENT rowid. Callers can persist it
 *   as a durable cursor for `--since` resumption (replaces the old byte-offset
 *   cursor). The public API still surfaces this as `nextOffset` (an opaque
 *   number) for backward compatibility with callers that stored byte-offset
 *   cursors.
 * - `ts` is ISO-8601 (UTC, millisecond precision).
 */

import path from "node:path";
import type { Database } from "../storage/database";
import { insertEvent, readStateEvents } from "../storage/repositories/events-repository";
import { rethrowIfTestIsolationError } from "./errors";
import type { EventEnvelope } from "./events-types";
import { getDataDir } from "./paths";
import { openStateDatabase, withStateDb } from "./state-db";
import { error } from "./warn";

// Re-exported so existing `import type { EventEnvelope } from "./core/events"`
// sites are unaffected by the KILL 1 sever (type moved to events-types.ts to
// break the events.ts ↔ events-repository.ts import cycle).
export type { EventEnvelope };

/**
 * Stable, machine-readable event types. New types may be added freely.
 *
 * NOTE: `index` and `setup` verbs are intentionally NOT emitted in #204 and
 * are tracked as a follow-up. They were considered for inclusion but `akmIndex`
 * has multiple exit paths and `setup` is a multi-step interactive flow; wiring
 * them required a larger refactor than this issue scoped. Reintroduce them as
 * literal members here when those emit sites land.
 */
export type EventType =
  | "add"
  | "remove"
  | "update"
  | "remember"
  | "import"
  /**
   * SPEC-7 — emitted once per successful `akm mv` rename. `ref` carries the
   * NEW ref; metadata carries `{from, to, rewroteFiles, readOnlyCiters,
   * twinMoved}` (counts only — never file contents). A failed mv emits
   * nothing.
   */
  | "mv"
  | "save"
  | "feedback"
  // Proposal substrate (#225). `promoted` and `rejected` are emitted by the
  // `akm proposal accept` / `akm proposal reject` flows. The `*_invoked`
  // events are emitted by the `akm reflect` (#226), `akm propose`, and
  // `akm distill` (#228) command flows.
  | "promoted"
  | "rejected"
  | "reflect_invoked"
  | "propose_invoked"
  | "distill_invoked"
  | "workflow_started"
  /** Emitted ONLY for a genuine `completed` step transition. Metadata: `{runId, stepId, status:"completed"}`. */
  | "workflow_step_completed"
  /**
   * #11 — every non-`completed` step transition (`failed`/`skipped`/`blocked`).
   * Metadata: `{runId, stepId, status}` — status is always present so consumers
   * never infer it from the event name. Raw `notes` are never journaled here
   * (event-stream prompt-injection surface); they stay on the step row.
   */
  | "workflow_step_updated"
  | "workflow_finished"
  /** Emitted by `akm workflow abandon` (08-F6) — metadata carries `{runId}` only, never the title. */
  | "workflow_abandoned"
  /**
   * Per-unit lifecycle of the native workflow executor (orchestration P1).
   * Metadata carries ids/status/tokens only — never instructions or results,
   * which are attacker-influenceable workflow content (07 P1-B rule).
   */
  | "workflow_unit_started"
  | "workflow_unit_finished"
  | "search"
  | "show"
  // Phase 4 Team C event gaps:
  /** Emitted when `akm show <ref>` follows a recent `akm search` that returned the same ref. */
  | "select"
  /** Emitted when a cooldown guard or budget exhaustion in `akm improve` skips an asset. */
  | "improve_skipped"
  /**
   * Layer 2 — emitted once per `akm improve` run when the proactive-maintenance
   * selector runs. Aggregated (never per-ref): metadata carries
   * `{count, dueTotal, neverReflected}`.
   */
  | "proactive_selected"
  /** Emitted after `createProposal()` succeeds in `akm reflect`. */
  | "reflect_completed"
  | "improve_completed"
  /** Emitted by `runImproveMaintenancePasses` after rejecting proposals whose target assets no longer exist on disk. */
  | "proposal_orphan_purge"
  /** Emitted by `runImproveMaintenancePasses` after running `purgeOldEvents()` on state.db. Metadata: `{purgedCount, retentionDays}`. */
  | "events_purged"
  /** Emitted by `createProposal()` when input validation fails before write — metadata carries `reason` and `source`. */
  | "proposal_creation_rejected"
  /** Emitted by the improve loop after each per-asset reflect call — carries `ok`, `durationMs`, `reason`. */
  | "improve_reflect_outcome"
  /** Per-call LLM usage telemetry (#576) — carries `{stage?, model?, durationMs, *Tokens?, finishReason?}`. */
  | "llm_usage"
  /**
   * WS-1 forgetting-safety rank-change report (plan §WS-1 step 7). Emitted once
   * per improve run on the second and subsequent runs, when the stash-wide rank
   * comparison can be made. Metadata carries `{stashSize, totalChanged,
   * forgettingCandidates, topDrops}`. See `buildRankChangeReport` in salience.ts.
   */
  | "improve_salience_rank_change"
  /**
   * WS-1 first-run marker. Emitted on the very first improve run when the
   * asset_salience table is empty — no pre-existing baseline exists to compare
   * against (the old combinedEligibilityScore ordering was not captured in state.db).
   * Metadata carries `{candidateCount, note}`.
   */
  | "improve_salience_first_run"
  /**
   * #610 — bounded replay budget selection. Emitted once per improve run when a
   * replay budget is configured. Metadata carries `{count, budget,
   * convergedSkipped, candidatePool}` (aggregated, never per-ref).
   */
  | "improve_replay_selected"
  /**
   * #626 — emitted once per extract run when the pre-LLM triage gate is enabled
   * and evaluated at least one session. Counts-only metadata: `{evaluated,
   * passed, triagedOut, sourceRun}` (aggregated, never per-session).
   */
  | "extract_triaged"
  /**
   * R5 — emitted (rarely) by the collapse/churn detector when a cycle trips an
   * alert rule. Metadata carries `{kind, detail, metrics, canarySetId, runId}`
   * where `kind` ∈ collapse-recall | collapse-entropy | collapse-shrink |
   * churn | merge-floor. Cycle history itself lives in `improve_cycle_metrics`
   * (365-day retention), not the events log.
   */
  | "collapse_detector_alert"
  /** R5 — emitted by the maintenance purge when improve_cycle_metrics rows past retention are deleted. Metadata: `{purgedCount, retentionDays}`. */
  | "improve_cycle_metrics_purged"
  | string;

export interface AppendEventInput {
  eventType: EventType;
  /** Asset ref like `memory:alpha`. Optional for stash-wide events. */
  ref?: string;
  /** Free-form structured payload. Must be JSON-serialisable. */
  metadata?: Record<string, unknown>;
}

export interface EventsContext {
  /** Returns ms since epoch. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Override the state.db path. Defaults to `<dataDir>/state.db`.
   *
   * This is the primary test seam for isolating events to a tmpdir.
   */
  dbPath?: string;
  /**
   * I1: optional long-lived pre-opened state.db connection.
   *
   * When provided, `appendEvent` uses this handle directly without opening
   * or closing the database — eliminating per-event open/migrate/close overhead
   * for callers that emit many events in a single run (e.g. `akmImprove`).
   *
   * The caller is responsible for closing this connection in a `finally` block
   * after all events have been appended.
   *
   * NOTE: `dbPath` is ignored when `db` is provided.
   */
  db?: Database;
}

/**
 * Legacy events.jsonl path — used only by the migration script
 * (`scripts/migrate-storage.ts`) to import existing event history into
 * state.db. No events are written here by akm v0.9+.
 */
export function getEventsPath(): string {
  return path.join(getDataDir(), "events.jsonl");
}

/**
 * Resolve the state.db path from context:
 *   1. `ctx.dbPath` — explicit override (test seam)
 *   2. default      — `<dataDir>/state.db`
 */
function resolveDbPath(ctx?: EventsContext): string {
  if (ctx?.dbPath) return ctx.dbPath;
  return path.join(getDataDir(), "state.db");
}

function resolveNow(ctx?: EventsContext): () => number {
  return ctx?.now ?? Date.now;
}

/**
 * Append a single event. Best-effort: a write failure is logged once to
 * stderr but never propagates — observability must not break mutation.
 *
 * Events are written exclusively to the `events` table in `state.db`.
 *
 * I1: when `ctx.db` is provided (a pre-opened long-lived connection), the
 * function writes directly to that handle without opening or closing the DB.
 * This eliminates per-event open/migrate/close overhead for high-frequency
 * callers such as `akmImprove`.
 */
export function appendEvent(input: AppendEventInput, ctx?: EventsContext): void {
  const now = resolveNow(ctx);
  const ts = new Date(now()).toISOString();

  // Fast path: caller provided a long-lived connection — use it directly.
  if (ctx?.db) {
    try {
      insertEvent(ctx.db, {
        eventType: input.eventType,
        ts,
        ref: input.ref,
        metadata: input.metadata,
      });
    } catch (err) {
      error(`akm: appendEvent failed: ${String(err)}`);
    }
    return;
  }

  // Default path: open, insert, close.
  const dbPath = resolveDbPath(ctx);
  try {
    withStateDb(
      (db) => {
        insertEvent(db, {
          eventType: input.eventType,
          ts,
          ref: input.ref,
          metadata: input.metadata,
        });
      },
      { path: dbPath },
    );
  } catch (err) {
    // Never mask the bun-test isolation guard as a silent "events failed".
    rethrowIfTestIsolationError(err);
    // Best-effort: events stream failures must not break the mutating verb.
    // Surface once to stderr so operators can diagnose.
    error(`akm: appendEvent failed: ${String(err)}`);
  }
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface ReadEventsOptions {
  /** ISO timestamp lower bound (`ts >= since`). */
  since?: string;
  /**
   * Monotonic id lower bound — durable cursor.
   *
   * The SQLite AUTOINCREMENT rowid of the last seen event. Treat as an opaque
   * non-negative integer. Callers migrating from the old JSONL implementation
   * should reset any persisted byte-offset cursor to 0.
   */
  sinceOffset?: number;
  /** Filter to a single event type. */
  type?: string;
  /** Filter to a single asset ref. */
  ref?: string;
  /** Exclude events whose metadata.tags contain any of these tags. */
  excludeTags?: string[];
  /** Only include events whose metadata.tags contain ALL of these tags. */
  includeTags?: string[];
}

export interface ReadEventsResult {
  events: EventEnvelope[];
  /**
   * The maximum rowid seen (use as the next `sinceOffset`).
   *
   * The SQLite AUTOINCREMENT id of the last row returned, or `sinceOffset`
   * when no rows matched. Monotonically increasing non-negative integer.
   */
  nextOffset: number;
}

/**
 * Read all events matching the filter. Returns a `nextOffset` that callers
 * can persist between processes for monotonic resumption.
 */
export function readEvents(options: ReadEventsOptions = {}, ctx?: EventsContext): ReadEventsResult {
  const dbPath = resolveDbPath(ctx);

  let db: import("../storage/database").Database | undefined;
  try {
    db = openStateDatabase(dbPath);
  } catch (err) {
    // Never mask the bun-test isolation guard as "no events".
    rethrowIfTestIsolationError(err);
    // DB does not exist yet or cannot be opened — return empty result.
    return { events: [], nextOffset: 0 };
  }

  try {
    const { events: rawEvents, nextId } = readStateEvents(db, {
      sinceId: options.sinceOffset,
      since: options.since,
      type: options.type,
      ref: options.ref,
    });

    // Apply tag filters in application code (same as the old JSONL implementation).
    const events = rawEvents.filter((envelope) => {
      const tags = (envelope.metadata?.tags as string[] | undefined) ?? [];
      if (options.excludeTags?.some((t) => tags.includes(t))) return false;
      if (options.includeTags && !options.includeTags.every((t) => tags.includes(t))) return false;
      return true;
    });

    return { events, nextOffset: nextId };
  } finally {
    db.close();
  }
}

// ─── Tailing ─────────────────────────────────────────────────────────────────

export interface TailOptions extends ReadEventsOptions {
  /** Polling interval in ms (default: 75). */
  intervalMs?: number;
  /** Stop after this many ms (test seam). */
  maxDurationMs?: number;
  /** Stop after observing this many events (test seam). */
  maxEvents?: number;
  /**
   * Abort signal — when triggered, the loop resolves with whatever events
   * have been observed so far.
   */
  signal?: AbortSignal;
  /** Called once per emitted event. */
  onEvent?: (event: EventEnvelope) => void;
}

export interface TailResult {
  events: EventEnvelope[];
  nextOffset: number;
  reason: "signal" | "maxEvents" | "maxDuration";
}

/**
 * Follow the events table in state.db. Polls at `intervalMs` (default 75ms)
 * and emits every new event to `onEvent`. Resolves when `signal` aborts, when
 * `maxEvents` events have been observed, or when `maxDurationMs` elapses.
 *
 * The polling cursor is a monotonic SQLite rowid so concurrent writers cannot
 * cause skips: between two reads we always pick up everything inserted since
 * the last `nextOffset`.
 */
export async function tailEvents(options: TailOptions = {}, ctx?: EventsContext): Promise<TailResult> {
  const intervalMs = options.intervalMs ?? 75;
  const collected: EventEnvelope[] = [];
  let cursor = options.sinceOffset ?? 0;

  // Seed the cursor: if the caller passed --since (timestamp) but no
  // sinceOffset, do an initial filtered read so they see history before
  // we start polling. This matches the documented behaviour of `tail
  // --since`: emit existing events that match, then follow.
  if (options.sinceOffset === undefined) {
    const initial = readEvents(
      {
        since: options.since,
        type: options.type,
        ref: options.ref,
        excludeTags: options.excludeTags,
        includeTags: options.includeTags,
      },
      ctx,
    );
    for (const event of initial.events) {
      collected.push(event);
      options.onEvent?.(event);
      if (options.maxEvents !== undefined && collected.length >= options.maxEvents) {
        return { events: collected, nextOffset: initial.nextOffset, reason: "maxEvents" };
      }
    }
    cursor = initial.nextOffset;
  }

  const startedAt = Date.now();
  return new Promise<TailResult>((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    function finish(reason: TailResult["reason"]): void {
      if (resolved) return;
      resolved = true;
      if (timer) clearInterval(timer);
      resolve({ events: collected, nextOffset: cursor, reason });
    }

    function tick(): void {
      try {
        const result = readEvents(
          {
            sinceOffset: cursor,
            type: options.type,
            ref: options.ref,
            excludeTags: options.excludeTags,
            includeTags: options.includeTags,
          },
          ctx,
        );
        cursor = result.nextOffset;
        for (const event of result.events) {
          // Apply --since filter inside the polling loop too — the cursor is
          // rowid-based so it can hand us events the user filtered out.
          if (options.since && event.ts && event.ts < options.since) continue;
          collected.push(event);
          options.onEvent?.(event);
          if (options.maxEvents !== undefined && collected.length >= options.maxEvents) {
            finish("maxEvents");
            return;
          }
        }
      } catch {
        // Non-fatal: stay in the loop.
      }
      if (options.maxDurationMs !== undefined && Date.now() - startedAt >= options.maxDurationMs) {
        finish("maxDuration");
      }
    }

    if (options.signal) {
      if (options.signal.aborted) {
        finish("signal");
        return;
      }
      options.signal.addEventListener("abort", () => finish("signal"), { once: true });
    }

    timer = setInterval(tick, intervalMs);
    // Run one tick immediately so callers don't have to wait an interval
    // for events written in the same tick as the tail starts.
    tick();
  });
}
