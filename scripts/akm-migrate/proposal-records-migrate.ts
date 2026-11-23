// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `proposalRecords` step: proposals in state.db that an older akm wrote name files (`changes[].path/after`,
 * `proposedTarget.root`, `acceptedTarget.root/path`); this step rewrites each as the current record (refs, no files),
 * so no command warns about them any more. Until it runs they are read as converted, in memory. The rewrite is one
 * transaction, after a copy of the database (`state.db.pre-proposal-records.bak`); a run cut short changes nothing.
 */

import fs from "node:fs";
import { convertLegacyProposalMetadata, isLegacyProposalMetadata } from "../../src/commands/proposal/legacy-records";
import {
  getStateDbPath,
  listPendingStateMigrations,
  withImmediateTransaction,
  withReadonlyStateDb,
  withStateDb,
} from "../../src/core/state-db";
import type { Database } from "../../src/storage/database";

export interface ProposalRecordsSummary {
  schemaVersion: 1;
  /** Records of an older shape, to rewrite (before the step runs) or rewritten (after). */
  changed: number;
  message: string;
  /** Present after a real apply that rewrote at least one record: the copy of state.db it took first. */
  backupPath?: string;
  applied?: number;
}

export interface ProposalRecordsMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready";
  proposalRecords: ProposalRecordsSummary;
}

interface OldRecord {
  id: string;
  metadata: string;
}

function summarize(changed: number, verb: "to rewrite" | "rewritten"): ProposalRecordsSummary {
  return { schemaVersion: 1, changed, message: `proposal records: ${changed} ${verb}` };
}

function statusOf(summary: ProposalRecordsSummary): ProposalRecordsMigrationStatus {
  return { schemaVersion: 1, status: summary.changed > 0 ? "ready" : "current", proposalRecords: summary };
}

/** The records of an older shape, each with the current `metadata_json` that replaces it. */
function oldRecords(db: Database): OldRecord[] {
  const rows = db.prepare("SELECT id, ref, metadata_json FROM proposals").all() as Array<{
    id: string;
    ref: string;
    metadata_json: string;
  }>;
  const found: OldRecord[] = [];
  for (const row of rows) {
    let meta: unknown;
    try {
      meta = JSON.parse(row.metadata_json);
    } catch {
      continue;
    }
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) continue;
    if (!isLegacyProposalMetadata(meta as Record<string, unknown>)) continue;
    const converted = convertLegacyProposalMetadata(meta as Record<string, unknown>, row.ref);
    found.push({ id: row.id, metadata: JSON.stringify(converted.meta) });
  }
  return found;
}

/** Whether state.db exists and is as current as this akm needs to read proposals (the state step runs first). */
function readable(): boolean {
  return fs.existsSync(getStateDbPath()) && listPendingStateMigrations().length === 0;
}

/** Read-only: how many records `apply` would rewrite. */
export function inspectProposalRecordsMigration(): ProposalRecordsMigrationStatus {
  return statusOf(
    summarize(
      withReadonlyStateDb((db) => oldRecords(db).length, 0),
      "to rewrite",
    ),
  );
}

/** Rewrite every old record as the current one, in one transaction, after a copy of state.db. */
export function applyProposalRecordsMigration(): ProposalRecordsMigrationStatus {
  if (!readable()) return statusOf(summarize(0, "rewritten"));
  return withStateDb((db) => {
    const records = oldRecords(db);
    if (records.length === 0) return statusOf(summarize(0, "rewritten"));
    const backupPath = `${getStateDbPath()}.pre-proposal-records.bak`;
    const partialPath = `${backupPath}.tmp`;
    fs.rmSync(partialPath, { force: true });
    db.prepare("VACUUM INTO ?").run(partialPath);
    fs.renameSync(partialPath, backupPath);
    withImmediateTransaction(db, () => {
      const update = db.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?");
      for (const record of records) update.run(record.metadata, record.id);
    });
    return statusOf({ ...summarize(records.length, "rewritten"), applied: records.length, backupPath });
  });
}
