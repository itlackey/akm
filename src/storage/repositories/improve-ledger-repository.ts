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
 * from `(source, outcome)` — and, for the two content-driven cases (the
 * consolidate pair pass and a decided consolidate promotion), from whether a
 * body hash was recorded: those rows carry no clock, their `content_hash` is
 * the eligibility test.
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
  /**
   * Body content hash (`contentHash(_, "body")`) of the attempted ref at
   * `lastAttemptAt`, when the source's eligibility is content-driven rather
   * than time-driven: the consolidate pair pass (alpha.9 — see
   * {@link PAIR_PASS_LEDGER_SOURCE}) and a decided consolidate promotion (see
   * {@link isContentDrivenDecision}). `null` for every other row.
   */
  contentHash: string | null;
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
 * The consolidate pair pass's own ledger source (alpha.9): kept apart from
 * the promote pass's `consolidate` rows so the two candidate-selection
 * cadences never collide on the same `(stash, ref, source)` key. Its
 * eligibility is entirely content-driven (`content_hash` above, compared by
 * `selectInitiators` in `src/commands/improve/consolidate/pair-pass.ts`) —
 * {@link windowDays} below gives it no `next_eligible_at` timer at all, so a
 * row never "expires" on its own; only a content change makes the ref
 * eligible again.
 */
export const PAIR_PASS_LEDGER_SOURCE = "consolidate-pair";

/**
 * The consolidate promote pass's ledger source: one row per source memory,
 * keyed by the memory (`memories/<name>`), not by the knowledge ref the
 * promotion would create.
 */
export const CONSOLIDATE_LEDGER_SOURCE = "consolidate";

/**
 * Whether a decision on `(source, outcome)` leaves the ref's next attempt to
 * its content instead of a clock (#998). An accepted or rejected consolidate
 * promotion is a verdict on that memory's text; asking the model about the
 * same text again can only reproduce the proposal (accepted used to be
 * eligible at once, rejected after 7 days), so the memory waits for an edit.
 * So does a memory the model judged and left alone (`judged_no_action`):
 * the same text would be judged weekly with the same answer.
 * The clock stays for a row with no recorded hash — one decided before the
 * hash was recorded — see {@link nextEligibleAt} and {@link isContentDrivenRow}.
 */
export function isContentDrivenDecision(source: string, outcome: ImproveLedgerOutcome): boolean {
  return (
    source === CONSOLIDATE_LEDGER_SOURCE &&
    (outcome === "accepted" || outcome === "rejected" || outcome === "judged_no_action")
  );
}

/**
 * Whether this row is held by its content hash: a decided consolidate
 * promotion that recorded the body it was decided against. Such a row has no
 * `next_eligible_at`; the caller compares `contentHash` with the asset's
 * current body hash (the pair pass does the same in `selectInitiators`).
 */
export function isContentDrivenRow(row: Pick<ImproveLedgerRow, "source" | "outcome" | "contentHash">): boolean {
  return row.contentHash !== null && isContentDrivenDecision(row.source, row.outcome);
}

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
  // The pair pass's own eligibility never reads next_eligible_at (it compares
  // content_hash instead — selectInitiators in pair-pass.ts) — recording a
  // window here would be a number nothing enforces, so every row it writes
  // stays "eligible now" regardless of outcome.
  if (source === PAIR_PASS_LEDGER_SOURCE) return null;
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
 * `fromIso` becomes eligible again, or `null` for "immediately". A decision
 * that {@link isContentDrivenDecision} holds by content, recorded together
 * with the body hash it was decided against, starts no clock at all: `null`
 * here means the hash is the whole test, not that the ref is free to retry.
 */
export function nextEligibleAt(
  source: string,
  outcome: ImproveLedgerOutcome,
  fromIso: string,
  contentHash?: string | null,
): string | null {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  if (contentHash && isContentDrivenDecision(source, outcome)) return null;
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
  content_hash: string | null;
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
    contentHash: row.content_hash,
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
  /** Body content hash at this attempt (the pair pass's own eligibility signal). */
  contentHash?: string;
}

/** Record an attempt on `(stashDir, ref, source)`: upsert the row and its cadence. */
export function recordImproveLedger(db: Database, input: RecordImproveLedgerInput): ImproveLedgerRow {
  const row: ImproveLedgerRow = {
    stashDir: input.stashDir,
    ref: input.ref,
    source: input.source,
    lastAttemptAt: input.at,
    outcome: input.outcome,
    nextEligibleAt: nextEligibleAt(input.source, input.outcome, input.at, input.contentHash),
    proposalId: input.proposalId ?? null,
    detail: trimDetail(input.detail),
    contentHash: input.contentHash ?? null,
  };
  db.prepare(
    `INSERT INTO improve_ledger
       (stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stash_dir, ref, source) DO UPDATE SET
       last_attempt_at  = excluded.last_attempt_at,
       outcome          = excluded.outcome,
       next_eligible_at = excluded.next_eligible_at,
       proposal_id      = excluded.proposal_id,
       detail           = excluded.detail,
       content_hash     = excluded.content_hash`,
  ).run(
    row.stashDir,
    row.ref,
    row.source,
    row.lastAttemptAt,
    row.outcome,
    row.nextEligibleAt,
    row.proposalId,
    row.detail,
    row.contentHash,
  );
  return row;
}

export interface RecordImproveLedgerDecisionInput {
  proposalId: string;
  stashDir: string;
  /**
   * The fallback key when no row carries `proposalId`: the proposal's own ref,
   * or — for a promotion, whose ledger row is keyed by its source memory — that
   * memory's ref.
   */
  ref: string;
  source: string;
  outcome: ImproveLedgerOutcome;
  /** ISO instant of the decision; the cadence is computed from it. */
  at: string;
  detail?: string;
  /**
   * Body hash (`contentHash(_, "body")`) of the asset the decision was made
   * about — a promotion's source memory at the time it was queued. Recorded
   * on the row when {@link isContentDrivenDecision} holds it by content, and
   * ignored otherwise.
   */
  contentHash?: string;
}

/**
 * Record a decision (accept / reject / expire / revert) on the proposal a row
 * was minted for. The row is found by `proposal_id` — the proposal's ref may
 * differ from the ledger key (a distill proposal for `lessons/x` is keyed by
 * its input `memories/x`) — and `last_attempt_at` is kept: the window starts
 * at the decision, the attempt happened when it happened. A proposal no row
 * knows (minted before the ledger existed, or whose row a later `judged_no_action`
 * overwrote) gets a row keyed by `input.ref`.
 */
export function recordImproveLedgerDecision(db: Database, input: RecordImproveLedgerDecisionInput): void {
  const hash = isContentDrivenDecision(input.source, input.outcome) ? input.contentHash : undefined;
  const changes = db
    .prepare(
      `UPDATE improve_ledger
       SET outcome = ?, next_eligible_at = ?, detail = ?, content_hash = COALESCE(?, content_hash)
       WHERE stash_dir = ? AND proposal_id = ?`,
    )
    .run(
      input.outcome,
      nextEligibleAt(input.source, input.outcome, input.at, hash),
      trimDetail(input.detail),
      hash ?? null,
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
    ...(hash !== undefined ? { contentHash: hash } : {}),
  });
}

/**
 * A rejected proposal was reopened (`akm proposal reopen`): put the rows
 * {@link recordImproveLedgerDecision} found by `proposal_id` back to what the
 * mint wrote — `proposed`, on the revisit cadence from the reopen, and no
 * `content_hash` (a mint records none) — so the rejection's hard window stops
 * reporting (and blocking) a proposal that is pending again.
 * `last_attempt_at` is kept, as a decision keeps it. A proposal with no such
 * row (its mint wrote none, or a later attempt took the key over) changes
 * nothing.
 */
export function reopenImproveLedgerDecision(
  db: Database,
  input: { proposalId: string; stashDir: string; source: string; at: string; detail?: string },
): void {
  db.prepare(
    `UPDATE improve_ledger
     SET outcome = 'proposed', next_eligible_at = ?, detail = ?, content_hash = NULL
     WHERE stash_dir = ? AND proposal_id = ?`,
  ).run(nextEligibleAt(input.source, "proposed", input.at), trimDetail(input.detail), input.stashDir, input.proposalId);
}

/**
 * The same reopen for a proposal whose mint deliberately wrote no ledger row (a
 * retire proposal — see `createRetireProposal`): the row its rejection created
 * is dropped, returning the ledger to what the mint left. Found by
 * `proposal_id`, like {@link recordImproveLedgerDecision}.
 */
export function forgetImproveLedgerDecision(db: Database, stashDir: string, proposalId: string): void {
  db.prepare("DELETE FROM improve_ledger WHERE stash_dir = ? AND proposal_id = ?").run(stashDir, proposalId);
}

/**
 * Should-fix 6 (second review round): a read-only or dry-run open never
 * migrates, so it can land on a state.db from before migration 029 added
 * `content_hash` — reading it there threw "no such column", which
 * `loadRetrievalScope`'s own catch then reported as "usage history
 * unreadable", making the WHOLE scope `undefined` (every asset eligible) on
 * every read-only/dry-run call against an as-yet-unmigrated database. A
 * per-connection cache, since a real `Database` handle's schema does not
 * change mid-lifetime and this is checked on every ledger read.
 */
const hasContentHashColumnCache = new WeakMap<Database, boolean>();
function hasContentHashColumn(db: Database): boolean {
  const cached = hasContentHashColumnCache.get(db);
  if (cached !== undefined) return cached;
  const has = (db.prepare("PRAGMA table_info(improve_ledger)").all() as Array<{ name: string }>).some(
    (c) => c.name === "content_hash",
  );
  hasContentHashColumnCache.set(db, has);
  return has;
}

export function getImproveLedgerRow(
  db: Database,
  stashDir: string,
  ref: string,
  source: string,
): ImproveLedgerRow | undefined {
  const withHash = hasContentHashColumn(db);
  const row = db
    .prepare(
      `SELECT stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail${withHash ? ", content_hash" : ""}
       FROM improve_ledger WHERE stash_dir = ? AND ref = ? AND source = ?`,
    )
    .get(stashDir, ref, source) as LedgerSqlRow | undefined;
  return row ? toRow(withHash ? row : { ...row, content_hash: null }) : undefined;
}

/** Every row for one stash, optionally narrowed to `sources`. */
export function listImproveLedgerRows(db: Database, stashDir: string, sources?: readonly string[]): ImproveLedgerRow[] {
  const withHash = hasContentHashColumn(db);
  const sourceFilter = sources && sources.length > 0 ? ` AND source IN (${sources.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(
      `SELECT stash_dir, ref, source, last_attempt_at, outcome, next_eligible_at, proposal_id, detail${withHash ? ", content_hash" : ""}
       FROM improve_ledger WHERE stash_dir = ?${sourceFilter} ORDER BY ref ASC, source ASC`,
    )
    .all(stashDir, ...(sources && sources.length > 0 ? sources : [])) as LedgerSqlRow[];
  return rows.map((row) => toRow(withHash ? row : { ...row, content_hash: null }));
}
