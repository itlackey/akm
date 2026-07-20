// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * The one-time three-DB cutover DATA step (akm 0.9.0 Chunk 8, WI-8.2;
 * plan §3.2/§3.3/§8, normative §11.4, `docs/design/execution/chunk-8/
 * cutover-design.md`). Migration `020-three-db-cutover` is the pure additive
 * DDL (`CREATE TABLE IF NOT EXISTS` the merge-target tables); THIS module is the
 * code that MOVES the durable rows into place, exactly once, under the
 * migrate-apply fail-closed gate (`src/cli/config-migrate.ts` `cutover-applied`
 * phase). It never runs as a sealed SQL migration body — the ATTACH path is
 * runtime-resolved and the old-ref → item_ref map is filesystem/index-derived.
 *
 * ## Frozen-resolver rule (plan §3.3 item 2)
 *
 * Old-ref resolution NEVER runs through new-layout code. This module therefore
 * imports ONLY the frozen legacy surface (`./legacy-layout`), the stored-ref
 * grammar (`../legacy-ref-grammar`), storage-engine helpers (`openDatabase`,
 * `applyStandardPragmas`), core path/warn leaves, and Node builtins. It imports
 * NOTHING from `src/indexer/` or `src/workflows/`: the last-good-index join
 * reads the ATTACHED old index.db by raw SQL, never through indexer code, and
 * the workflow merge reads the ATTACHED old workflow.db by raw SQL.
 *
 * ## Design choices where the design is silent (documented per the WI brief)
 *
 *  - **ATTACH is read-write, safety enforced by construction.** `cutover-design`
 *    calls for read-only ATTACH; to stay driver-portable (bun:sqlite has no
 *    URI-mode guarantee) we ATTACH normally but (a) pre-check `fs.existsSync`
 *    before every ATTACH so a missing file is never silently CREATED, and (b)
 *    only ever `SELECT` from the attached schemas — the sole writes target
 *    `main` (state.db). This is behaviourally equivalent to a read-only ATTACH.
 *  - **Column-intersection copy.** The workflow / usage_events merge copies the
 *    INTERSECTION of columns present in both the source and the target table, so
 *    a source DB at any pre-cutover shape (or a partially-migrated test fixture)
 *    copies verbatim what it holds without tripping "no such column".
 *  - **Durable idempotency marker.** The merge writes a singleton row into
 *    `akm_cutover_ledger` INSIDE the same transaction as the data move, so a
 *    crash after COMMIT (but before the journal advances, or the workflow.db
 *    unlink) never re-runs the INSERT…SELECT (which would duplicate rows). The
 *    boundary ops (index quarantine, workflow.db unlink) key on that committed
 *    marker and are idempotent.
 *  - **Ref-map source (b) — the frozen legacy-layout walk — is best-effort.**
 *    It only ADDS mappings for on-disk assets the index no longer holds, using
 *    the source's `registryId` (or a local basename slug) as the bundle. The
 *    primary correctness path is source (a): the last-good index join, which
 *    reads the durable `item_ref` directly.
 */

import fs from "node:fs";
import path from "node:path";
import { warn } from "../../core/warn";
import { type Database, openDatabase, type SqlValue } from "../../storage/database";
import { applyStandardPragmas } from "../../storage/sqlite-pragmas";
import { classifyRefGrammar, parseStoredRef } from "../legacy-ref-grammar";
import { deriveCanonicalAssetName, TYPE_DIRS } from "./legacy-layout";

// ═══════════════════════════════════════════════════════════════════════
// Errors + report shapes
// ═══════════════════════════════════════════════════════════════════════

/**
 * A re-key INTEGRITY failure (unparseable stored ref, or a post-pass row-count
 * mismatch). Distinct from an EXPECTED orphan (old ref → no live item), which is
 * quarantined and never aborts the cutover. The apply flow converts this typed
 * error into a fail-closed restore.
 */
export class CutoverIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverIntegrityError";
  }
}

/** Per-table counts from a re-key pass (for logging + test assertions). */
export interface CutoverRekeyReport {
  /** Distinct old refs re-keyed onto their new item_ref, per table. */
  readonly rekeyed: Record<string, number>;
  /** Distinct old refs quarantined to `legacy_state` (expected orphans), per table. */
  readonly quarantined: Record<string, number>;
  /** Scalar-table collisions collapsed by most-recently-updated-wins, per table. */
  readonly merged: Record<string, number>;
  /** Tables/columns skipped because they do not exist on an older DB. */
  readonly skipped: string[];
}

export interface RunThreeDbCutoverResult {
  /** False when the merge was skipped because the committed marker was already present. */
  readonly merged: boolean;
  /** True when workflow.db was absent, so the merge arm was skipped (fresh install). */
  readonly workflowMissing: boolean;
  /** Rows copied per workflow/usage table. */
  readonly copied: Record<string, number>;
  /** The state re-key report (undefined when the marker short-circuited the run). */
  readonly rekey?: CutoverRekeyReport;
}

// ═══════════════════════════════════════════════════════════════════════
// Old-ref → item_ref map
// ═══════════════════════════════════════════════════════════════════════

/** A configured stash source root the ref map consults for origin aliases + the source (b) walk. */
export interface CutoverStashRoot {
  path: string;
  registryId?: string;
  /** True for the workspace-primary stash (bare / `stash` / `local` origins resolve here). */
  primary?: boolean;
}

export interface BuildCutoverRefMapOptions {
  /** Path to the pre-cutover index.db (the last-good index — may be absent). */
  oldIndexDbPath: string;
  /** Configured stash roots (from config sources); the first primary owns the bare/stash/local origins. */
  stashRoots?: readonly CutoverStashRoot[];
  /** Where the computed map is persisted as JSON (next to the ApplyJournal), fsynced. */
  mapOutputPath: string;
}

const CUTOVER_REFMAP_FORMAT = 1 as const;

/**
 * Compute the old-ref → new item_ref map BEFORE any re-layout, and persist it as
 * JSON (fsynced) next to the ApplyJournal. Sources, in precedence order:
 *
 *   (a) last-good index join — `entries.entry_key` / `item_ref`, generalizing
 *       the F4c `classifyLegacyRefForRekey` origin rules to a full-table pass.
 *   (b) frozen legacy-layout walk of the configured stash roots, for on-disk
 *       refs the index no longer holds (best-effort — source (a) wins).
 */
export function buildCutoverRefMap(opts: BuildCutoverRefMapOptions): Map<string, string> {
  const map = new Map<string, string>();

  // ── Source (a): the last-good index join (authoritative). ──
  if (fs.existsSync(opts.oldIndexDbPath)) {
    const db = openDatabase(opts.oldIndexDbPath, { readonly: true });
    try {
      if (tableExists(db, "main", "entries")) {
        const rows = db
          .prepare(
            "SELECT entry_key AS entryKey, item_ref AS itemRef, entry_type AS entryType, stash_dir AS stashDir " +
              "FROM entries WHERE item_ref IS NOT NULL AND item_ref <> ''",
          )
          .all() as Array<{ entryKey: string; itemRef: string; entryType: string | null; stashDir: string | null }>;
        for (const row of rows) addIndexEntryMappings(map, row, opts.stashRoots);
      }
    } finally {
      db.close();
    }
  }

  // ── Source (b): the frozen legacy-layout walk (completeness for stale-index refs). ──
  for (const root of opts.stashRoots ?? []) walkLegacyLayoutInto(map, root);

  persistRefMapJson(opts.mapOutputPath, map);
  return map;
}

/** First-wins insertion: an old spelling that already maps to a different item_ref keeps its first target. */
function setMapping(map: Map<string, string>, oldRef: string, itemRef: string): void {
  if (!map.has(oldRef)) map.set(oldRef, itemRef);
}

function addIndexEntryMappings(
  map: Map<string, string>,
  row: { entryKey: string; itemRef: string; stashDir: string | null },
  stashRoots: readonly CutoverStashRoot[] | undefined,
): void {
  const bareTail = row.entryKey.includes("//")
    ? row.entryKey.slice(row.entryKey.indexOf("//") + 2)
    : row.entryKey; // `type:name`
  const bundle = row.itemRef.includes("//") ? row.itemRef.slice(0, row.itemRef.indexOf("//")) : undefined;

  const matched = stashRoots?.find((r) => samePath(r.path, row.stashDir));
  // No stash-root info (or an unrecognized root) → treat as the primary source,
  // so single-source installs (and the test fixtures) always get bare keys.
  const isPrimary = matched ? matched.primary === true || stashRoots?.[0] === matched : true;

  if (isPrimary) {
    setMapping(map, bareTail, row.itemRef); // bare `type:name` resolves to the default/primary
    setMapping(map, `stash//${bareTail}`, row.itemRef);
    setMapping(map, `local//${bareTail}`, row.itemRef);
  }
  if (bundle) setMapping(map, `${bundle}//${bareTail}`, row.itemRef);
  if (matched?.registryId) setMapping(map, `${matched.registryId}//${bareTail}`, row.itemRef);
  setMapping(map, row.entryKey, row.itemRef); // the literal stored key
}

/**
 * Best-effort source (b): walk a configured stash root's `TYPE_DIRS` with the
 * frozen resolver and add a mapping for each on-disk asset the index map does
 * not already cover. The bundle is the source's `registryId`, or a basename slug
 * for the primary (matching how the index mints the primary bundle id).
 */
function walkLegacyLayoutInto(map: Map<string, string>, root: CutoverStashRoot): void {
  let bundle: string;
  if (root.registryId && root.registryId.length > 0) bundle = root.registryId;
  else if (root.primary) bundle = basenameSlug(root.path);
  else return; // non-primary source with no registryId — cannot form a stable bundle here
  for (const [type, dirName] of Object.entries(TYPE_DIRS)) {
    const typeRoot = path.join(root.path, dirName);
    let files: string[];
    try {
      files = listFilesRecursive(typeRoot);
    } catch {
      continue; // dir absent / unreadable
    }
    for (const filePath of files) {
      const name = safeDerive(type, typeRoot, filePath);
      if (name === undefined) continue;
      const bareTail = `${type}:${name}`;
      if (map.has(bareTail)) continue; // source (a) already covers it
      const conceptId = `${dirName}/${name}`;
      const itemRef = `${bundle}//${conceptId}`;
      setMapping(map, bareTail, itemRef);
      if (root.primary) {
        setMapping(map, `stash//${bareTail}`, itemRef);
        setMapping(map, `local//${bareTail}`, itemRef);
      }
      if (root.registryId) setMapping(map, `${root.registryId}//${bareTail}`, itemRef);
    }
  }
}

function safeDerive(type: string, typeRoot: string, filePath: string): string | undefined {
  try {
    return deriveCanonicalAssetName(type, typeRoot, filePath);
  } catch {
    return undefined;
  }
}

/** Basename slug matching the index's `slugForPath` primary-bundle derivation (reimplemented, not imported). */
function basenameSlug(sourcePath: string): string {
  const base = path
    .basename(path.resolve(sourcePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "bundle";
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

function samePath(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  return path.resolve(a) === path.resolve(b);
}

function persistRefMapJson(outputPath: string, map: Map<string, string>): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const payload = {
    formatVersion: CUTOVER_REFMAP_FORMAT,
    entries: Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  const tmp = `${outputPath}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, outputPath);
  try {
    const dirFd = fs.openSync(path.dirname(outputPath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unavailable on some filesystems.
  }
}

// ═══════════════════════════════════════════════════════════════════════
// The re-key engine (per-table policy, cutover-design.md §3)
// ═══════════════════════════════════════════════════════════════════════

/** Scalar tables (PK = ref column) — most-recently-updated wins on collision. */
const SCALAR_REKEY_TABLES: ReadonlyArray<{ table: string; keyColumn: string; tsColumn: string }> = [
  { table: "asset_salience", keyColumn: "asset_ref", tsColumn: "updated_at" },
  { table: "asset_outcome", keyColumn: "asset_ref", tsColumn: "updated_at" },
];

/** Row-carried tables — UPDATE the ref column in place, rows preserved as-is. */
const EVENT_REKEY_TABLES: ReadonlyArray<{ table: string; keyColumn: string }> = [
  { table: "events", keyColumn: "ref" },
  { table: "proposals", keyColumn: "ref" },
  { table: "task_history", keyColumn: "target_ref" },
  { table: "proposal_fingerprints", keyColumn: "ref" },
  { table: "canary_queries", keyColumn: "anchor_ref" },
];

type RefResolution =
  | { kind: "rekey"; target: string }
  | { kind: "orphan" }
  | { kind: "skip" }
  | { kind: "integrity"; reason: string };

/**
 * Classify one stored ref against the map:
 *   - in the map            → re-key to its item_ref;
 *   - already new-grammar    → skip (idempotent; already canonical);
 *   - legacy + parseable     → EXPECTED orphan (no live item) → quarantine;
 *   - legacy + unparseable   → INTEGRITY failure → fail closed.
 */
function classifyCutoverRef(ref: string, refMap: Map<string, string>): RefResolution {
  const target = refMap.get(ref);
  if (target !== undefined) return { kind: "rekey", target };
  if (classifyRefGrammar(ref) === "bundle") return { kind: "skip" };
  try {
    parseStoredRef(ref);
  } catch {
    return { kind: "integrity", reason: `unparseable stored ref "${ref}"` };
  }
  return { kind: "orphan" };
}

function emptyReport(): { rekeyed: Record<string, number>; quarantined: Record<string, number>; merged: Record<string, number>; skipped: string[] } {
  return { rekeyed: {}, quarantined: {}, merged: {}, skipped: [] };
}

function ensureLegacyStateTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_state (
      surface        TEXT NOT NULL,
      old_ref        TEXT NOT NULL,
      row_count      INTEGER NOT NULL DEFAULT 0,
      reason         TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (surface, old_ref)
    );
  `);
}

function quarantineRow(db: Database, surface: string, oldRef: string, count: number, reason: string): void {
  db.prepare(
    `INSERT INTO legacy_state (surface, old_ref, row_count, reason, quarantined_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(surface, old_ref) DO UPDATE SET row_count = excluded.row_count, reason = excluded.reason`,
  ).run(surface, oldRef, count, reason);
}

function isMissingTableOrColumn(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("no such table") || msg.includes("no such column");
}

/**
 * The re-key engine over the caller's OPEN handle, INSIDE the caller's
 * transaction. Exposed via {@link rekeyStateDb} (which opens + wraps a txn) so
 * the Chunk-0b property harness can drive it directly.
 */
export function rekeyStateDbCore(db: Database, refMap: Map<string, string>): CutoverRekeyReport {
  const report = emptyReport();
  ensureLegacyStateTable(db);
  for (const spec of SCALAR_REKEY_TABLES) rekeyScalarTable(db, spec, refMap, report);
  for (const spec of EVENT_REKEY_TABLES) rekeyEventTable(db, spec, refMap, report);
  return report;
}

/**
 * Open the state.db at `dbPath`, run the full re-key inside its own
 * transaction, and close. This is the shape the Chunk-0b `RekeyFn` harness
 * drives (`(dbPath, refMap)`); the cutover itself calls {@link rekeyStateDbCore}
 * directly inside the ATTACH transaction.
 */
export function rekeyStateDb(dbPath: string, refMap: Map<string, string>): CutoverRekeyReport {
  const db = openDatabase(dbPath);
  try {
    applyStandardPragmas(db, { dataDir: path.dirname(dbPath) });
    let report: CutoverRekeyReport = emptyReport();
    db.transaction(() => {
      report = rekeyStateDbCore(db, refMap);
    })();
    return report;
  } finally {
    db.close();
  }
}

function bump(bucket: Record<string, number>, key: string, by = 1): void {
  bucket[key] = (bucket[key] ?? 0) + by;
}

function rekeyScalarTable(
  db: Database,
  spec: { table: string; keyColumn: string; tsColumn: string },
  refMap: Map<string, string>,
  report: { rekeyed: Record<string, number>; quarantined: Record<string, number>; merged: Record<string, number>; skipped: string[] },
): void {
  let rows: Array<Record<string, SqlValue> & { __rowid: number }>;
  try {
    rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${spec.table}`).all() as Array<
      Record<string, SqlValue> & { __rowid: number }
    >;
  } catch (err) {
    if (isMissingTableOrColumn(err)) {
      report.skipped.push(spec.table);
      return;
    }
    throw err;
  }

  const groups = new Map<string, Array<Record<string, SqlValue> & { __rowid: number }>>();
  const orphans = new Map<string, number[]>(); // oldRef → rowids

  for (const row of rows) {
    const key = String(row[spec.keyColumn]);
    const resolution = classifyCutoverRef(key, refMap);
    if (resolution.kind === "integrity") throw new CutoverIntegrityError(`${spec.table}: ${resolution.reason}`);
    if (resolution.kind === "orphan") {
      const list = orphans.get(key) ?? [];
      list.push(row.__rowid);
      orphans.set(key, list);
      continue;
    }
    const target = resolution.kind === "rekey" ? resolution.target : key; // skip → itself
    const group = groups.get(target) ?? [];
    group.push(row);
    groups.set(target, group);
  }

  // Expected orphans: audit + delete.
  for (const [oldRef, rowids] of orphans) {
    quarantineRow(db, spec.table, oldRef, rowids.length, "orphan");
    for (const rowid of rowids) db.prepare(`DELETE FROM ${spec.table} WHERE rowid = ?`).run(rowid);
    bump(report.quarantined, spec.table);
  }

  // Groups: collapse each onto its canonical key (most-recently-updated wins).
  for (const [target, group] of groups) {
    if (group.length === 1 && String(group[0][spec.keyColumn]) === target) continue; // already canonical, nothing maps onto it
    const winner = group.reduce((best, candidate) => (mruWins(candidate, best, spec.tsColumn) ? candidate : best));
    for (const row of group) db.prepare(`DELETE FROM ${spec.table} WHERE rowid = ?`).run(row.__rowid);
    reinsertRow(db, spec.table, winner, spec.keyColumn, target);
    if (group.length > 1) bump(report.merged, spec.table);
    bump(report.rekeyed, spec.table);
  }
}

/** True when `candidate` should beat `best`: larger tsColumn, ties broken by larger rowid (deterministic). */
function mruWins(
  candidate: Record<string, SqlValue> & { __rowid: number },
  best: Record<string, SqlValue> & { __rowid: number },
  tsColumn: string,
): boolean {
  const ct = Number(candidate[tsColumn] ?? 0);
  const bt = Number(best[tsColumn] ?? 0);
  if (ct !== bt) return ct > bt;
  return candidate.__rowid > best.__rowid;
}

function reinsertRow(
  db: Database,
  table: string,
  winner: Record<string, SqlValue> & { __rowid: number },
  keyColumn: string,
  target: string,
): void {
  const row: Record<string, SqlValue> = {};
  for (const [col, value] of Object.entries(winner)) {
    if (col === "__rowid") continue;
    row[col] = col === keyColumn ? target : value;
  }
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(
    ...columns.map((c) => row[c]),
  );
}

function rekeyEventTable(
  db: Database,
  spec: { table: string; keyColumn: string },
  refMap: Map<string, string>,
  report: { rekeyed: Record<string, number>; quarantined: Record<string, number>; merged: Record<string, number>; skipped: string[] },
): void {
  let beforeCount: number;
  let refs: Array<{ ref: string }>;
  try {
    beforeCount = countRows(db, spec.table);
    refs = db
      .prepare(`SELECT DISTINCT ${spec.keyColumn} AS ref FROM ${spec.table} WHERE ${spec.keyColumn} IS NOT NULL`)
      .all() as Array<{ ref: string }>;
  } catch (err) {
    if (isMissingTableOrColumn(err)) {
      report.skipped.push(spec.table);
      return;
    }
    throw err;
  }

  let orphanRowsDeleted = 0;
  for (const { ref } of refs) {
    const resolution = classifyCutoverRef(ref, refMap);
    if (resolution.kind === "integrity") throw new CutoverIntegrityError(`${spec.table}: ${resolution.reason}`);
    if (resolution.kind === "skip") continue;
    if (resolution.kind === "orphan") {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${spec.keyColumn} = ?`).get(ref) as { n: number }
      ).n;
      quarantineRow(db, spec.table, ref, n, "orphan");
      db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.keyColumn} = ?`).run(ref);
      orphanRowsDeleted += n;
      bump(report.quarantined, spec.table);
      continue;
    }
    db.prepare(`UPDATE ${spec.table} SET ${spec.keyColumn} = ? WHERE ${spec.keyColumn} = ?`).run(resolution.target, ref);
    bump(report.rekeyed, spec.table);
  }

  const afterCount = countRows(db, spec.table);
  if (afterCount !== beforeCount - orphanRowsDeleted) {
    throw new CutoverIntegrityError(
      `${spec.table}: row-count mismatch after re-key (before ${beforeCount}, deleted-orphans ${orphanRowsDeleted}, after ${afterCount})`,
    );
  }
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ═══════════════════════════════════════════════════════════════════════
// The data step: workflow merge + usage_events rescue + full re-key
// ═══════════════════════════════════════════════════════════════════════

export interface RunThreeDbCutoverOptions {
  /** The old-ref → item_ref map (from {@link buildCutoverRefMap}). */
  refMap: Map<string, string>;
  /** Durable operation id — persisted in the idempotency marker. */
  operationId: string;
  statePath: string;
  workflowPath: string;
  oldIndexPath: string;
}

function ensureCutoverLedger(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS akm_cutover_ledger (
      singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT NOT NULL,
      merged_at    TEXT NOT NULL
    );
  `);
}

function cutoverAlreadyMerged(db: Database): boolean {
  ensureCutoverLedger(db);
  return !!db.prepare("SELECT 1 FROM akm_cutover_ledger WHERE singleton = 1").get();
}

/**
 * Whether the state.db has already recorded the committed cutover merge marker —
 * the durable key the boundary ops (index quarantine, workflow.db unlink) and
 * the apply-flow idempotency check consult.
 */
export function cutoverMergeCommitted(statePath: string): boolean {
  if (!fs.existsSync(statePath)) return false;
  const db = openDatabase(statePath, { readonly: true });
  try {
    if (!tableExists(db, "main", "akm_cutover_ledger")) return false;
    return !!db.prepare("SELECT 1 FROM akm_cutover_ledger WHERE singleton = 1").get();
  } finally {
    db.close();
  }
}

/**
 * The full three-DB data step (cutover-design.md §2 step 3). Opens state.db,
 * ATTACHes workflow.db + the old index.db read-only OUTSIDE any transaction,
 * then in ONE `BEGIN IMMEDIATE`: INSERT…SELECTs the three workflow tables, the
 * usage_events rescue (residual legacy `entry_ref` re-keyed via the map), and
 * the old index.db `legacy_state` carry, then the FULL state re-key
 * ({@link rekeyStateDbCore}), then writes the idempotency marker, COMMITs, and
 * DETACHes. Idempotent: a committed marker short-circuits the whole run.
 *
 * Throws {@link CutoverIntegrityError} on an integrity failure (the apply flow
 * converts it into a fail-closed restore). A missing workflow.db skips the merge
 * arm (never ATTACHes it — ATTACH would CREATE the file).
 */
export function runThreeDbCutover(opts: RunThreeDbCutoverOptions): RunThreeDbCutoverResult {
  const copied: Record<string, number> = {};
  const db = openDatabase(opts.statePath);
  try {
    applyStandardPragmas(db, { dataDir: path.dirname(opts.statePath) });

    if (cutoverAlreadyMerged(db)) {
      return { merged: false, workflowMissing: !fs.existsSync(opts.workflowPath), copied };
    }

    const workflowExists = fs.existsSync(opts.workflowPath);
    const oldIndexExists = fs.existsSync(opts.oldIndexPath);

    assertNoStaleAttachments(db);

    if (workflowExists) db.exec(`ATTACH DATABASE '${sqliteQuote(opts.workflowPath)}' AS wf`);
    if (oldIndexExists) db.exec(`ATTACH DATABASE '${sqliteQuote(opts.oldIndexPath)}' AS oldidx`);

    let rekey: CutoverRekeyReport = emptyReport();
    try {
      db.exec("BEGIN IMMEDIATE");
      ensureLegacyStateTable(db);
      ensureCutoverLedger(db);

      if (workflowExists) {
        // Parent-first for the ON DELETE CASCADE foreign keys.
        copied.workflow_runs = copyTable(db, "wf", "workflow_runs");
        copied.workflow_run_steps = copyTable(db, "wf", "workflow_run_steps");
        copied.workflow_run_units = copyTable(db, "wf", "workflow_run_units");
      }

      if (oldIndexExists) {
        copied.usage_events = rescueUsageEvents(db, opts.refMap);
        carryLegacyState(db, "oldidx");
      }

      rekey = rekeyStateDbCore(db, opts.refMap);

      db.prepare("INSERT INTO akm_cutover_ledger (singleton, operation_id, merged_at) VALUES (1, ?, datetime('now'))").run(
        opts.operationId,
      );
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
      }
      throw error;
    } finally {
      // DETACH must happen OUTSIDE any transaction (an in-txn DETACH fails).
      if (oldIndexExists) safeDetach(db, "oldidx");
      if (workflowExists) safeDetach(db, "wf");
    }

    return { merged: true, workflowMissing: !workflowExists, copied, rekey };
  } finally {
    db.close();
  }
}

function assertNoStaleAttachments(db: Database): void {
  const attached = (db.prepare("PRAGMA database_list").all() as Array<{ name: string }>).map((r) => r.name);
  const stale = attached.filter((name) => name === "wf" || name === "oldidx");
  if (stale.length > 0) {
    for (const name of stale) safeDetach(db, name);
  }
}

function safeDetach(db: Database, schema: string): void {
  try {
    db.exec(`DETACH DATABASE ${schema}`);
  } catch {
    // Already detached / never attached.
  }
}

/** Copy the INTERSECTION of columns from an attached-schema table into the matching `main` table. */
function copyTable(db: Database, srcSchema: string, table: string): number {
  if (!tableExists(db, srcSchema, table)) return 0;
  const srcCols = new Set(columnNames(db, srcSchema, table));
  const common = columnNames(db, "main", table).filter((c) => srcCols.has(c));
  if (common.length === 0) return 0;
  const colList = common.join(", ");
  db.exec(`INSERT INTO main.${table} (${colList}) SELECT ${colList} FROM ${srcSchema}.${table}`);
  return countRows(db, table);
}

/**
 * Rescue the durable index.db `usage_events` history into state.db. Copies the
 * column intersection (fresh AUTOINCREMENT ids are fine — `entry_id` is an
 * index-generation-scoped provenance column the relink pass re-derives), then
 * re-keys residual legacy `entry_ref`s via the map. Rows already in
 * `bundle//conceptId` grammar are carried as-is; unmapped legacy rows are KEPT
 * in place (append-only history) and recorded in `legacy_state`.
 */
function rescueUsageEvents(db: Database, refMap: Map<string, string>): number {
  if (!tableExists(db, "oldidx", "usage_events")) return 0;
  const srcCols = new Set(columnNames(db, "oldidx", "usage_events"));
  // Never carry the source rowid/id — let state.db mint fresh AUTOINCREMENT ids.
  const common = columnNames(db, "main", "usage_events").filter((c) => c !== "id" && srcCols.has(c));
  if (common.length > 0) {
    const colList = common.join(", ");
    db.exec(`INSERT INTO main.usage_events (${colList}) SELECT ${colList} FROM oldidx.usage_events`);
  }

  if (!columnNames(db, "main", "usage_events").includes("entry_ref")) return countRows(db, "usage_events");

  const legacyRefs = (
    db
      .prepare("SELECT DISTINCT entry_ref AS ref FROM main.usage_events WHERE entry_ref IS NOT NULL")
      .all() as Array<{ ref: string }>
  )
    .map((r) => r.ref)
    .filter((ref) => classifyRefGrammar(ref) === "legacy");

  for (const oldRef of legacyRefs) {
    const target = refMap.get(oldRef);
    if (target !== undefined) {
      db.prepare("UPDATE main.usage_events SET entry_ref = ? WHERE entry_ref = ?").run(target, oldRef);
    } else {
      // Expected orphan — KEEP the append-only rows in place, archive for audit.
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM main.usage_events WHERE entry_ref = ?").get(oldRef) as { n: number }
      ).n;
      quarantineRow(db, "usage_events", oldRef, n, "orphan");
    }
  }
  return countRows(db, "usage_events");
}

/** Carry the old index.db `legacy_state` quarantine rows into state.db (durable re-home). */
function carryLegacyState(db: Database, srcSchema: string): void {
  if (!tableExists(db, srcSchema, "legacy_state")) return;
  const srcCols = new Set(columnNames(db, srcSchema, "legacy_state"));
  const common = ["surface", "old_ref", "row_count", "reason", "quarantined_at"].filter((c) => srcCols.has(c));
  if (!common.includes("surface") || !common.includes("old_ref")) return;
  const colList = common.join(", ");
  db.exec(
    `INSERT OR IGNORE INTO main.legacy_state (${colList}) SELECT ${colList} FROM ${srcSchema}.legacy_state`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Index/workflow boundary steps (AFTER the committed state txn)
// ═══════════════════════════════════════════════════════════════════════

const DB_SIDECARS = ["-wal", "-shm"] as const;

/**
 * Journaled rename of the old index.db (+ `-wal`/`-shm`) to
 * `index.db.pre-cutover-<runId>`. Runs AFTER the state txn commits, OUTSIDE the
 * fail-closed gate — the next index run rebuilds from scratch (a rebuild failure
 * never rolls back the committed cutover). Idempotent + best-effort: a failure
 * is logged, never thrown.
 */
export function quarantineIndexDb(runId: string, indexPath: string): { quarantined: boolean; target?: string } {
  try {
    if (!fs.existsSync(indexPath)) return { quarantined: false };
    const target = `${indexPath}.pre-cutover-${runId}`;
    if (fs.existsSync(target)) return { quarantined: true, target }; // already quarantined (resume)
    fs.renameSync(indexPath, target);
    for (const suffix of DB_SIDECARS) {
      const src = `${indexPath}${suffix}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${target}${suffix}`);
    }
    return { quarantined: true, target };
  } catch (error) {
    warn(
      `[akm] three-DB cutover: index.db quarantine rename failed (${error instanceof Error ? error.message : String(error)}); the next \`akm index\` rebuilds it — the committed state cutover is unaffected.`,
    );
    return { quarantined: false };
  }
}

/**
 * Journaled, idempotent unlink of workflow.db + its `-wal`/`-shm` sidecars, keyed
 * on the committed cutover marker (the caller passes it only once the merge has
 * committed). Best-effort: a failure is logged, never thrown.
 */
export function deleteWorkflowDb(workflowPath: string): { deleted: boolean } {
  let deleted = false;
  try {
    for (const suffix of ["", ...DB_SIDECARS]) {
      const target = `${workflowPath}${suffix}`;
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        if (suffix === "") deleted = true;
      }
    }
  } catch (error) {
    warn(
      `[akm] three-DB cutover: workflow.db unlink failed (${error instanceof Error ? error.message : String(error)}); it is retried on the next migrate apply.`,
    );
  }
  return { deleted };
}

// ═══════════════════════════════════════════════════════════════════════
// Small SQL helpers
// ═══════════════════════════════════════════════════════════════════════

function tableExists(db: Database, schema: string, table: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

function columnNames(db: Database, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

/** Escape single quotes for an inline SQLite string literal (paths only — never user ref data). */
function sqliteQuote(value: string): string {
  return value.replace(/'/g, "''");
}
