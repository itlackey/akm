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
 *   as a durable cursor for `--since` resumption. The public API surfaces this
 *   as the opaque `nextOffset` number.
 * - `ts` is ISO-8601 (UTC, millisecond precision).
 */

import fs from "node:fs";
import { type Database, openDatabase } from "../storage/database";
import { insertEvent, readStateEvents } from "../storage/repositories/events-repository";
import { rethrowIfTestIsolationError } from "./errors";
import type { EventEnvelope } from "./events-types";
import { getStateDbPath, openStateDatabase, withStateDb } from "./state-db";
import { borrowScopedStateDb } from "./state-db-scope";
import { isReadOnlyFilesystemError } from "./system-error";
import { error } from "./warn";

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
  /** Emitted by `akm sync` (git-backed stash commit/push). */
  | "sync"
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
  /** Per-attempt LLM usage telemetry (#576) — carries terminal outcome, model provenance, duration, and optional usage. */
  | "llm_usage"
  /** Owning LLM telemetry sink marker — carries `{expectedTerminalRecords}`. */
  | "llm_usage_summary"
  /**
   * WS-1 forgetting-safety rank-change report (plan §WS-1 step 7). Emitted once
   * per improve run on the second and subsequent runs, when the stash-wide rank
   * comparison can be made. Metadata carries `{stashSize, totalChanged,
   * forgettingCandidates, topDrops}`. See `buildRankChangeReport` in salience.ts.
   */
  | "improve_salience_rank_change"
  /**
   * #626 — emitted once per extract run when the pre-LLM triage gate is enabled
   * and evaluated at least one session. Counts-only metadata: `{evaluated,
   * passed, triagedOut, sourceRun}` (aggregated, never per-session).
   */
  | "extract_triaged"
  /**
   * R0 — emitted by `vacuumStateDbIfReclaimable`
   * (src/storage/state-db-integrity.ts) after a `VACUUM` triggered by a
   * post-purge freelist-ratio check. Metadata carries
   * `{pagesBefore, pagesAfter, freelistRatioBefore}`.
   */
  | "state_db_vacuumed"
  /**
   * #733 — emitted by `runOrphanStateGcPass` (the orphan-state GC maintenance
   * pass) when a run has something to report: any `asset_salience` /
   * `asset_outcome` row currently pending (unresolved against
   * `entries.item_ref`) or collected (deleted, only when
   * `improve.stateGc.collect` is true) this run. A quiet run with nothing
   * pending and nothing collected emits no event. Metadata carries
   * `{pending, collected, byTable}`, where `byTable` breaks both counts down
   * per table (`asset_salience` / `asset_outcome`). Sentinel ref:
   * `asset_state/_gc` (same convention as `proposals/_orphan-purge`).
   */
  | "asset_state_gc"
  | string;

export interface AppendEventInput {
  eventType: EventType;
  /** Asset ref in the 0.9.0 `[bundle//]conceptId` grammar (e.g. `memories/alpha`), or a colon-free synthetic sentinel label (e.g. `health/_probe`). Optional for stash-wide events. */
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
  /**
   * Read-only planning boundary. Event writes are suppressed and reads never
   * create or migrate state.db. When `db` is absent, a missing file is an empty
   * snapshot.
   */
  readOnly?: boolean;
  /** The planner could not obtain a side-effect-free state snapshot (for example, held WAL state). */
  readOnlySnapshotUnavailable?: boolean;
}

/**
 * Resolve the state.db path from context:
 *   1. `ctx.dbPath` — explicit override (test seam)
 *   2. default      — the canonical state.db path
 */
function resolveDbPath(ctx?: EventsContext): string {
  if (ctx?.dbPath) return ctx.dbPath;
  return getStateDbPath();
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
 *
 * The same fast path is taken IMPLICITLY inside a `withStateDbScope` /
 * `withWorkflowRunsConnection` scope (`core/state-db-scope.ts`): the ambient
 * scoped handle for this event's resolved `dbPath` is borrowed, so a workflow
 * step's `workflow_unit_started` / `workflow_unit_finished` pair rides the same
 * connection its journal rows do instead of opening state.db twice per unit.
 * The scope owns that handle's lifetime; `appendEvent` never closes a borrowed
 * connection.
 */
export function appendEvent(input: AppendEventInput, ctx?: EventsContext): void {
  if (ctx?.readOnly) return;
  const now = resolveNow(ctx);
  const ts = new Date(now()).toISOString();
  const row = { eventType: input.eventType, ts, ref: input.ref, metadata: input.metadata };

  // One try covers EVERY path — including resolving the state.db path, which
  // reads the environment and throws where no data dir can be derived — so the
  // best-effort contract ("a write failure never propagates") holds no matter
  // which handle this event lands on.
  try {
    // Fast path: an explicitly supplied long-lived connection. Resolution is
    // skipped outright, which is what "`dbPath` is ignored when `db` is
    // provided" has to mean for a caller that already holds an open handle.
    if (ctx?.db) {
      insertEvent(ctx.db, row);
      return;
    }
    const dbPath = resolveDbPath(ctx);
    // The ambient scoped handle for this path, when a scope is open — borrowed
    // exactly like the explicit one, and never closed here.
    const borrowed = borrowScopedStateDb(dbPath);
    if (borrowed) {
      insertEvent(borrowed, row);
      return;
    }
    // Default path: open, insert, close.
    withStateDb((db) => insertEvent(db, row), { path: dbPath });
  } catch (err) {
    // Never mask the bun-test isolation guard as a silent "events failed".
    rethrowIfTestIsolationError(err);
    // Read-only sandboxes can serve an existing index but cannot create the
    // maintenance lock or state DB used by best-effort usage tracking. That is
    // expected for a read verb; unrelated storage failures remain visible.
    if (isReadOnlyFilesystemError(err)) return;
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
   * non-negative integer.
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
  /**
   * Filter to events whose `metadata.runId` matches (the `workflow_*` event
   * family's run-scoping field). 0.9.0 CLI overhaul (S5): `akm workflow
   * watch <run-id>` is dropped; this is the replacement for its run-scoped
   * filter on the general `akm log` leaf.
   */
  runId?: string;
  /**
   * D-38 (`akm log list --limit`): cap the result to the MOST RECENT `limit`
   * events matching every other filter (since/type/ref AND the tag
   * post-filter below). Undefined means unlimited — the historical default,
   * left unchanged so existing scripts that read the whole stream keep
   * working.
   */
  limit?: number;
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
  if (ctx?.readOnlySnapshotUnavailable) return { events: [], nextOffset: 0 };
  const dbPath = resolveDbPath(ctx);

  let db: import("../storage/database").Database | undefined;
  let ownsDb = false;
  try {
    if (ctx?.db) {
      db = ctx.db;
    } else if (ctx?.readOnly) {
      if (!fs.existsSync(dbPath)) return { events: [], nextOffset: 0 };
      db = openDatabase(dbPath, { readonly: true, create: false });
      ownsDb = true;
    } else {
      db = openStateDatabase(dbPath);
      ownsDb = true;
    }
  } catch (err) {
    // Never mask the bun-test isolation guard as "no events".
    rethrowIfTestIsolationError(err);
    // DB does not exist yet or cannot be opened — return empty result.
    return { events: [], nextOffset: 0 };
  }

  try {
    // D-38: a JS-side post-filter (the tag filters
    // below) runs AFTER the SQL read, so a SQL-level LIMIT applied before it
    // could drop rows the post-filter would have kept out anyway, silently
    // returning fewer than `limit` (or the wrong — oldest-in-the-SQL-window —
    // events). Only push `limit` into SQL (readStateEvents) when nothing
    // downstream can shrink the result further; otherwise read unbounded (the
    // pre-existing behavior) and apply `limit` ourselves, below, AFTER the
    // post-filter runs.
    const needsPostFilter =
      (options.excludeTags?.length ?? 0) > 0 || (options.includeTags?.length ?? 0) > 0 || options.runId !== undefined;
    const pushLimitToSql = options.limit !== undefined && !needsPostFilter;
    let rawEvents: EventEnvelope[];
    let nextId: number;
    try {
      ({ events: rawEvents, nextId } = readStateEvents(db, {
        sinceId: options.sinceOffset,
        since: options.since,
        type: options.type,
        ref: options.ref,
        ...(pushLimitToSql ? { limit: options.limit } : {}),
      }));
    } catch (error) {
      if (ctx?.readOnly && error instanceof Error && /no such table:/i.test(error.message)) {
        return { events: [], nextOffset: options.sinceOffset ?? 0 };
      }
      throw error;
    }

    const filtered = rawEvents.filter((envelope) => {
      if (options.runId !== undefined && envelope.metadata?.runId !== options.runId) return false;
      // Apply tag filters after the indexed state.db read.
      const tags = (envelope.metadata?.tags as string[] | undefined) ?? [];
      if (options.excludeTags?.some((t) => tags.includes(t))) return false;
      if (options.includeTags && !options.includeTags.every((t) => tags.includes(t))) return false;
      return true;
    });
    // `filtered` is ascending by id; slicing off the end keeps the MOST
    // RECENT `limit` events post-filter, matching the SQL-pushdown path's
    // semantics exactly. `nextOffset` intentionally stays `nextId` — the
    // durable resume cursor tracks the underlying SQL read, not this
    // display-only truncation.
    const events = options.limit !== undefined && !pushLimitToSql ? filtered.slice(-options.limit) : filtered;

    return { events, nextOffset: nextId };
  } finally {
    if (ownsDb) db.close();
  }
}
