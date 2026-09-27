// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `improve_ledger` table (migration 028): the ONE
 * durable record of "what did improve last do with this (ref, source), and
 * when may it try again".
 *
 * One row per `(stash_dir, ref, source)`. Every stage writes it when it
 * proposes, judges, rejects, accepts, expires or skips a ref; every stage's
 * candidate selection reads it before any LLM call. It replaces the
 * projections the stages used to re-derive the same invariant from — rejected
 * proposal rows, the `proposal_fingerprints` table, `proposal_rejected` /
 * `reflect_invoked` / `distill_invoked` / `consolidate_completed` events, the
 * `$STATE/improve/distill-rejected` files and the per-stage cooldown
 * constants — none of which agreed with each other.
 *
 * `next_eligible_at` is computed in exactly one place, {@link nextEligibleAt},
 * from `(source, outcome)`.
 *
 * @module improve-ledger-repository
 */

import type { Database } from "../database";

export const IMPROVE_LEDGER_OUTCOMES = [
  "proposed",
  "accepted",
  "rejected",
  "quality_rejected",
  "review_needed",
  "expired",
  "unchanged",
  "failed",
  "judged_no_action",
] as const;

export type ImproveLedgerOutcome = (typeof IMPROVE_LEDGER_OUTCOMES)[number];

export interface ImproveLedgerRow {
  stashDir: string;
  /** The asset the stage attempted (input ref for distill/consolidate; the proposal ref otherwise). */
  ref: string;
  source: string;
  /** When the stage last attempted this ref (ISO). Decisions keep it; attempts move it. */
  lastAttemptAt: string;
  outcome: ImproveLedgerOutcome;
  /** ISO instant before which candidate selection skips the ref; `null` = eligible now. */
  nextEligibleAt: string | null;
  proposalId: string | null;
  /** Short free-text reason (judge verdict, review reason, skip reason). */
  detail: string | null;
}

const MS_PER_DAY = 86_400_000;
const DETAIL_MAX_CHARS = 500;

/**
 * Post-rejection windows by source: reflect 14 d, distill 30 d, every other
 * source 7 d — the constants the rejection backoff always used.
 */
export const LEDGER_REJECTION_WINDOW_DAYS: Readonly<Record<string, number>> = Object.freeze({
  reflect: 14,
  distill: 30,
});
export const LEDGER_DEFAULT_REJECTION_WINDOW_DAYS = 7;
/** A proposal nobody reviewed inside the retention window: short grace, not a rejection backoff. */
export const LEDGER_EXPIRED_GRACE_DAYS = 1;
/** Revisit cadence for a ref the stage looked at and had nothing to do (or is still pending). */
export const LEDGER_REVISIT_CADENCE_DAYS = 7;

/**
 * Outcomes whose window a fresh signal on the asset (new feedback, a content
 * change) cannot lift. Every other window is a revisit cadence that a signal
 * newer than `last_attempt_at` lifts.
 */
export const LEDGER_HARD_OUTCOMES: ReadonlySet<ImproveLedgerOutcome> = new Set<ImproveLedgerOutcome>([
  "rejected",
  "quality_rejected",
  "expired",
]);

function windowDays(source: string, outcome: ImproveLedgerOutcome): number | null {
  switch (outcome) {
    case "rejected":
    case "quality_rejected":
      return LEDGER_REJECTION_WINDOW_DAYS[source] ?? LEDGER_DEFAULT_REJECTION_WINDOW_DAYS;
    case "expired":
      return LEDGER_EXPIRED_GRACE_DAYS;
    case "unchanged":
    case "judged_no_action":
    case "proposed":
    case "review_needed":
      return LEDGER_REVISIT_CADENCE_DAYS;
    case "accepted":
    case "failed":
      return null;
  }
}

/**
 * The single cadence function: when a `(source, outcome)` recorded at
 * `fromIso` becomes eligible again, or `null` for "immediately".
 */
export function nextEligibleAt(source: string, outcome: ImproveLedgerOutcome, fromIso: string): string | null {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  const days = windowDays(source, outcome);
  return days === null ? null : new Date(from + days * MS_PER_DAY).toISOString();
}

/**
 * Whether the ledger blocks another attempt on this row at `nowIso`.
 * `signalSinceIso` is the newest signal on the asset (feedback, content
 * change); a signal newer than the last attempt lifts a soft window but never
 * a hard one ({@link LEDGER_HARD_OUTCOMES}).
 */
export function isLedgerBlocked(row: ImproveLedgerRow | undefined, nowIso: string, signalSinceIso?: string): boolean {
  if (!row?.nextEligibleAt) return false;
  if (row.nextEligibleAt <= nowIso) return false;
  if (LEDGER_HARD_OUTCOMES.has(row.outcome)) return true;
  return !(signalSinceIso !== undefined && signalSinceIso > row.lastAttemptAt);
}

interface LedgerSqlRow {
  stash_dir: string;
  ref: string;
  source: string;
  last_attempt_at: string;
  outcome: string;
  next_eligible_at: string | null;
  proposal_id: string | null;
  detail: string | null;
}

function toRow(row: LedgerSqlRow): ImproveLedgerRow {
  return {
    stashDir: row.stash_dir,
    ref: row.ref,
    source: row.source,
    lastAttemptAt: row.last_attempt_at,
    // Tolerate an outcome a newer release may add: it still carries a window.
    outcome: row.outcome as ImproveLedgerOutcome,
    nextEligibleAt: row.next_eligible_at,
    proposalId: row.proposal_id,
    detail: row.detail,
  };
}

function trimDetail(detail: string | undefined): string | null {
  if (detail === undefined) return null;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > DETAIL_MAX_CHARS ? `${trimmed.slice(0, DETAIL_MAX_CHARS - 1)}…` : trimmed;
}

export interface RecordImproveLedgerInput {
  stashDir: string;
  ref: string;
  source: string;
  outcome: ImproveLedgerOutcome;
  /** ISO instant of the attempt; the cadence is computed from it. */
  at: string;
  proposalId?: string;
  detail?: string;
}

/** Record an attempt on `(stashDir, ref, source)`: upsert the row and its cadence. */
export function recordImproveLedger(db: Database, input: RecordImproveLedgerInput): ImproveLedgerRow {
  const row: ImproveLedgerRow = {
    stashDir: input.stashDir,
    ref: input.ref,
    source: input.source,
    lastAttemptAt: input.at,
    outcome: input.outcome,
    nextEligibleAt: nextEligibleAt(input.source, input.outcome, input.at),
    proposalId: input.proposalId ?? null,
    detail: trimDetail(input.detail),
  };
  db.prepare(
    `INSERT INTO improve_ledger
       (stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stash_dir, ref, source) DO UPDATE SET
       last_attempt_at  = excluded.last_attempt_at,
       outcome          = excluded.outcome,
       next_eligible_at = excluded.next_eligible_at,
       proposal_id      = excluded.proposal_id,
       detail           = excluded.detail`,
  ).run(
    row.stashDir,
    row.ref,
    row.source,
    row.lastAttemptAt,
    row.outcome,
    row.nextEligibleAt,
    row.proposalId,
    row.detail,
  );
  return row;
}

export interface RecordImproveLedgerDecisionInput {
  proposalId: string;
  stashDir: string;
  /** The proposal's own ref: the fallback key when no row carries `proposalId`. */
  ref: string;
  source: string;
  outcome: ImproveLedgerOutcome;
  /** ISO instant of the decision; the cadence is computed from it. */
  at: string;
  detail?: string;
}

/**
 * Record a decision (accept / reject / expire / revert) on the proposal a row
 * was minted for. The row is found by `proposal_id` — the proposal's ref may
 * differ from the ledger key (a distill proposal for `lessons/x` is keyed by
 * its input `memories/x`) — and `last_attempt_at` is kept: the window starts
 * at the decision, the attempt happened when it happened. A proposal no row
 * knows (minted before the ledger existed) gets a row keyed by its own ref.
 */
export function recordImproveLedgerDecision(db: Database, input: RecordImproveLedgerDecisionInput): void {
  const changes = db
    .prepare(
      `UPDATE improve_ledger
       SET outcome = ?, next_eligible_at = ?, detail = ?
       WHERE stash_dir = ? AND proposal_id = ?`,
    )
    .run(
      input.outcome,
      nextEligibleAt(input.source, input.outcome, input.at),
      trimDetail(input.detail),
      input.stashDir,
      input.proposalId,
    ).changes;
  if (Number(changes) > 0) return;
  recordImproveLedger(db, {
    stashDir: input.stashDir,
    ref: input.ref,
    source: input.source,
    outcome: input.outcome,
    at: input.at,
    proposalId: input.proposalId,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

export function getImproveLedgerRow(
  db: Database,
  stashDir: string,
  ref: string,
  source: string,
): ImproveLedgerRow | undefined {
  const row = db
    .prepare(
      `SELECT stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail
       FROM improve_ledger WHERE stash_dir = ? AND ref = ? AND source = ?`,
    )
    .get(stashDir, ref, source) as LedgerSqlRow | undefined;
  return row ? toRow(row) : undefined;
}

/** Every row for one stash, optionally narrowed to `sources`. */
export function listImproveLedgerRows(db: Database, stashDir: string, sources?: readonly string[]): ImproveLedgerRow[] {
  const sourceFilter = sources && sources.length > 0 ? ` AND source IN (${sources.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(
      `SELECT stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail
       FROM improve_ledger WHERE stash_dir = ?${sourceFilter} ORDER BY ref ASC, source ASC`,
    )
    .all(stashDir, ...(sources && sources.length > 0 ? sources : [])) as LedgerSqlRow[];
  return rows.map(toRow);
}
