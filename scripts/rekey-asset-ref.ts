// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Carry an asset's EARNED SIGNAL across a rename.
 *
 * 0.9.0 removed `akm mv`: a rename is a plain filesystem move followed by
 * `akm index` and `akm lint` (docs/architecture/specs/ref.md § Renames and
 * moves). That procedure is correct for identity and for inbound refs, but the
 * new file gets a fresh identity — so every row keyed by the OLD ref is
 * orphaned: the index `entries` row (and with it the `utility_scores` /
 * `embeddings` history hanging off its row id), the state.db
 * `asset_salience` / `asset_outcome` rows, and `usage_events.entry_ref`.
 *
 * This script re-keys those rows old→new. It is the OCCASIONAL-SURGERY half of
 * the removal: not a command, not part of any loop, run by hand right after a
 * rename you care about the ranking history of.
 *
 * Maintainer tooling (STABILITY.md "Internal") — `scripts/` may import `src/`,
 * never the reverse.
 *
 * Usage:
 *   bun scripts/rekey-asset-ref.ts <old-ref> <new-ref> [--dry-run]
 *
 *   <old-ref>   Pre-rename ref in the `[bundle//]conceptId` grammar
 *   <new-ref>   Post-rename ref, same bundle and same asset type
 *   --dry-run   Report the counts that WOULD change; write nothing
 *   --help      Print this usage and exit
 *
 * Order of operations (run it AFTER moving the file; `akm index` may run
 * before or after — before is better, since an intact old `entries` row is
 * what lets the index re-key preserve the row id):
 *
 *   mv ~/akm/memories/old.md ~/akm/memories/new.md
 *   bun scripts/rekey-asset-ref.ts memories/old memories/new
 *   akm index && akm lint
 *
 * Prints a JSON summary ({ dryRun, oldRef, newRef, changed, warnings }) to
 * stdout; exits 1 on any refusal.
 *
 * Idempotent: a second run finds nothing to move, reports zero changed rows,
 * appends no event, and exits 0. Automated GC of orphaned rows is tracked as
 * issue #733 — this script is the manual path until then.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { refToRelPath } from "../src/commands/lint/base-linter";
import { conceptIdFromTypeName, parseRefInput } from "../src/core/asset/resolve-ref";
import { resolveStashDir } from "../src/core/common";
import { loadConfig } from "../src/core/config/config";
import { appendEvent } from "../src/core/events";
import { getDbPath } from "../src/core/paths";
import { getStateDbPath, withStateDb } from "../src/core/state-db";
import { resolveSourceEntries } from "../src/indexer/search/search-source";
import type { Database } from "../src/storage/database";
import { closeDatabase, openExistingDatabase } from "../src/storage/repositories/index-connection";
import { rekeyEntryInPlace } from "../src/storage/repositories/index-entries-repository";

/** Durable source identity for a working stash with no configured bundle owner. */
const DEFAULT_SOURCE_NAME = "stash";

/** state.db tables keyed by a bare `asset_ref` PRIMARY KEY (migrations 009/010). */
const SCALAR_STATE_TABLES = ["asset_salience", "asset_outcome"] as const;

export interface RekeyAssetRefResult {
  dryRun: boolean;
  /** Fully-qualified `<bundle>//<conceptId>` spelling of the old ref. */
  oldRef: string;
  /** Fully-qualified `<bundle>//<conceptId>` spelling of the new ref. */
  newRef: string;
  changed: {
    /** 1 when an `entries` row was re-keyed in place (row id preserved), else 0. */
    indexEntries: number;
    asset_salience: number;
    asset_outcome: number;
    usage_events: number;
    total: number;
  };
  warnings: string[];
}

export interface RekeyAssetRefOptions {
  dryRun?: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Resolve the bundle identity and root the two refs live in.
 *
 * A ref with a `bundle//` prefix must name a configured bundle. A bare ref
 * means the working stash, whose durable identity is its configured
 * `registryId` — falling back to `defaultBundle` and then to the
 * {@link DEFAULT_SOURCE_NAME} spelling stored rows carried before the bundle
 * map existed (an explicit `AKM_BUNDLE_DIR` override is identity-less).
 */
function resolveBundle(origin: string | undefined): { sourceName: string; sourceRoot: string } {
  const config = loadConfig();
  const stashDir = resolveStashDir();
  const sources = resolveSourceEntries(stashDir, config);
  if (origin !== undefined) {
    const owner = sources.find((source) => source.registryId === origin);
    if (!owner) fail(`Bundle "${origin}" is not configured — nothing re-keyed.`);
    return { sourceName: origin, sourceRoot: path.resolve(owner.path) };
  }
  const primary = sources.find((source) => path.resolve(source.path) === path.resolve(stashDir));
  return {
    sourceName: primary?.registryId ?? config.defaultBundle ?? DEFAULT_SOURCE_NAME,
    sourceRoot: path.resolve(stashDir),
  };
}

/** Absolute canonical path a `type`/`name` pair places to inside `root`. */
function assetPath(root: string, type: string, name: string): string {
  const rel = refToRelPath(type, name);
  if (!rel) fail(`Asset type "${type}" has no known stash placement — nothing re-keyed.`);
  return path.join(root, rel);
}

/**
 * Re-key the two scalar state tables plus `usage_events`.
 *
 * Collision policy matches the index re-key's (live-asset-wins): a row already
 * sitting AT the new ref can only be an orphan of a previously deleted asset —
 * the caller has verified no file exists at the OLD path and one does at the
 * new — so the orphan is dropped and the live asset's history takes the ref.
 * For `usage_events` only DETACHED rows (`entry_id IS NULL`) are dropped; an
 * attached row belongs to a live entry and is never collateral.
 */
function rekeyStateDb(oldRef: string, newRef: string, dryRun: boolean): Record<string, number> {
  const counts: Record<string, number> = { asset_salience: 0, asset_outcome: 0, usage_events: 0 };
  if (!fs.existsSync(getStateDbPath())) return counts;
  return withStateDb((db) => {
    const countAt = (table: string, ref: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_ref = ?`).get(ref) as { n: number }).n;
    for (const table of SCALAR_STATE_TABLES) {
      if (dryRun) {
        counts[table] = countAt(table, oldRef);
        continue;
      }
      db.transaction(() => {
        if (countAt(table, oldRef) === 0) return;
        db.prepare(`DELETE FROM ${table} WHERE asset_ref = ?`).run(newRef);
        counts[table] = Number(
          db.prepare(`UPDATE ${table} SET asset_ref = ? WHERE asset_ref = ?`).run(newRef, oldRef).changes,
        );
      })();
    }
    if (dryRun) {
      counts.usage_events = (
        db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref = ?").get(oldRef) as { n: number }
      ).n;
    } else {
      db.transaction(() => {
        db.prepare("DELETE FROM usage_events WHERE entry_id IS NULL AND entry_ref = ?").run(newRef);
        counts.usage_events = Number(
          db.prepare("UPDATE usage_events SET entry_ref = ? WHERE entry_ref = ?").run(newRef, oldRef).changes,
        );
      })();
    }
    return counts;
  });
}

/**
 * Re-key the index `entries` row IN PLACE, preserving its row id — which is
 * what keeps `utility_scores` and `embeddings` attached across the rename.
 * Returns 1 when a row moved.
 *
 * Zero is the ordinary outcome when `akm index` already ran: the old row was
 * deleted as a missing file and a fresh row minted for the new path, so only
 * the state.db signal is left to carry.
 */
function rekeyIndexEntry(args: {
  sourceName: string;
  sourceRoot: string;
  newName: string;
  oldConceptId: string;
  newConceptId: string;
  newFilePath: string;
  dryRun: boolean;
}): number {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return 0;
  const db: Database = openExistingDatabase(dbPath);
  try {
    const oldItemRef = `${args.sourceName}//${args.oldConceptId}`;
    if (args.dryRun) {
      return db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(oldItemRef) == null ? 0 : 1;
    }
    const rekeyed = rekeyEntryInPlace(db, {
      newName: args.newName,
      newFilePath: args.newFilePath,
      oldRef: args.oldConceptId,
      newRef: args.newConceptId,
      sourceName: args.sourceName,
      sourceRoot: args.sourceRoot,
    });
    if (rekeyed === null) return 0;
    return 1;
  } finally {
    closeDatabase(db);
  }
}

/**
 * Re-key every row keyed to `oldRefInput` onto `newRefInput`.
 *
 * Refusals (all before any write, so a rejected run changes nothing):
 *   - either ref unparseable, or the two naming different bundles or different
 *     asset types — those are copy/import + delete, never identity-preserving;
 *   - the OLD ref's file still on disk — with the new file present that is a
 *     COPY, not a rename, and re-keying would strand the original's history;
 *     with the new file absent the rename simply has not happened yet;
 *   - the NEW ref resolving nowhere (neither on disk nor in the index).
 *
 * A new ref present on disk but absent from the index is normal (the rename is
 * newer than the last `akm index`) and only warns.
 */
export function rekeyAssetRef(
  oldRefInput: string,
  newRefInput: string,
  options?: RekeyAssetRefOptions,
): RekeyAssetRefResult {
  const dryRun = options?.dryRun === true;
  const warnings: string[] = [];

  const from = parseRefInput(oldRefInput);
  const to = parseRefInput(newRefInput);
  if (from.origin !== to.origin) {
    fail(
      `Cross-bundle re-key refused (${from.origin ?? "<working stash>"} -> ${to.origin ?? "<working stash>"}): ` +
        "moving an asset between bundles is copy/import plus delete, and the destination gets a fresh identity.",
    );
  }
  if (from.type !== to.type) {
    fail(
      `Cross-type re-key refused (${from.type} -> ${to.type}): an asset's type is part of its identity, so the ` +
        "destination is a different asset — nothing to carry over.",
    );
  }
  if (from.name === to.name) fail("The old and new refs are the same — nothing to re-key.");

  const { sourceName, sourceRoot } = resolveBundle(from.origin);
  const oldConceptId = conceptIdFromTypeName(from.type, from.name);
  const newConceptId = conceptIdFromTypeName(to.type, to.name);
  const oldRef = `${sourceName}//${oldConceptId}`;
  const newRef = `${sourceName}//${newConceptId}`;

  const oldPath = assetPath(sourceRoot, from.type, from.name);
  const newPath = assetPath(sourceRoot, to.type, to.name);
  const newOnDisk = fs.existsSync(newPath);
  if (fs.existsSync(oldPath)) {
    fail(
      newOnDisk
        ? `Both ${path.relative(sourceRoot, oldPath)} and ${path.relative(sourceRoot, newPath)} exist — that is a ` +
            "COPY, not a rename. Delete the old file first if you meant to move it; nothing re-keyed."
        : `${path.relative(sourceRoot, oldPath)} still exists — move the file first, then re-key; nothing re-keyed.`,
    );
  }

  const newIndexed =
    fs.existsSync(getDbPath()) &&
    (() => {
      const db = openExistingDatabase(getDbPath());
      try {
        return db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(newRef) != null;
      } finally {
        closeDatabase(db);
      }
    })();
  if (!newOnDisk && !newIndexed) {
    fail(`"${newRef}" resolves neither on disk (${path.relative(sourceRoot, newPath)}) nor in the index.`);
  }
  if (newOnDisk && !newIndexed) {
    warnings.push(`"${newRef}" is not in the index yet — run \`akm index\` after this re-key.`);
  }

  // state.db FIRST: the index re-key below rewrites `usage_events` itself, so
  // running it after would report those rows as its own and double-count them.
  const state = rekeyStateDb(oldRef, newRef, dryRun);
  let indexEntries: number;
  try {
    indexEntries = rekeyIndexEntry({
      sourceName,
      sourceRoot,
      newName: to.name,
      oldConceptId,
      newConceptId,
      newFilePath: newPath,
      dryRun,
    });
  } catch (indexError) {
    // The state.db updates above are already committed (separate database,
    // separate transactions). Leaving them in place would split identity:
    // state.db on the new ref, index.db on the old. Compensate by re-keying
    // state.db straight back, so a failed run changes nothing and is safely
    // re-runnable after the index problem is fixed.
    if (!dryRun) {
      try {
        rekeyStateDb(newRef, oldRef, false);
      } catch (compensationError) {
        fail(
          `Index re-key failed (${indexError instanceof Error ? indexError.message : String(indexError)}) AND ` +
            `rolling state.db back failed (${compensationError instanceof Error ? compensationError.message : String(compensationError)}). ` +
            `state.db now points at "${newRef}" while the index still points at "${oldRef}" — ` +
            `re-run this script after fixing the index error to finish the move, or run it with the refs ` +
            "swapped to restore the old identity.",
        );
      }
    }
    fail(
      `Index re-key failed: ${indexError instanceof Error ? indexError.message : String(indexError)}. ` +
        "state.db changes were rolled back — nothing was re-keyed. Fix the index error " +
        "(often: run `akm index` first) and re-run.",
    );
  }

  const changed = {
    indexEntries,
    asset_salience: state.asset_salience ?? 0,
    asset_outcome: state.asset_outcome ?? 0,
    usage_events: state.usage_events ?? 0,
    total: 0,
  };
  changed.total = changed.indexEntries + changed.asset_salience + changed.asset_outcome + changed.usage_events;

  // One event per re-key that actually moved something. A no-op re-run stays
  // silent so idempotency does not smear the events stream.
  if (!dryRun && changed.total > 0) {
    appendEvent({
      eventType: "rekey",
      ref: newRef,
      metadata: { from: oldRef, to: newRef, changed },
    });
  }

  return { dryRun, oldRef, newRef, changed, warnings };
}

const USAGE = `Usage: bun scripts/rekey-asset-ref.ts <old-ref> <new-ref> [--dry-run]

  <old-ref>   Pre-rename ref in the \`[bundle//]conceptId\` grammar
  <new-ref>   Post-rename ref, same bundle and same asset type
  --dry-run   Report the counts that WOULD change; write nothing
  --help      Print this usage and exit
`;

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const [oldRef, newRef, ...extra] = positionals;
  if (oldRef === undefined || newRef === undefined || extra.length > 0) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const result = rekeyAssetRef(oldRef, newRef, { dryRun: values["dry-run"] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
