// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Legacy filesystem proposal import (#578).
 *
 * Before 0.9.0 proposals lived as per-uuid JSON directories under
 * `<stashDir>/.akm/proposals/` (live) and `…/proposals/archive/` (archived).
 * The first proposal operation against a stash imports any legacy
 * `proposal.json` files into the `proposals` table (INSERT OR IGNORE keyed on
 * the UUID, so re-runs never duplicate) and records the stash in
 * `proposal_fs_imports` so later invocations skip the directory walk. The
 * legacy files are left in place untouched — they are inert after import and
 * may be removed by the operator at leisure.
 */

import fs from "node:fs";
import path from "node:path";
import {
  type Database,
  hasImportedFsProposals,
  insertProposalIfAbsent,
  recordFsProposalsImport,
} from "../../core/state-db";
import { warn } from "../../core/warn";
import type { Proposal } from "./repository";

/** Legacy (pre-0.9.0) proposal directory: `<stashDir>/.akm/proposals[/archive]`. */
function legacyProposalsRoot(stashDir: string, archive: boolean): string {
  const root = path.join(stashDir, ".akm", "proposals");
  return archive ? path.join(root, "archive") : root;
}

/**
 * Shape of a legacy `proposal.json` file. Identical to {@link Proposal} except
 * that the pre-0.9.0 `backup` field held a path (relative to the proposal
 * directory) instead of the backup content itself.
 */
type LegacyProposalFile = Omit<Proposal, "backupContent"> & { backup?: string };

/**
 * One-shot import of legacy `proposal.json` files into the `proposals` table.
 *
 * Idempotent at two levels: the `proposal_fs_imports` ledger skips the
 * directory walk after the first successful import, and INSERT OR IGNORE
 * (keyed on the proposal UUID) protects against duplicates even if the walk
 * re-runs. Legacy `backup.<ext>` files are inlined into `backupContent` so
 * `akm proposal revert` keeps working for proposals accepted before 0.9.0.
 *
 * The legacy files are never modified or deleted — after import they are
 * inert artifacts the operator can remove at leisure.
 */
export function importLegacyProposalFiles(db: Database, stashDir: string): void {
  if (hasImportedFsProposals(db, stashDir)) return;
  const liveRoot = legacyProposalsRoot(stashDir, false);
  if (!fs.existsSync(liveRoot)) return;

  let imported = 0;
  for (const archive of [false, true]) {
    const root = legacyProposalsRoot(stashDir, archive);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "archive") continue;
      const proposalDir = path.join(root, entry.name);
      const proposal = readLegacyProposalFile(proposalDir);
      if (!proposal) continue;
      if (insertProposalIfAbsent(db, proposal, stashDir)) imported += 1;
    }
  }

  recordFsProposalsImport(db, stashDir, imported);
  if (imported > 0) {
    warn(`[proposals] imported ${imported} legacy proposal file(s) from ${liveRoot} into state.db`);
  }
}

/**
 * Parse one legacy proposal directory into a {@link Proposal}, inlining the
 * backup file (when present) as `backupContent`. Returns undefined — with a
 * warning — when the `proposal.json` is missing, unreadable, or malformed, so
 * a single corrupt legacy entry never blocks the import of the rest.
 */
function readLegacyProposalFile(proposalDir: string): Proposal | undefined {
  const filePath = path.join(proposalDir, "proposal.json");
  let parsed: LegacyProposalFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyProposalFile;
  } catch (err) {
    warn(`[proposals] skipping legacy proposal at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.id !== "string" ||
    typeof parsed.ref !== "string"
  ) {
    warn(`[proposals] skipping legacy proposal at ${filePath}: not a proposal object`);
    return undefined;
  }

  const { backup, ...rest } = parsed;
  let backupContent: string | undefined;
  if (typeof backup === "string" && backup.length > 0) {
    try {
      backupContent = fs.readFileSync(path.join(proposalDir, backup), "utf8");
    } catch {
      // Backup file lost — import the proposal anyway; revert for it will
      // surface "no backup available", same as a new-asset proposal.
    }
  }

  return {
    ...rest,
    payload: {
      content: rest.payload?.content ?? "",
      ...(rest.payload?.frontmatter ? { frontmatter: rest.payload.frontmatter } : {}),
    },
    createdAt: rest.createdAt ?? "",
    updatedAt: rest.updatedAt ?? rest.createdAt ?? "",
    status: rest.status ?? "pending",
    source: rest.source ?? "import",
    ...(backupContent !== undefined ? { backupContent } : {}),
  };
}
