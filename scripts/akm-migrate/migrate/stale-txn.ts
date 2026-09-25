// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stale durable-transaction journals (`$DATA/txn/<rootNs24>/<id>/journal.json`,
 * see `core/fs-txn.ts`) that never got recovered — a crash mid-transaction
 * left a journal on disk with no process left to finish or roll it back.
 * `akm health` used to only report these and point at a troubleshooting doc
 * (issue: an advisory that tells the user to go read docs instead of the
 * tool recovering its own interrupted state). Recovery IS a migration
 * concern like dead `.akm/` residue: `akm migrate status` names what is
 * here for the stash root, `akm migrate apply` recovers it, exactly like
 * `dead-residue.ts`.
 *
 * Recovery goes through {@link recoverTxnsForRoot}, which requires every
 * live kind's registrar to be IMPORTED first so its handler is registered
 * (see fs-txn.ts's module docs). `proposal/repository.ts` registers the
 * `proposal`/`proposal-reject` kinds specifically so "ANY recovery entry
 * point ... can finish or roll back an interrupted proposal mutation for a
 * root it touches" (its own comment on the registration) — this module is
 * exactly that kind of entry point.
 */

import {
  canonicalTxnRoot,
  listTxnJournalsTolerant,
  type QuarantinedTxn,
  recoverTxnsForRoot,
  type TxnJournal,
} from "../../../src/core/fs-txn";
// Side-effect import: registers the `proposal`/`proposal-reject` txn kinds
// so recovery below can roll them forward/back for the stash root.
import "../../../src/commands/proposal/repository";

/** One stale journal found under the stash root's transaction namespace. */
export interface StaleTxnEntry {
  transactionId: string;
  kind: string;
  phase: string;
  root: string;
}

/**
 * Find every durable-transaction journal bound to `stashDir`'s namespace.
 * Read-only, tolerant of a corrupt journal (counted, not thrown on) — mirrors
 * `findDeadResidueEntries`'s read-only/never-mutates contract.
 */
export function findStaleTxnEntries(stashDir: string): StaleTxnEntry[] {
  const root = canonicalTxnRoot(stashDir);
  const { matches } = listTxnJournalsTolerant((j) => canonicalTxnRoot(j.root) === root);
  return matches.map(({ journal }) => journalToEntry(journal));
}

function journalToEntry(journal: TxnJournal<unknown>): StaleTxnEntry {
  return { transactionId: journal.transactionId, kind: journal.kind, phase: journal.phase, root: journal.root };
}

/**
 * Recover every durable transaction bound to `stashDir`'s namespace: roll
 * back journals before their kind's commit point, roll forward the rest. A
 * journal that cannot be recovered is quarantined, not thrown — it is
 * resolved state, reported alongside what recovered normally. The
 * counterpart to {@link findStaleTxnEntries}, invoked only from `akm migrate
 * apply`.
 */
export async function recoverStaleTxns(
  stashDir: string,
): Promise<{ recovered: StaleTxnEntry[]; quarantined: QuarantinedTxn[] }> {
  const { recovered, quarantined } = await recoverTxnsForRoot(stashDir);
  return { recovered: recovered.map(journalToEntry), quarantined };
}
