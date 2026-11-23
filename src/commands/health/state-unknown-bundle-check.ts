// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `state-unknown-bundle` for `akm doctor`: proposals, improve runs or improve-ledger rows filed under a bundle name no
 * configured bundle has, or under a directory no configured bundle is at. State follows a bundle by its name (§0.2 P8),
 * and a directory no bundle has is filed under its path, so these rows are not in any configured bundle's queue.
 * They are left as they are: rows under a name come back when a bundle of that name is configured again, rows under
 * a directory when a bundle is configured at it (the next command re-files them). The check says what is known and
 * not why: a name changed in config, a bundle removed and a directory used with `AKM_BUNDLE_DIR` look the same.
 * Information, not a finding: `akm doctor` exited 0 for such state before this check existed (§0.2 N10 sets no
 * severity). The columns checked are the state ones of `src/storage/bundle-id-columns.ts`.
 */

import { bundleKeyForDir } from "../../core/bundle-at-dir";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { withReadonlyStateDb } from "../../core/state-db";
import { STATE_BUNDLE_ID_COLUMNS } from "../../storage/bundle-id-columns";
import type { HealthCheckResult } from "./types";

interface UnknownRows {
  id: string;
  /** A bundle name, or the path of a directory no configured bundle is at. */
  kind: "name" | "directory";
  /** Row counts by table. */
  rows: Record<string, number>;
}

/** The keys a command run now files state under: the configured bundles, and the working directory's own. */
function knownKeys(config: AkmConfig): Set<string> {
  const known = new Set(Object.keys(config.bundles ?? {}));
  try {
    known.add(bundleKeyForDir(config, resolveStashDir()));
  } catch {
    // No working directory: only the configured bundles are known.
  }
  return known;
}

/** Silent (undefined) when every row is filed under a known key, when there is no state.db to read, and when the config cannot be read (`bundle-adapters` says that). */
export function collectStateUnknownBundleCheck(
  readConfig: () => AkmConfig = loadConfig,
): HealthCheckResult | undefined {
  let known: Set<string>;
  try {
    known = knownKeys(readConfig());
  } catch {
    return undefined;
  }
  const byId = new Map<string, UnknownRows>();
  withReadonlyStateDb((db) => {
    for (const { table, column } of STATE_BUNDLE_ID_COLUMNS) {
      const counted = db
        .prepare(`SELECT ${column} AS id, COUNT(*) AS n FROM ${table} GROUP BY ${column} ORDER BY ${column}`)
        .all() as Array<{ id: string; n: number }>;
      for (const { id, n } of counted) {
        if (known.has(id)) continue;
        const entry = byId.get(id) ?? { id, kind: /[/\\:]/.test(id) ? "directory" : "name", rows: {} };
        entry.rows[table] = n;
        byId.set(id, entry);
      }
    }
  }, undefined);
  if (byId.size === 0) return undefined;
  const found = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const describe = ({ id, kind, rows }: UnknownRows) =>
    `${kind === "name" ? "bundle" : "directory"} "${id}" (${Object.entries(rows)
      .map(([table, n]) => `${n} in ${table}`)
      .join(", ")})`;
  return {
    name: "state-unknown-bundle",
    kind: "deterministic",
    confidence: "high",
    status: "pass",
    message:
      `state.db holds rows no configured bundle owns: ${found.map(describe).join("; ")}. ` +
      "They stay as they are. Rows under a bundle name come back when a bundle with that name is configured again, rows under a directory when a bundle is configured at it. " +
      "`akm bundle rename <old> <new>` carries a bundle's rows with it; a name changed by hand in config does not.",
    evidence: { bundles: found.map(({ id, kind, rows }) => ({ id, kind, rows })) },
  };
}
