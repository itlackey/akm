#!/usr/bin/env bun
/**
 * v16 → v17 migration helper.
 *
 * The v17 schema bump was a purely additive column change: `entries` gained a
 * nullable `derived_from TEXT` column. Historically (pre-0.9) a DB_VERSION
 * mismatch triggered a destructive drop-and-rebuild of the whole index; this
 * one-time helper existed to scavenge `usage_events` from a pre-upgrade backup.
 * That destructive path has since been removed — `index.db` now converges
 * forward additively (`ensureDerivedFromColumn` adds the column in place), so
 * this script is retained only for historical pre-0.9 recovery.
 *
 * For v17 specifically the only table the upgrade *intentionally* preserves
 * across the rebuild is `usage_events` (it's read out, the schema is
 * recreated, and rows are projected back in by `restoreUsageEventsBackup()`).
 * Every other table is rebuilt from the stash via `akm index`.
 *
 * That said, this helper exists as the canonical TEMPLATE for future
 * migrations where the upgrade *did* destroy something. The skeleton it
 * demonstrates is:
 *
 *   1. Open the backup DB read-only.
 *   2. Open the target DB writable.
 *   3. For each table you want to reconcile, stream rows from the backup,
 *      look up by a stable key in the target, and insert only if absent.
 *   4. Emit a JSON summary on stdout.
 *
 * For v16→v17 we reconcile `usage_events` — the `restoreUsageEventsBackup()`
 * codepath should already have preserved everything during the upgrade, but
 * running this script after the fact is a belt-and-braces check that nothing
 * fell through (e.g. the upgrade crashed mid-restore, or the operator
 * upgraded twice in quick succession and lost the in-memory backup buffer
 * the second time).
 *
 * Usage:
 *
 *   bun scripts/migrations/v16-to-v17.ts \
 *       --backup /path/to/backups/2026-05-19T04-59-36-pre-v17 \
 *       --target /path/to/index.db
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

interface CliArgs {
  backup: string;
  target: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--backup") {
      args.backup = argv[++i];
    } else if (token === "--target") {
      args.target = argv[++i];
    } else if (token === "--help" || token === "-h") {
      printHelpAndExit(0);
    } else if (token?.startsWith("--")) {
      // Unknown flag — print help and bail. We refuse to guess what the
      // operator meant for a destructive-adjacent script.
      console.error(`unknown flag: ${token}`);
      printHelpAndExit(2);
    }
  }
  if (!args.backup || !args.target) {
    console.error("--backup and --target are both required");
    printHelpAndExit(2);
  }
  return args as CliArgs;
}

function printHelpAndExit(code: number): never {
  console.error(
    [
      "Usage: bun scripts/migrations/v16-to-v17.ts --backup <path> --target <path>",
      "",
      "  --backup  Path to a backup directory (or backup index.db) written by",
      "            AKM before the v16→v17 upgrade.",
      "  --target  Path to the current, live index.db. Rows are inserted in",
      "            place; back this file up yourself if you want a safety net.",
      "",
      "Exit codes: 0 success, 2 usage error, 1 runtime failure.",
    ].join("\n"),
  );
  process.exit(code);
}

/**
 * Resolve the actual sqlite file path from either a backup directory or a
 * direct file path. Backup directories produced by AKM contain at minimum an
 * `index.db` at the root.
 */
function resolveDbPath(input: string, label: string): string {
  if (!fs.existsSync(input)) {
    throw new Error(`${label} path does not exist: ${input}`);
  }
  const stat = fs.statSync(input);
  if (stat.isFile()) return input;
  if (stat.isDirectory()) {
    const candidate = path.join(input, "index.db");
    if (!fs.existsSync(candidate)) {
      throw new Error(`${label} directory does not contain index.db: ${input}`);
    }
    return candidate;
  }
  throw new Error(`${label} path is neither a file nor a directory: ${input}`);
}

interface ReconcileSummary {
  rowsInspected: number;
  rowsInserted: number;
  rowsSkipped: number;
}

/**
 * Reconcile `usage_events` from `backup` into `target`.
 *
 * Stable key: (created_at, event_type, COALESCE(entry_ref,''), COALESCE(query,'')).
 * The combination is sufficiently unique that we won't double-insert real
 * events, while being tolerant of NULLs in nullable columns. We deliberately
 * do NOT use the integer `id` PK because backup and target IDs are not
 * comparable across a rebuild.
 */
function reconcileUsageEvents(backup: Database, target: Database): ReconcileSummary {
  const summary: ReconcileSummary = { rowsInspected: 0, rowsInserted: 0, rowsSkipped: 0 };

  // Verify the backup actually has this table — early backups (or alien
  // sqlite files passed by mistake) may not.
  const hasTable = backup
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'")
    .get() as { name: string } | undefined;
  if (!hasTable) {
    console.error("[v16-to-v17] backup has no usage_events table; nothing to reconcile");
    return summary;
  }

  // Project the backup onto the columns that exist in the *target* schema so
  // we don't error on dropped/added columns mid-stream.
  const targetCols = (target.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  const backupCols = (backup.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  const sharedCols = backupCols.filter((c) => targetCols.includes(c) && c !== "id");
  if (sharedCols.length === 0) {
    console.error("[v16-to-v17] backup and target usage_events share no columns; refusing to insert");
    return summary;
  }

  const selectAll = backup.prepare(`SELECT ${sharedCols.join(", ")} FROM usage_events`);
  const probe = target.prepare(
    `SELECT 1 FROM usage_events
       WHERE created_at = ?
         AND event_type = ?
         AND COALESCE(entry_ref, '') = COALESCE(?, '')
         AND COALESCE(query, '')     = COALESCE(?, '')
       LIMIT 1`,
  );
  const insert = target.prepare(
    `INSERT INTO usage_events (${sharedCols.join(", ")}) VALUES (${sharedCols.map(() => "?").join(", ")})`,
  );

  const insertTx = target.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      summary.rowsInspected += 1;
      const created = row.created_at ?? null;
      const type = row.event_type ?? null;
      const ref = row.entry_ref ?? null;
      const query = row.query ?? null;
      // If we lack a created_at OR event_type the row isn't safe to dedupe —
      // skip it rather than blindly inserting a near-duplicate.
      if (!created || !type) {
        summary.rowsSkipped += 1;
        continue;
      }
      const exists = probe.get(created, type, ref, query);
      if (exists) {
        summary.rowsSkipped += 1;
        continue;
      }
      insert.run(...sharedCols.map((c) => row[c] ?? null));
      summary.rowsInserted += 1;
    }
  });

  const rows = selectAll.all() as Record<string, unknown>[];
  insertTx(rows);
  return summary;
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const backupPath = resolveDbPath(args.backup, "--backup");
  const targetPath = resolveDbPath(args.target, "--target");

  if (path.resolve(backupPath) === path.resolve(targetPath)) {
    console.error("--backup and --target resolve to the same file; refusing to operate on a single DB");
    process.exit(2);
  }

  const start = Date.now();

  // Open the backup read-only so we cannot accidentally mutate it.
  const backup = new Database(backupPath, { readonly: true });
  const target = new Database(targetPath);

  try {
    target.exec("PRAGMA foreign_keys = ON");
    target.exec("PRAGMA busy_timeout = 5000");

    const usageSummary = reconcileUsageEvents(backup, target);

    const out = {
      from: "v16",
      to: "v17",
      tablesReconciled: ["usage_events"],
      rowsInspected: usageSummary.rowsInspected,
      rowsInserted: usageSummary.rowsInserted,
      rowsSkipped: usageSummary.rowsSkipped,
      durationMs: Date.now() - start,
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    backup.close();
    target.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
