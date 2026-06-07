// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One-time, read-only guard for un-migrated `vaults/` directories (0.9.0).
 *
 * Background: 0.8.0 introduced the `env` asset type and a `vaults/` → `env/`
 * copy migration (run by `akm-migrate-storage`). 0.9.0 removed the `vault`
 * asset type entirely, and the indexer now unconditionally SKIPS `vaults/`
 * (see `shouldIndexStashFile` in `metadata.ts`). A user who upgrades straight
 * to 0.9.0 without ever running the storage migration therefore has the `.env`
 * data in their `vaults/` directory silently dropped from the index — it was
 * never copied to `env/`, and `vaults/` is no longer scanned.
 *
 * This guard detects exactly that state on a stash and emits ONE clear warning
 * pointing at `akm-migrate-storage`. It is:
 *   - Non-destructive: it never reads `.env` contents, never writes, never
 *     deletes, and never moves anything. It only stats directory entries.
 *   - Idempotent: the warning is emitted at most once per process per stash
 *     directory (deduped in-memory).
 *
 * It deliberately does NOT auto-run the copy: filesystem mutation + chmod of
 * secret material stays in the dedicated `akm-migrate-storage` bin, behind the
 * user's explicit invocation, never as a side effect of a normal `akm` command.
 */

import fs from "node:fs";
import path from "node:path";
import { warn } from "../core/warn";

/**
 * Marker filename the `vaults/` → `env/` migration drops inside `vaults/` after
 * a successful copy. Single source of truth shared with
 * `scripts/migrate-storage.ts` (which writes it) and this guard (which reads
 * it). Its presence means the data already lives under `env/` (or was a no-op
 * fresh install).
 */
export const MIGRATED_MARKER = ".migrated";

/** Stashes already warned about in this process — keyed by absolute stash dir. */
const warnedStashDirs = new Set<string>();

/** True when `dir` contains at least one `*.env` / `.env` file (recursively). */
function hasEnvFilesRecursive(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasEnvFilesRecursive(full)) return true;
    } else if (entry.name === ".env" || entry.name.endsWith(".env")) {
      return true;
    }
  }
  return false;
}

/**
 * Warn (once) when `<stashDir>/vaults/` holds `.env` data that was never
 * migrated to `env/`. No-op when there is no `vaults/` dir, when the
 * `vaults/.migrated` marker is present, or when `vaults/` has no `.env` files.
 *
 * @returns `true` when a warning was emitted, `false` otherwise. The return is
 *   primarily for tests; callers can ignore it.
 */
export function warnOnUnmigratedVaults(stashDir: string): boolean {
  const resolved = path.resolve(stashDir);
  if (warnedStashDirs.has(resolved)) return false;

  const vaultsDir = path.join(resolved, "vaults");
  if (!fs.existsSync(vaultsDir)) return false;

  // The migration writes this marker after a successful copy. Its presence
  // means the data already lives under env/ (or was a no-op fresh install).
  if (fs.existsSync(path.join(vaultsDir, MIGRATED_MARKER))) return false;

  if (!hasEnvFilesRecursive(vaultsDir)) return false;

  // Mark before emitting so a throw in `warn` can't cause a re-warn loop.
  warnedStashDirs.add(resolved);

  warn(
    `[akm] WARNING: found un-migrated secrets in ${vaultsDir}.\n` +
      `  The 'vault' asset type was removed in 0.9.0 and 'vaults/' is no longer indexed,\n` +
      `  so this data will NOT appear under 'env:' until you migrate it. Run:\n` +
      `      akm-migrate-storage --yes\n` +
      `  This copies 'vaults/' -> 'env/' (non-destructive — your 'vaults/' dir is left intact).\n` +
      `  See docs/migration/v0.8-to-v0.9.md.`,
  );
  return true;
}

/** Test-only: clear the per-process dedup set. */
export function _resetUnmigratedVaultsGuardForTests(): void {
  warnedStashDirs.clear();
}
