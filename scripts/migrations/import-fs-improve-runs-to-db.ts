#!/usr/bin/env bun
/**
 * One-shot, idempotent backfill that copies every legacy filesystem
 * improve-run into the `improve_runs` table of state.db, then archives
 * the filesystem layout out of the way.
 *
 * Why this exists
 * ===============
 * Through 0.7.x, `akm improve` wrote its result envelope to
 * `<stash>/.akm/runs/<run-id>/improve-result.json` and the
 * `scripts/improve-stats/` helpers read from there. 0.8.0 moved the
 * authoritative store into the `improve_runs` row of state.db while
 * leaving the legacy directories untouched, so a window of runs ends
 * up split between the two storages. This script lifts the legacy
 * directories into the DB so every metric is queryable from one place.
 *
 * What it does
 * ============
 *   1. Walks `<stash>/.akm/runs/*` (using --stash or AKM_STASH_DIR).
 *   2. For each `<run-id>/improve-result.json`:
 *      - Parses the directory name into an ISO started_at.
 *      - Reads the envelope and derives metrics via
 *        `computeImproveRunMetrics()` — exactly what live runs do.
 *      - `INSERT OR IGNORE` so re-runs are safe; rows that exist in
 *        the DB (notably any with the same run-id from a live write)
 *        win.
 *   3. After a successful import (or --dry-run), optionally archives
 *      `<stash>/.akm/runs/` → `<stash>/.akm/runs.archived-<ts>/` so
 *      readers stop seeing two sources of truth. Use --no-archive to
 *      leave the directory in place; use --dry-run to do nothing
 *      destructive.
 *
 * Run id ↔ timestamp
 * ==================
 * Legacy ids look like `2026-05-24T00-08-34-757Z-<sha>`. We split on
 * "Z-" once, then turn the date half back into a proper ISO string by
 * replacing the time hyphens with colons and the milliseconds hyphen
 * with a dot. `completed_at` falls back to `started_at` when the
 * envelope does not carry an explicit completion time — coarse, but
 * preserves ordering for `runs-list` etc.
 */

import fs from "node:fs";
import path from "node:path";
import { computeImproveRunMetrics, openStateDatabase, recordImproveRun } from "../../src/core/state-db";
import type { AkmImproveResult } from "../../src/commands/improve";

type Args = {
  stashDir: string;
  dryRun: boolean;
  archive: boolean;
};

function parseArgs(argv: string[]): Args {
  const stashFromEnv = process.env.AKM_STASH_DIR;
  const out: Args = {
    stashDir: stashFromEnv ?? path.join(process.env.HOME ?? "", "akm"),
    dryRun: false,
    archive: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--stash":
        out.stashDir = next();
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--no-archive":
        out.archive = false;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`import-fs-improve-runs-to-db — backfill legacy on-disk improve runs into state.db

Usage:
  bun scripts/migrations/import-fs-improve-runs-to-db.ts [options]

Options:
  --stash <path>   Stash root (default: $AKM_STASH_DIR or ~/akm).
  --dry-run        Parse + report only; no DB writes, no archive.
  --no-archive     Import only; leave <stash>/.akm/runs/ in place.
  -h, --help       Show this message.
`);
}

function parseRunIdToIsoTimestamp(runId: string): string | undefined {
  // 2026-05-24T00-08-34-757Z-dc59b9df
  //   date     time   ms suffix
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/);
  if (!m) return undefined;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

function inferScope(envelope: Partial<AkmImproveResult>): {
  scopeMode: "all" | "type" | "ref";
  scopeValue: string | null;
} {
  const scope = envelope.scope as { mode?: string; value?: string } | undefined;
  const mode = scope?.mode === "type" || scope?.mode === "ref" ? scope.mode : "all";
  return { scopeMode: mode, scopeValue: scope?.value ?? null };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runsRoot = path.join(args.stashDir, ".akm", "runs");

  if (!fs.existsSync(runsRoot)) {
    console.log(`[import] no legacy runs directory at ${runsRoot}; nothing to do`);
    return;
  }

  const entries = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    console.log(`[import] ${runsRoot} is empty; nothing to do`);
    return;
  }

  console.log(`[import] scanning ${entries.length} directories under ${runsRoot}`);

  const db = args.dryRun ? undefined : openStateDatabase();
  const existing = db
    ? new Set<string>(
        (db.prepare("SELECT id FROM improve_runs").all() as { id: string }[]).map((r) => r.id),
      )
    : new Set<string>();

  let imported = 0;
  let skippedExisting = 0;
  let skippedNoResult = 0;
  let skippedParseFailed = 0;
  let skippedNoTimestamp = 0;

  for (const id of entries) {
    const resultPath = path.join(runsRoot, id, "improve-result.json");
    if (!fs.existsSync(resultPath)) {
      skippedNoResult++;
      continue;
    }

    if (existing.has(id)) {
      skippedExisting++;
      continue;
    }

    let envelope: Partial<AkmImproveResult> & { schemaVersion?: number };
    try {
      envelope = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch (err) {
      console.warn(`[import] skipping ${id}: parse failed (${err instanceof Error ? err.message : String(err)})`);
      skippedParseFailed++;
      continue;
    }

    const startedAt = parseRunIdToIsoTimestamp(id);
    if (!startedAt) {
      console.warn(`[import] skipping ${id}: run-id does not match expected timestamp shape`);
      skippedNoTimestamp++;
      continue;
    }

    const { scopeMode, scopeValue } = inferScope(envelope);
    const ok = envelope.ok !== false;
    const result = envelope as AkmImproveResult;

    if (args.dryRun) {
      imported++;
      continue;
    }

    try {
      recordImproveRun(db!, {
        id,
        startedAt,
        completedAt: startedAt,
        stashDir: args.stashDir,
        dryRun: envelope.dryRun === true,
        profile: null,
        scopeMode,
        scopeValue,
        guidance: typeof envelope.guidance === "string" ? envelope.guidance : null,
        ok,
        result,
        metrics: computeImproveRunMetrics(result),
        metadata: { importedFrom: resultPath, importedAt: new Date().toISOString() },
      });
      imported++;
    } catch (err) {
      // The PRIMARY KEY constraint catches any rows the pre-scan missed
      // (e.g. concurrent writes). Treat as "already present".
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        skippedExisting++;
        continue;
      }
      console.error(`[import] failed to insert ${id}: ${msg}`);
      throw err;
    }
  }

  console.log(`[import] imported:        ${imported}`);
  console.log(`[import] skipped (in DB): ${skippedExisting}`);
  console.log(`[import] skipped (no improve-result.json): ${skippedNoResult}`);
  console.log(`[import] skipped (parse failed):           ${skippedParseFailed}`);
  console.log(`[import] skipped (no timestamp in run-id): ${skippedNoTimestamp}`);

  db?.close();

  if (args.dryRun) {
    console.log(`[import] dry-run: no DB writes, no archive`);
    return;
  }

  if (!args.archive) {
    console.log(`[import] --no-archive: leaving ${runsRoot} in place`);
    return;
  }

  if (skippedParseFailed > 0 || skippedNoTimestamp > 0) {
    console.log(
      `[import] refusing to archive: ${skippedParseFailed + skippedNoTimestamp} directory(ies) did not import cleanly; resolve them or rerun with --no-archive`,
    );
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveTarget = path.join(args.stashDir, ".akm", `runs.archived-${ts}`);
  fs.renameSync(runsRoot, archiveTarget);
  console.log(`[import] archived ${runsRoot} → ${archiveTarget}`);
}

main().catch((err) => {
  console.error(`[import] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
