// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The stages' view of the `improve_ledger` table: record an attempt, and load
 * the rows candidate selection reads before it spends an LLM call. The
 * repository owns the schema and the outcome → cadence rule.
 */

import fs from "node:fs";
import type { EventsContext } from "../../core/events";
import { getStateDbPath, withImmediateTransaction, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import type { Database } from "../../storage/database";
import {
  type ImproveLedgerOutcome,
  type ImproveLedgerRow,
  isLedgerBlocked,
  listImproveLedgerRows,
  recordImproveLedger,
} from "../../storage/repositories/improve-ledger-repository";
import { openSqliteReadSnapshot } from "../../storage/sqlite-read-snapshot";
import type { ProposalsContext } from "../proposal/repository";

export type { ImproveLedgerOutcome, ImproveLedgerRow };
export { isLedgerBlocked };

/** An improve candidate's durable state key: its index item_ref, else its conceptId. */
export function stateKey(ref: string, itemRef?: string): string {
  return itemRef ?? ref;
}

/** The conceptId part of a durable key (`bundle//conceptId` → `conceptId`). */
export function stripBundle(ref: string): string {
  const boundary = ref.indexOf("//");
  return boundary >= 0 ? ref.slice(boundary + 2) : ref;
}

/** How a stage reaches state.db: the same seams its proposals and events use. */
export interface LedgerAccess {
  proposalsCtx?: ProposalsContext;
  eventsCtx?: EventsContext;
  /** Dry-run planning: read a point-in-time snapshot and never create state.db. */
  readOnly?: boolean;
}

function ledgerDbPath(access: LedgerAccess | undefined): string | undefined {
  return access?.proposalsCtx?.dbPath ?? access?.eventsCtx?.dbPath;
}

/**
 * Run `fn` against the ledger's database: the run's borrowed handle, a read
 * snapshot for a read-only caller (`undefined` when state.db does not exist),
 * or a managed open.
 */
function withLedgerDb<T>(access: LedgerAccess | undefined, fn: (db: Database) => T): T | undefined {
  const borrowed = access?.eventsCtx?.db;
  if (borrowed) return fn(borrowed);
  const dbPath = ledgerDbPath(access);
  if (access?.readOnly) {
    const db = openSqliteReadSnapshot(dbPath ?? getStateDbPath());
    if (!db) return undefined;
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  return withStateDb(fn, dbPath !== undefined ? { path: dbPath } : undefined);
}

export interface LedgerAttemptInput {
  stashDir: string;
  /** Durable spelling of the attempted asset ({@link stateKey}). */
  ref: string;
  source: string;
  outcome: ImproveLedgerOutcome;
  detail?: string;
  proposalId?: string;
}

/**
 * Record what a stage just did with one or more refs. Best-effort: a failure
 * is a warning, never an error on top of an LLM result. (Proposal mints and
 * decisions write the ledger in their own transactions.)
 */
export function recordLedgerAttempt(
  access: LedgerAccess | undefined,
  inputs: LedgerAttemptInput | readonly LedgerAttemptInput[],
): void {
  const list: readonly LedgerAttemptInput[] = Array.isArray(inputs) ? inputs : [inputs as LedgerAttemptInput];
  if (list.length === 0 || access?.readOnly || access?.eventsCtx?.readOnly) return;
  const now = access?.proposalsCtx?.now ?? access?.eventsCtx?.now ?? Date.now;
  const at = new Date(now()).toISOString();
  try {
    withLedgerDb(access, (db) =>
      withImmediateTransaction(db, () => {
        for (const input of list) {
          recordImproveLedger(db, {
            stashDir: input.stashDir,
            ref: input.ref,
            source: input.source,
            outcome: input.outcome,
            at,
            ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
          });
        }
      }),
    );
  } catch (error) {
    const first = list[0] as LedgerAttemptInput;
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : "";
    warn(
      `[improve] ledger write failed for ${first.ref}${more} (${first.source} → ${first.outcome}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Rows for one stash keyed by `source\0ref`, loaded once per selection pass. */
export type LedgerSnapshot = ReadonlyMap<string, ImproveLedgerRow>;

export function ledgerKey(source: string, ref: string): string {
  return `${source}\0${ref}`;
}

/** Every ledger row for `sources` in one query; no state.db yet means nothing was attempted. */
export function loadLedgerSnapshot(
  access: LedgerAccess | undefined,
  stashDir: string,
  sources: readonly string[],
): LedgerSnapshot {
  const out = new Map<string, ImproveLedgerRow>();
  if (!access?.eventsCtx?.db && !fs.existsSync(ledgerDbPath(access) ?? getStateDbPath())) return out;
  try {
    withLedgerDb(access, (db) => {
      for (const row of listImproveLedgerRows(db, stashDir, sources)) out.set(ledgerKey(row.source, row.ref), row);
    });
  } catch (error) {
    warn(`[improve] ledger read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out;
}

/** The row for a candidate under its durable key. */
export function ledgerRowFor(
  snapshot: LedgerSnapshot,
  source: string,
  ref: string,
  itemRef?: string,
): ImproveLedgerRow | undefined {
  return snapshot.get(ledgerKey(source, stateKey(ref, itemRef)));
}

/** `ref → last_attempt_at` for one source over a candidate set (the signal-delta cursor). */
export function lastAttemptByRef(
  snapshot: LedgerSnapshot,
  source: string,
  candidates: readonly { ref: string; itemRef?: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const candidate of candidates) {
    const row = ledgerRowFor(snapshot, source, candidate.ref, candidate.itemRef);
    if (row) out.set(candidate.ref, row.lastAttemptAt);
  }
  return out;
}
