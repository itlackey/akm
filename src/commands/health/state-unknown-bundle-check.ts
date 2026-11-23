// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `state-unknown-bundle` for `akm doctor`: proposals, improve runs or improve-ledger rows filed under a bundle id no
 * configured bundle has. State follows a bundle by its name (§0.2 P8), so renaming a bundle by hand in config leaves
 * the rows under the old name; they come back when a bundle with that name is configured again (or, for a directory
 * that was never configured, when it is used again). `akm bundle rename` carries them, which is why it is the way to
 * rename. The columns checked are the state ones of `src/storage/bundle-id-columns.ts`.
 */

import { bundleAtDir } from "../../core/bundle-id";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { withReadonlyStateDb } from "../../core/state-db";
import { STATE_BUNDLE_ID_COLUMNS } from "../../storage/bundle-id-columns";
import type { HealthCheckResult } from "./types";

interface UnknownBundleRows {
  id: string;
  /** Row counts by table. */
  rows: Record<string, number>;
}

/** The bundle ids the working directory and the config give: what a command run now files state under. */
function knownBundleIds(config: AkmConfig): Set<string> {
  const known = new Set(Object.keys(config.bundles ?? {}));
  try {
    known.add(bundleAtDir(config, resolveStashDir()));
  } catch {
    // No working directory: only the configured bundles are known.
  }
  return known;
}

/** Silent (undefined) when every row names a known bundle, when there is no state.db to read, and when the config cannot be read (`bundle-adapters` says that). */
export function collectStateUnknownBundleCheck(
  readConfig: () => AkmConfig = loadConfig,
): HealthCheckResult | undefined {
  let known: Set<string>;
  try {
    known = knownBundleIds(readConfig());
  } catch {
    return undefined;
  }
  const byId = new Map<string, UnknownBundleRows>();
  withReadonlyStateDb((db) => {
    for (const { table, column } of STATE_BUNDLE_ID_COLUMNS) {
      const counted = db
        .prepare(`SELECT ${column} AS id, COUNT(*) AS n FROM ${table} GROUP BY ${column} ORDER BY ${column}`)
        .all() as Array<{ id: string; n: number }>;
      for (const { id, n } of counted) {
        if (known.has(id)) continue;
        const entry = byId.get(id) ?? { id, rows: {} };
        entry.rows[table] = n;
        byId.set(id, entry);
      }
    }
  }, undefined);
  if (byId.size === 0) return undefined;
  const bundles = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const describe = ({ id, rows }: UnknownBundleRows) =>
    `"${id}" (${Object.entries(rows)
      .map(([table, n]) => `${n} in ${table}`)
      .join(", ")})`;
  return {
    name: "state-unknown-bundle",
    kind: "deterministic",
    confidence: "high",
    // Information, not a finding: `akm doctor` exited 0 for such state before this check existed (§0.2 N10 sets no severity).
    status: "pass",
    message:
      `state.db holds rows for ${bundles.length === 1 ? "a bundle" : "bundles"} that no configured bundle is called: ${bundles.map(describe).join("; ")}. ` +
      "They stay as they are and reattach when a bundle with that name is configured again. Rename a bundle with `akm bundle rename <old> <new>`, which carries them; a name changed by hand in config leaves them behind.",
    evidence: { bundles: bundles.map(({ id, rows }) => ({ id, rows })) },
  };
}
