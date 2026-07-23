// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * One-time import of pre-0.9.0 filesystem proposals into the migrated state.db
 * `proposals` table (akm 0.9.0 Chunk-5 fold, completed in Chunk-8; plan §3.4).
 *
 * Before 0.9.0 the proposal queue lived as per-uuid JSON directories under
 * `<stashDir>/.akm/proposals/` (live) and `…/proposals/archive/` (archived).
 * This fold USED to run on EVERY proposal operation (through
 * `withProposalsDb`, guarded by a `proposal_fs_imports` ledger). That disk
 * probe is gone from the live path: the import now runs ONCE, as an ADDITIVE
 * filesystem step of `akm migrate apply`'s `cutover-applied` phase — a sibling
 * of the `.stash.json`/D-R6 content migration — AFTER the committed state txn,
 * best-effort (a throw is swallowed + logged by the caller, never aborting a
 * committed cutover) and idempotent.
 *
 * Idempotency without the old ledger: each row lands through
 * {@link insertProposalIfAbsent} (INSERT OR IGNORE keyed on the proposal UUID),
 * so re-walking the still-on-disk legacy files on a resumed or re-run apply
 * inserts nothing new and never duplicates. The legacy files are never modified
 * or deleted — after import they are inert artifacts the operator can remove at
 * leisure. Legacy `backup.<ext>` files are inlined into `backupContent` so
 * `akm proposal revert` keeps working for proposals accepted before 0.9.0.
 *
 * Parsing and backup inlining retain the frozen pre-0.9.0 behavior from the
 * deleted `src/commands/proposal/legacy-import.ts`. Before insertion, refs are
 * translated through the frozen legacy grammar module so normal proposal
 * runtime boundaries remain new-grammar-only.
 *
 * Migrator-only: opens state.db through the raw storage engine (leaving its
 * journal mode untouched — the apply has already collapsed it to single-file
 * DELETE mode) and never sits on a live indexer or command path.
 */

import fs from "node:fs";
import path from "node:path";
import type { Proposal } from "../../commands/proposal/proposal-types";
import { warn } from "../../core/warn";
import { deriveInstallations, slugForPath } from "../../indexer/installations";
import { type Database, openDatabase } from "../../storage/database";
import { insertProposalIfAbsent } from "../../storage/repositories/proposals-repository";
import { classifyRefGrammar, legacyRefToBundleRef } from "../legacy-ref-grammar";

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
 * Import every stash root's legacy `proposal.json` files into the state.db at
 * `stateDbPath`. Returns the total number of rows actually inserted (a re-run
 * over the same roots returns 0 — every UUID is already present). Best-effort:
 * a per-root or per-file failure is logged and skipped, and a failure to open
 * state.db at all returns 0 rather than throwing (the committed cutover is
 * unaffected).
 */
export function importLegacyProposalsIntoState(stateDbPath: string, stashRoots: readonly string[]): number {
  if (!fs.existsSync(stateDbPath)) return 0;
  let db: Database;
  try {
    db = openDatabase(stateDbPath);
  } catch (err) {
    warn(`[akm] content-migration: could not open state.db for legacy proposal import: ${errMsg(err)}`);
    return 0;
  }
  try {
    let imported = 0;
    const seen = new Set<string>();
    for (const root of stashRoots) {
      const resolved = path.resolve(root);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      imported += importLegacyProposalsForStash(db, resolved);
    }
    return imported;
  } finally {
    db.close();
  }
}

/**
 * Import one stash root's legacy proposal directories (live + archive) into the
 * open state.db. Returns the number of rows inserted for this stash.
 */
function importLegacyProposalsForStash(db: Database, stashDir: string): number {
  const liveRoot = legacyProposalsRoot(stashDir, false);
  if (!fs.existsSync(liveRoot)) return 0;

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
      const proposal = readLegacyProposalFile(proposalDir, stashDir);
      if (!proposal) continue;
      try {
        if (insertProposalIfAbsent(db, proposal, stashDir)) imported += 1;
      } catch (err) {
        warn(`[akm] content-migration: could not import legacy proposal at ${proposalDir}: ${errMsg(err)}`);
      }
    }
  }

  if (imported > 0) {
    warn(`[akm] content-migration: imported ${imported} legacy proposal file(s) from ${liveRoot} into state.db`);
  }
  return imported;
}

/**
 * Parse one legacy proposal directory into a {@link Proposal}, inlining the
 * backup file (when present) as `backupContent`. Returns undefined — with a
 * warning — when the `proposal.json` is missing, unreadable, or malformed, so
 * a single corrupt legacy entry never blocks the import of the rest.
 */
function readLegacyProposalFile(proposalDir: string, stashDir: string): Proposal | undefined {
  const filePath = path.join(proposalDir, "proposal.json");
  let parsed: LegacyProposalFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyProposalFile;
  } catch (err) {
    warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: ${errMsg(err)}`);
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.id !== "string" ||
    typeof parsed.ref !== "string"
  ) {
    warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: not a proposal object`);
    return undefined;
  }

  const { backup, ...rest } = parsed;
  let migratedRef = rest.ref;
  let migratedTarget = rest.proposedTarget;
  if (classifyRefGrammar(rest.ref) === "legacy") {
    try {
      const translated = legacyRefToBundleRef(rest.ref);
      const bundle =
        translated.bundle ?? deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
      migratedRef = `${bundle}//${translated.conceptId}`;
      if (translated.bundle) migratedTarget = { source: translated.bundle, root: path.resolve(stashDir) };
    } catch (err) {
      warn(`[akm] content-migration: skipping legacy proposal at ${filePath}: ${errMsg(err)}`);
      return undefined;
    }
  }
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
    ref: migratedRef,
    ...(migratedTarget ? { proposedTarget: migratedTarget } : {}),
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

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
