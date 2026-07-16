// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `FileChange` — the minimal durable change unit (plan §2.2).
 *
 * One `FileChange` describes one file mutation; a `Proposal` carries
 * `changes: FileChange[]` (multi-file capable — consolidate ops ride the same
 * envelope once the unified transaction lands), and ONE core transaction
 * applies a whole batch atomically (Chunk 6 WI-6.3 collapses the three legacy
 * journal engines onto it).
 *
 * Deliberately dependency-free: this module is imported by the proposal
 * repository (commands layer), the storage row mappers, and the transaction
 * engine, and must never join an import cycle.
 */

/** What the change does to its target file. */
export type FileChangeOp = "create" | "update" | "delete";

/**
 * The content of a proposal's PRIMARY change (WI-6.2 envelope read path).
 *
 * By construction `changes[0].after === payload.content`; consumers read
 * through this accessor so the single-content assumption lives in ONE place
 * once multi-file proposals (consolidate ops) ride the envelope. Falls back
 * to the payload for legacy in-memory objects that predate the envelope.
 * Typed structurally (not against `Proposal`) so this module stays
 * dependency-free.
 */
export function proposalContent(p: { payload: { content: string }; changes?: FileChange[] }): string {
  return p.changes?.[0]?.after ?? p.payload.content;
}

export interface FileChange {
  /**
   * Stash-relative path of the target file.
   *
   * For proposal-minted changes this is the mint-time resolution against the
   * proposal's OWN stash and is informational — the accept path re-resolves
   * the write target from config at apply time (and records the result on
   * `Proposal.acceptedTarget`). Legacy proposal rows (persisted before the
   * envelope existed) carry the empty string; resolve from the ref instead.
   */
  path: string;
  /**
   * Content expected on disk BEFORE the change applies.
   *
   * Not populated (or persisted) at proposal-mint time — the mint-time
   * before-state is summarised by `Proposal.beforeHash` instead. The unified
   * transaction engine captures its own live `before` when a transaction
   * starts, for hash-verified rollback.
   */
  before?: string;
  /** Content the change writes. Absent for `op: "delete"`. */
  after?: string;
  op: FileChangeOp;
}
