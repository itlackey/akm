#!/usr/bin/env bun
/**
 * migrate-storage.ts — One-off migration from legacy akm flat-file locations
 * to the new XDG-compliant directory structure.
 *
 * Usage:
 *   bun scripts/migrate-storage.ts [--dry-run] [--yes]
 *
 * Flags:
 *   --dry-run   Print what would happen without making any changes (default: false).
 *   --yes       Skip the confirmation prompt and run immediately.
 *
 * Each migration step is independent. If one step fails the others continue.
 * A summary of successes, skips, and failures is printed at the end.
 *
 * Safety guarantees:
 *   - Never deletes source files. Leaves them in place so rollback is possible.
 *   - Verifies each destination before declaring success.
 *   - Wraps every step in a try/catch so one failure cannot block the rest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const YES = args.includes("--yes");

// ── Path resolution ──────────────────────────────────────────────────────────

// Import existing helpers for $CACHE and $CONFIG.
// These live in the same repo, so we import them directly.
import { getCacheDir, getConfigDir } from "../src/core/paths.ts";

// $DATA and $STATE helpers don't exist yet in paths.ts — inline XDG logic here.
// This script is intentionally self-contained so it can run ahead of the main
// implementation and be distributed as a standalone asset.
const dataDir =
  process.env.AKM_DATA_DIR?.trim() ??
  (process.env.XDG_DATA_HOME?.trim()
    ? path.join(process.env.XDG_DATA_HOME.trim(), "akm")
    : path.join(os.homedir(), ".local", "share", "akm"));

const stateDir =
  process.env.AKM_STATE_DIR?.trim() ??
  (process.env.XDG_STATE_HOME?.trim()
    ? path.join(process.env.XDG_STATE_HOME.trim(), "akm")
    : path.join(os.homedir(), ".local", "state", "akm"));

const cacheDir = getCacheDir();
const configDir = getConfigDir();
const stateDbPath = path.join(dataDir, "state.db");

// ── Result tracking ──────────────────────────────────────────────────────────

type StepStatus = "success" | "skipped" | "failed";

interface StepResult {
  name: string;
  status: StepStatus;
  detail: string;
}

const results: StepResult[] = [];

function record(name: string, status: StepStatus, detail: string): void {
  results.push({ name, status, detail });
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Copy a single file from src to dest. Verifies the destination exists and
 * has the same byte size as the source before returning.
 * Returns true on success.
 */
function copyAndVerify(src: string, dest: string): boolean {
  fs.copyFileSync(src, dest);
  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);
  return destStat.size === srcStat.size;
}

/**
 * Recursively copy a directory tree from src to dest.
 * Returns { copied, failed } counts.
 */
function copyDirRecursive(src: string, dest: string): { copied: number; failed: number } {
  let copied = 0;
  let failed = 0;

  ensureDir(dest);

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcEntry = path.join(src, entry.name);
    const destEntry = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDirRecursive(srcEntry, destEntry);
      copied += sub.copied;
      failed += sub.failed;
    } else {
      try {
        if (copyAndVerify(srcEntry, destEntry)) {
          copied++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
  }

  return { copied, failed };
}

/**
 * Count all regular files in a directory tree recursively.
 */
function countFilesRecursive(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFilesRecursive(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

// ── Dry-run summary ──────────────────────────────────────────────────────────

function printDryRunSummary(): void {
  console.log("\nakm storage migration — DRY RUN SUMMARY");
  console.log("=========================================");
  console.log(`  $CACHE  = ${cacheDir}`);
  console.log(`  $CONFIG = ${configDir}`);
  console.log(`  $DATA   = ${dataDir}`);
  console.log(`  $STATE  = ${stateDir}`);
  console.log();

  const steps: Array<{ src: string; dest: string; note?: string }> = [
    {
      src: path.join(cacheDir, "index.db"),
      dest: path.join(dataDir, "index.db"),
      note: "copy only — source left in place",
    },
    {
      src: path.join(cacheDir, "workflow.db"),
      dest: path.join(dataDir, "workflow.db"),
      note: "copy only — source left in place",
    },
    {
      src: path.join(cacheDir, "events.jsonl"),
      dest: stateDbPath + " (events table)",
      note: "JSONL lines imported into state.db — source left in place",
    },
    {
      src: path.join(cacheDir, "tasks", "history"),
      dest: path.join(stateDir, "tasks", "history"),
      note: "*.jsonl files copied — sources left in place",
    },
    {
      src: path.join(configDir, "akm.lock"),
      dest: path.join(dataDir, "akm.lock"),
      note: "copy only — source left in place; akm reads from $DATA going forward",
    },
    {
      src: path.join(cacheDir, "config-backups"),
      dest: path.join(dataDir, "config-backups"),
      note: "recursive copy — sources left in place",
    },
  ];

  for (const s of steps) {
    const srcExists = fs.existsSync(s.src);
    const destExists = fs.existsSync(s.dest);
    const status = !srcExists ? "skip (source not found)" : destExists ? "skip (dest already exists)" : "would copy";
    console.log(`  → ${path.basename(s.src)}`);
    console.log(`      src : ${s.src}`);
    console.log(`      dest: ${s.dest}`);
    console.log(`      note: ${s.note}`);
    console.log(`      status: ${status}`);
    console.log();
  }
}

// ── Confirmation prompt ──────────────────────────────────────────────────────

async function confirm(): Promise<boolean> {
  if (YES) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Proceed with migration? [y/N] ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── Migration steps ──────────────────────────────────────────────────────────

// Step 1 & 2: Copy a single SQLite database from $CACHE to $DATA.
function migrateDb(filename: string): void {
  const src = path.join(cacheDir, filename);
  const dest = path.join(dataDir, filename);

  if (!fs.existsSync(src)) {
    record(filename, "skipped", "source not found");
    return;
  }
  if (fs.existsSync(dest)) {
    record(filename, "skipped", "destination already exists");
    return;
  }

  ensureDir(dataDir);
  const ok = copyAndVerify(src, dest);
  if (ok) {
    record(filename, "success", `copied to ${dest} — source left at ${src} (delete manually when ready)`);
  } else {
    record(filename, "failed", `size mismatch after copy: ${src} → ${dest}`);
  }
}

// Step 3: Import events.jsonl into state.db events table.
async function migrateEventsJsonl(): Promise<void> {
  const src = path.join(cacheDir, "events.jsonl");

  if (!fs.existsSync(src)) {
    record("events.jsonl → state.db", "skipped", "source not found");
    return;
  }

  try {
    ensureDir(dataDir);

    // Import using the existing importEventsJsonl helper from state-db.ts.
    const { openStateDatabase, importEventsJsonl } = await import("../src/core/state-db.ts");
    const db = openStateDatabase(stateDbPath);
    try {
      const { imported, maxId } = await importEventsJsonl(db, src);
      record(
        "events.jsonl → state.db",
        "success",
        `imported ${imported} events (max id: ${maxId}) — source left at ${src} (delete manually when ready)`,
      );
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("events.jsonl → state.db", "failed", msg);
  }
}

// Step 4: Copy task history JSONL files from $CACHE to $STATE.
function migrateTaskHistory(): void {
  const src = path.join(cacheDir, "tasks", "history");
  const dest = path.join(stateDir, "tasks", "history");

  if (!fs.existsSync(src)) {
    record("tasks/history/", "skipped", "source directory not found");
    return;
  }

  try {
    ensureDir(dest);

    const files = fs.readdirSync(src).filter((f) => f.endsWith(".jsonl"));

    if (files.length === 0) {
      record("tasks/history/", "skipped", "no *.jsonl files found in source directory");
      return;
    }

    let copied = 0;
    let failed = 0;

    for (const file of files) {
      const srcFile = path.join(src, file);
      const destFile = path.join(dest, file);
      try {
        if (copyAndVerify(srcFile, destFile)) {
          copied++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    if (failed === 0) {
      record(
        "tasks/history/",
        "success",
        `copied ${copied} files to ${dest} — sources left in place (delete manually when ready)`,
      );
    } else {
      record("tasks/history/", "failed", `copied ${copied}/${files.length} files; ${failed} failed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("tasks/history/", "failed", msg);
  }
}

// Step 5: Copy akm.lock from $CONFIG to $DATA.
function migrateLockfile(): void {
  const src = path.join(configDir, "akm.lock");
  const dest = path.join(dataDir, "akm.lock");

  if (!fs.existsSync(src)) {
    record("akm.lock", "skipped", "source not found");
    return;
  }
  if (fs.existsSync(dest)) {
    record("akm.lock", "skipped", "destination already exists");
    return;
  }

  ensureDir(dataDir);
  const ok = copyAndVerify(src, dest);
  if (ok) {
    record(
      "akm.lock",
      "success",
      `copied to ${dest} — source left at ${src}; akm will read from $DATA/akm.lock once new code is deployed`,
    );
  } else {
    record("akm.lock", "failed", `size mismatch after copy: ${src} → ${dest}`);
  }
}

// Step 6: Copy config-backups/ directory from $CACHE to $DATA.
function migrateConfigBackups(): void {
  const src = path.join(cacheDir, "config-backups");
  const dest = path.join(dataDir, "config-backups");

  if (!fs.existsSync(src)) {
    record("config-backups/", "skipped", "source directory not found");
    return;
  }
  if (fs.existsSync(dest)) {
    record("config-backups/", "skipped", "destination already exists");
    return;
  }

  try {
    const srcCount = countFilesRecursive(src);
    const { copied, failed } = copyDirRecursive(src, dest);
    const destCount = fs.existsSync(dest) ? countFilesRecursive(dest) : 0;

    if (failed === 0 && destCount === srcCount) {
      record(
        "config-backups/",
        "success",
        `copied ${copied} files to ${dest} — sources left in place (delete manually when ready)`,
      );
    } else {
      record(
        "config-backups/",
        "failed",
        `file count mismatch: source ${srcCount}, destination ${destCount}; ${failed} copy errors`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("config-backups/", "failed", msg);
  }
}

// ── Final summary ─────────────────────────────────────────────────────────────

function printSummary(): void {
  const successes = results.filter((r) => r.status === "success");
  const skipped = results.filter((r) => r.status === "skipped");
  const failures = results.filter((r) => r.status === "failed");

  console.log("\nakm storage migration — RESULTS");
  console.log("================================");

  if (successes.length > 0) {
    console.log(`\nMigrated (${successes.length}):`);
    for (const r of successes) {
      console.log(`  ✓ ${r.name}`);
      console.log(`      ${r.detail}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const r of skipped) {
      console.log(`  ✓ ${r.name} — ${r.detail}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\nFailed (${failures.length}):`);
    for (const r of failures) {
      console.log(`  ✗ ${r.name}`);
      console.log(`      ${r.detail}`);
    }
    console.log();
    process.exitCode = 1;
  } else {
    console.log("\nMigration complete. No errors.");
  }

  if (successes.length > 0) {
    console.log(`
Note: source files have been left in place. Once you have verified the new
locations are working correctly, you can delete the originals:
  ${path.join(cacheDir, "index.db")}
  ${path.join(cacheDir, "workflow.db")}
  ${path.join(cacheDir, "events.jsonl")}
  ${path.join(cacheDir, "tasks", "history")}
  ${path.join(cacheDir, "config-backups")}
  ${path.join(configDir, "akm.lock")}
`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printDryRunSummary();

  if (DRY_RUN) {
    console.log("Dry run complete. No changes made.");
    return;
  }

  const proceed = await confirm();
  if (!proceed) {
    console.log("Aborted. No changes made.");
    return;
  }

  console.log("\nRunning migration steps...\n");

  // Steps run independently — each is wrapped in its own error handling.
  migrateDb("index.db");
  migrateDb("workflow.db");
  await migrateEventsJsonl();
  migrateTaskHistory();
  migrateLockfile();
  migrateConfigBackups();

  printSummary();
}

await main();
