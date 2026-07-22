// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7b -- the invariant harness for the state.db re-key merge (the
 * Chunk-8 gate substrate; anchors.md E.5 / D0b-2). Given a generated
 * before-state (`GeneratedRekeyState` from `rekey-generator.ts`) and a
 * re-key implementation under test (a `RekeyFn`), `checkRekeyInvariants`
 * copies the generated db, applies the function, and verifies all 5 REQUIRED
 * invariants (plan §12.3 / anchors.md E.5):
 *
 *   1. NO KEY LOST         -- every logical asset's canonical key exists
 *                              post-rekey in every table it had a row in.
 *   2. EVENT ROWS CARRIED   -- `events`/`proposals` rows are re-keyed but
 *      AS-IS, counts            never dropped/duplicated (compares the exact
 *      preserved                seedTag payload set, not just a count).
 *   3. MOST-RECENTLY-       -- on a scalar-table collision (both spellings
 *      UPDATED WINS            present with different `updated_at`), the
 *                               canonical row's fields match whichever
 *                               spelling had the greater `updated_at` --
 *                               STRONGER than `rekeyStateDbForMove`'s
 *                               delete-then-rename (which never compares
 *                               `updated_at` -- anchors.md E.2).
 *   4. DETERMINISTIC        -- two independent copies of the SAME generated
 *                               seed, re-keyed independently, produce
 *                               byte-identical output.
 *   5. IDEMPOTENT           -- applying the re-key a second time to its own
 *                               output changes nothing.
 *
 * The generator hard-codes NO assumption about where Chunk 8's real
 * full-table re-key function will live (it doesn't exist yet) -- `rekeyFn`
 * is a parameter, typed only by the `RekeyFn` shape in `rekey-model.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GeneratedRekeyState } from "./rekey-generator";
import {
  bareRef,
  canonicalRef,
  type LogicalAssetKey,
  qualifiedRef,
  type RawRow,
  type RekeyFn,
  type RekeyModel,
  type RekeySnapshot,
} from "./rekey-model";
import { copyStateDb, snapshotRekeyState } from "./rekey-snapshot";

export interface RekeyInvariantResult {
  readonly ok: boolean;
  readonly violations: string[];
}

/**
 * The canonical merged-key spelling every logical asset's spellings must collapse
 * onto post-rekey. Defaults to `canonicalRef` (the legacy `origin//type:name`
 * form the 0b reference impls produce). Chunk 8's REAL cutover fn re-keys onto
 * the fully-qualified `bundle//conceptId` `item_ref` instead, so it passes a
 * `keyFor` that mirrors its own map targets — the harness then checks against
 * that spelling WITHOUT any change to the reference-impl / merge-property suites,
 * which keep the default. (WI-8.2, §15.3: extend, never rewrite.)
 */
export type RekeyKeyFor = (key: LogicalAssetKey) => string;

export interface CheckRekeyInvariantsOptions {
  /** Override the canonical merged-key spelling (default {@link canonicalRef}). */
  readonly keyFor?: RekeyKeyFor;
}

/** Rows in `rows` whose `keyColumn` equals `refValue`. Ref strings are globally unique per logical asset by construction (see `rekey-generator.ts`), so exact string match is a safe per-asset filter. */
function rowsAt(rows: RawRow[], keyColumn: string, refValue: string): RawRow[] {
  return rows.filter((r) => r[keyColumn] === refValue);
}

const SCALAR_TABLES: Array<{ name: "assetSalience" | "assetOutcome"; keyColumn: "asset_ref" }> = [
  { name: "assetSalience", keyColumn: "asset_ref" },
  { name: "assetOutcome", keyColumn: "asset_ref" },
];

const EVENT_TABLES: Array<{ name: "events" | "proposals"; keyColumn: "ref" }> = [
  { name: "events", keyColumn: "ref" },
  { name: "proposals", keyColumn: "ref" },
];

const ALL_TABLES = [...SCALAR_TABLES, ...EVENT_TABLES];

// ── Invariant 1 -- no key lost ──────────────────────────────────────────────

function checkNoKeyLost(
  model: RekeyModel,
  before: RekeySnapshot,
  after: RekeySnapshot,
  violations: string[],
  keyFor: RekeyKeyFor,
): void {
  for (const asset of model.assets) {
    const bare = bareRef(asset.key);
    const qualified = qualifiedRef(asset.key);
    const canonical = keyFor(asset.key);
    for (const table of ALL_TABLES) {
      const hadBefore =
        rowsAt(before[table.name], table.keyColumn, bare).length +
        rowsAt(before[table.name], table.keyColumn, qualified).length;
      if (hadBefore === 0) continue; // this asset seeded no row at all in this table -- nothing to check
      const hasAfter = rowsAt(after[table.name], table.keyColumn, canonical).length;
      if (hasAfter === 0) {
        violations.push(
          `no-key-lost: ${table.name} lost canonical key "${canonical}" (asset had ${hadBefore} row(s) pre-rekey across its spellings)`,
        );
      }
    }
  }
}

// ── Invariant 2 -- event rows carried as-is, counts preserved ──────────────

function seedTagsOf(rows: RawRow[]): string[] {
  return rows
    .map((r) => {
      const metadataJson = typeof r.metadata_json === "string" ? r.metadata_json : "{}";
      try {
        const parsed = JSON.parse(metadataJson) as { seedTag?: unknown };
        return typeof parsed.seedTag === "string" ? parsed.seedTag : "";
      } catch {
        return "";
      }
    })
    .sort();
}

function checkEventRowsCarried(
  model: RekeyModel,
  before: RekeySnapshot,
  after: RekeySnapshot,
  violations: string[],
  keyFor: RekeyKeyFor,
): void {
  for (const asset of model.assets) {
    const bare = bareRef(asset.key);
    const qualified = qualifiedRef(asset.key);
    const canonical = keyFor(asset.key);
    for (const table of EVENT_TABLES) {
      const beforeRows = [
        ...rowsAt(before[table.name], table.keyColumn, bare),
        ...rowsAt(before[table.name], table.keyColumn, qualified),
      ];
      if (beforeRows.length === 0) continue;
      const afterRows = rowsAt(after[table.name], table.keyColumn, canonical);
      if (afterRows.length !== beforeRows.length) {
        violations.push(
          `event-rows-carried: ${table.name} asset="${canonical}" expected ${beforeRows.length} row(s) preserved, found ${afterRows.length}`,
        );
        continue;
      }
      const beforeTags = seedTagsOf(beforeRows);
      const afterTags = seedTagsOf(afterRows);
      if (JSON.stringify(beforeTags) !== JSON.stringify(afterTags)) {
        violations.push(
          `event-rows-carried: ${table.name} asset="${canonical}" row payloads changed (expected seedTags ${JSON.stringify(beforeTags)}, got ${JSON.stringify(afterTags)})`,
        );
      }
    }
  }
}

// ── Invariant 3 -- scalar fields: most-recently-updated wins ───────────────

function rowFieldsEqual(a: RawRow, b: RawRow, ignoreKeys: readonly string[]): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (ignoreKeys.includes(k)) continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function checkScalarMergeWins(
  model: RekeyModel,
  before: RekeySnapshot,
  after: RekeySnapshot,
  violations: string[],
  keyFor: RekeyKeyFor,
): void {
  for (const asset of model.assets) {
    const bare = bareRef(asset.key);
    const qualified = qualifiedRef(asset.key);
    const canonical = keyFor(asset.key);
    for (const table of SCALAR_TABLES) {
      const bareRows = rowsAt(before[table.name], table.keyColumn, bare);
      const qualifiedRows = rowsAt(before[table.name], table.keyColumn, qualified);
      if (bareRows.length === 0 && qualifiedRows.length === 0) continue;

      const canonicalRows = rowsAt(after[table.name], table.keyColumn, canonical);
      if (canonicalRows.length !== 1) {
        violations.push(
          `scalar-merge-wins: ${table.name} asset="${canonical}" expected exactly 1 row after rekey, found ${canonicalRows.length}`,
        );
        continue;
      }
      const actual = canonicalRows[0] as RawRow;

      let expected: RawRow;
      if (bareRows.length > 0 && qualifiedRows.length > 0) {
        // Collision: the merged row must carry the fields of whichever
        // pre-existing spelling had the GREATER updated_at -- the rule
        // rekeyStateDbForMove's delete-then-rename never implements.
        const bareRow = bareRows[0] as RawRow;
        const qualifiedRow = qualifiedRows[0] as RawRow;
        expected = (bareRow.updated_at as number) >= (qualifiedRow.updated_at as number) ? bareRow : qualifiedRow;
      } else {
        expected = (bareRows[0] ?? qualifiedRows[0]) as RawRow;
      }

      if (!rowFieldsEqual(actual, expected, [table.keyColumn])) {
        violations.push(
          `scalar-merge-wins: ${table.name} asset="${canonical}" canonical row's fields do not match the expected winner ` +
            `(expected updated_at=${expected.updated_at}, got updated_at=${actual.updated_at})`,
        );
      }
    }
  }
}

// ── Invariants 4 & 5 -- deterministic / idempotent ──────────────────────────

function sortRows(rows: RawRow[]): RawRow[] {
  return [...rows].sort((a, b) => {
    const ka = JSON.stringify(a);
    const kb = JSON.stringify(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function snapshotsEqual(a: RekeySnapshot, b: RekeySnapshot): boolean {
  return ALL_TABLES.every((t) => JSON.stringify(sortRows(a[t.name])) === JSON.stringify(sortRows(b[t.name])));
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Verify all 5 invariants for `rekeyFn` applied to `generated`. Leaves
 * `generated.dbPath` untouched (works on disposable copies); cleans up its
 * own temp working directory before returning.
 */
export function checkRekeyInvariants(
  generated: GeneratedRekeyState,
  rekeyFn: RekeyFn,
  options: CheckRekeyInvariantsOptions = {},
): RekeyInvariantResult {
  const keyFor = options.keyFor ?? canonicalRef;
  const violations: string[] = [];
  const before = snapshotRekeyState(generated.dbPath);

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rekey-check-"));
  try {
    const dbA = path.join(workRoot, "a", "state.db");
    const dbB = path.join(workRoot, "b", "state.db");

    copyStateDb(generated.dbPath, dbA);
    rekeyFn(dbA, generated.model);
    const afterA = snapshotRekeyState(dbA);

    checkNoKeyLost(generated.model, before, afterA, violations, keyFor);
    checkEventRowsCarried(generated.model, before, afterA, violations, keyFor);
    checkScalarMergeWins(generated.model, before, afterA, violations, keyFor);

    // Invariant 4 -- deterministic: an INDEPENDENT fresh copy of the same
    // pristine generated db, re-keyed separately, must match afterA exactly.
    copyStateDb(generated.dbPath, dbB);
    rekeyFn(dbB, generated.model);
    const afterB = snapshotRekeyState(dbB);
    if (!snapshotsEqual(afterA, afterB)) {
      violations.push(
        "deterministic: two independent re-key runs over the same generated seed produced different output",
      );
    }

    // Invariant 5 -- idempotent: applying rekeyFn AGAIN to its own output
    // (dbA, already re-keyed once) must change nothing.
    rekeyFn(dbA, generated.model);
    const afterATwice = snapshotRekeyState(dbA);
    if (!snapshotsEqual(afterA, afterATwice)) {
      violations.push(
        "idempotent: applying the re-key a second time changed output a first application already produced",
      );
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }

  return { ok: violations.length === 0, violations };
}
