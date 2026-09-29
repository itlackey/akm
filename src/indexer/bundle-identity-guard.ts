// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * §11.5 bundle-rename startup guard.
 *
 * Renaming a workspace bundle id is a mass identity migration (every ref in the
 * bundle changes without any file moving) and MUST go through the future
 * explicit `akm bundle rename <old> <new>` command, which rekeys the index +
 * every ref-keyed state table atomically. If a user instead hand-edits the
 * `bundles` KEY in config.json, the durable index/state rows still carry the OLD
 * bundle prefix while the config names the NEW id. Silently re-minting fresh
 * state under the new id would strand the old rows; §11.5 requires we detect this
 * and refuse-or-warn.
 *
 * This guard implements the cheap heuristic form (WARN, never silently re-mint):
 * it compares the configured bundle ids against the DISTINCT `bundle_id`
 * (item_ref bundle prefix) values already persisted in the index — and, by
 * cutover construction, the same prefixes key the state.db usage/salience rows.
 * The hand-rename signature is: a configured bundle id with NO indexed rows
 * co-existing with indexed rows under a bundle id that is no longer configured.
 *
 * SEAM CHOICE: invoked from `ensureIndex` — the single funnel every read/index
 * path passes through before consuming or (re)building the index, so the guard
 * fires BEFORE a stale-index rebuild could re-mint fresh rows under the new id.
 * It has a handful of call sites (vs. `loadConfig`'s hundreds), reads a cached
 * config plus one indexed `DISTINCT` query, and settles after the first
 * comparison over a non-empty index so the steady-state cost is a boolean check.
 */

import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../core/config/config";
import { loadConfig } from "../core/config/config";
import { rethrowIfTestIsolationError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { hasCurrentEntriesTable } from "../storage/repositories/index-entry-schema";

let guardSettled = false;

/** TEST-ONLY: re-arm the once-per-process guard between cases. */
export function resetBundleIdentityGuardForTests(): void {
  guardSettled = false;
}

interface IndexedBundlePath {
  bundleId: string;
  filePath: string;
}

/** Bundle/path ownership persisted in the index, or `undefined` when unreadable. */
function indexedBundlePaths(dbPath: string): IndexedBundlePath[] | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  let db: ReturnType<typeof openReadonlyExistingDatabase>;
  try {
    db = openReadonlyExistingDatabase(dbPath);
    if (!db) return undefined;
    if (!hasCurrentEntriesTable(db)) return undefined;
    return db
      .prepare(
        "SELECT DISTINCT bundle_id AS bundleId, file_path AS filePath FROM entries " +
          "WHERE bundle_id IS NOT NULL AND bundle_id != '' AND file_path IS NOT NULL AND file_path != ''",
      )
      .all() as IndexedBundlePath[];
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // Best-effort startup diagnostic: a locked/corrupted index just means this
    // pass skips the drift check (retried on the next command) rather than
    // blocking every command on a heuristic warning.
    return undefined;
  } finally {
    if (db) closeDatabase(db);
  }
}

/**
 * Warn (once per process) when the config's bundle ids and the index's bundle
 * prefixes show the hand-rename signature (§11.5). No-op for an old-shape config
 * (no `bundles`), an absent/empty index, or when the guard already settled.
 */
export function warnOnBundleRenameDrift(config: AkmConfig = loadConfig()): void {
  if (guardSettled) return;
  const bundles = config.bundles;
  if (!bundles) return; // old-shape config — no bundle identity to guard (do not settle)
  const configIds = new Set(Object.keys(bundles));
  if (configIds.size === 0) return;

  const indexedPaths = indexedBundlePaths(getDbPath());
  if (indexedPaths === undefined || indexedPaths.length === 0) return; // nothing indexed yet — re-check later

  // A real comparison happened over a populated index: settle so the steady
  // state is one boolean check.
  guardSettled = true;

  const indexIds = [...new Set(indexedPaths.map((row) => row.bundleId))];
  const indexIdSet = new Set(indexIds);
  const configuredMissingFromIndex = [...configIds].filter((id) => !indexIdSet.has(id));
  const indexedNotConfigured = indexIds.filter((id) => !configIds.has(id));
  if (configuredMissingFromIndex.length === 0 || indexedNotConfigured.length === 0) return;

  // A mismatched id set alone is also the ordinary signature of adding a new
  // bundle while stale rows from a removed bundle still exist. Treat it as a
  // hand rename only when the old rows physically live beneath the newly named
  // filesystem bundle's root. This keeps the guard useful without warning on
  // unrelated new bundles (#971).
  const renamedConfiguredIds = configuredMissingFromIndex.filter((configuredId) => {
    const configuredPath = config.bundles?.[configuredId]?.path;
    if (typeof configuredPath !== "string") return false;
    const root = path.resolve(configuredPath);
    return indexedPaths.some((row) => {
      if (!indexedNotConfigured.includes(row.bundleId)) return false;
      const relative = path.relative(root, path.resolve(row.filePath));
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  });
  if (renamedConfiguredIds.length === 0) return;

  const renamedOldIds = [
    ...new Set(
      indexedPaths
        .filter((row) => {
          if (!indexedNotConfigured.includes(row.bundleId)) return false;
          return renamedConfiguredIds.some((configuredId) => {
            const configuredPath = config.bundles?.[configuredId]?.path;
            if (typeof configuredPath !== "string") return false;
            const relative = path.relative(path.resolve(configuredPath), path.resolve(row.filePath));
            return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
          });
        })
        .map((row) => row.bundleId),
    ),
  ];

  warn(
    "WARNING: bundle identity drift detected. " +
      `Configured bundle(s) with no indexed content: ${renamedConfiguredIds.map((id) => `"${id}"`).join(", ")}; ` +
      `indexed content under unconfigured bundle id(s): ${renamedOldIds.map((id) => `"${id}"`).join(", ")}. ` +
      "This is the signature of a hand-renamed bundle id (spec §11.5). AKM will NOT silently re-mint fresh state " +
      "under the new id. There is no rekey command in 0.9.0: either restore the previous bundle id in config.json " +
      "to reattach the existing rows, or keep the new id and run `akm index --full` to re-mint under it, accepting " +
      "that learned state (utility, salience, outcomes, usage history) keyed to the old id is left behind.",
  );
}
