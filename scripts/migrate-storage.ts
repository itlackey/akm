#!/usr/bin/env bun
/**
 * migrate-storage.ts — Versioned akm storage migration tool.
 *
 * Usage:
 *   bun scripts/migrate-storage.ts [--dry-run] [--yes] [--from <version>] [--list]
 *
 * Flags:
 *   --dry-run        Print what would happen without making any changes.
 *   --yes            Skip the confirmation prompt and run immediately.
 *   --from <ver>     Only run migrations whose source version is >= <ver>.
 *                    Example: `--from 0.8` skips the 0.7 → 0.8 migration.
 *   --list           Print the available migrations and exit.
 *
 * Architecture:
 *   Each migration version is an object that conforms to MigrationVersion.
 *   The MIGRATIONS array is executed in order; each `run()` is called only
 *   when its `isNeeded()` returns true. Within a version, each step is
 *   independently wrapped so one failure does not block the others.
 *
 * Safety guarantees:
 *   - Never deletes source files. Sources are left in place so rollback is
 *     possible. Some steps may rename a legacy file with a `.migrated`
 *     suffix to mark it consumed, but contents are preserved.
 *   - Verifies each destination before declaring success.
 *   - Wraps every step in a try/catch so one failure cannot block the rest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { getCacheDir, getConfigDir } from "../src/core/paths";

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const YES = args.includes("--yes");
const LIST_ONLY = args.includes("--list");

function parseFromArg(): string | null {
  const idx = args.indexOf("--from");
  if (idx === -1) return null;
  const val = args[idx + 1];
  if (!val || val.startsWith("--")) {
    console.error("Error: --from requires a version argument (e.g. --from 0.8).");
    process.exit(2);
  }
  return val;
}
const FROM_VERSION = parseFromArg();

// ── Path resolution ──────────────────────────────────────────────────────────

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
const indexDbPath = path.join(dataDir, "index.db");

export interface ResolvedPaths {
  cacheDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  stateDbPath: string;
  indexDbPath: string;
}

const PATHS: ResolvedPaths = {
  cacheDir,
  configDir,
  dataDir,
  stateDir,
  stateDbPath,
  indexDbPath,
};

// ── Result tracking ──────────────────────────────────────────────────────────

type StepStatus = "success" | "skipped" | "failed";

export interface StepResult {
  name: string;
  status: StepStatus;
  detail: string;
}

interface VersionRunReport {
  label: string;
  ran: boolean;
  skipReason?: string;
  results: StepResult[];
}

const versionReports: VersionRunReport[] = [];

// ── Utility helpers ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyAndVerify(src: string, dest: string): boolean {
  fs.copyFileSync(src, dest);
  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);
  return destStat.size === srcStat.size;
}

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

// ── Versioned migration types ────────────────────────────────────────────────

export interface MigrationContext {
  dryRun: boolean;
  recordStep: (result: StepResult) => void;
  paths: ResolvedPaths;
}

export interface MigrationVersion {
  /** Version label, e.g. "0.7 → 0.8" or "0.8 → 0.9". */
  label: string;
  /** Lower-bound version key used for --from filtering, e.g. "0.7" or "0.8". */
  sourceVersion: string;
  /** Detect whether this migration is needed. Return true only when there is work to do. */
  isNeeded: (paths: ResolvedPaths) => boolean | Promise<boolean>;
  /** Run the migration steps. Each step independently catches errors. */
  run: (ctx: MigrationContext) => Promise<void>;
}

// ── 0.7 → 0.8 step implementations ───────────────────────────────────────────

function migrateDb(ctx: MigrationContext, filename: string): void {
  const src = path.join(ctx.paths.cacheDir, filename);
  const dest = path.join(ctx.paths.dataDir, filename);

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: filename, status: "skipped", detail: "source not found" });
    return;
  }
  if (fs.existsSync(dest)) {
    ctx.recordStep({ name: filename, status: "skipped", detail: "destination already exists" });
    return;
  }

  if (ctx.dryRun) {
    ctx.recordStep({ name: filename, status: "success", detail: `[dry-run] would copy ${src} → ${dest}` });
    return;
  }

  ensureDir(ctx.paths.dataDir);
  const ok = copyAndVerify(src, dest);
  if (ok) {
    ctx.recordStep({
      name: filename,
      status: "success",
      detail: `copied to ${dest} — source left at ${src} (delete manually when ready)`,
    });
  } else {
    ctx.recordStep({ name: filename, status: "failed", detail: `size mismatch after copy: ${src} → ${dest}` });
  }
}

async function migrateEventsJsonl(ctx: MigrationContext): Promise<void> {
  const src = path.join(ctx.paths.cacheDir, "events.jsonl");

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: "events.jsonl → state.db", status: "skipped", detail: "source not found" });
    return;
  }

  if (ctx.dryRun) {
    ctx.recordStep({
      name: "events.jsonl → state.db",
      status: "success",
      detail: `[dry-run] would import ${src} into ${ctx.paths.stateDbPath}`,
    });
    return;
  }

  try {
    ensureDir(ctx.paths.dataDir);
    const { openStateDatabase, importEventsJsonl } = await import("../src/core/state-db");
    const db = openStateDatabase(ctx.paths.stateDbPath);
    try {
      const { imported, maxId } = await importEventsJsonl(db, src);
      ctx.recordStep({
        name: "events.jsonl → state.db",
        status: "success",
        detail: `imported ${imported} events (max id: ${maxId}) — source left at ${src} (delete manually when ready)`,
      });
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.recordStep({ name: "events.jsonl → state.db", status: "failed", detail: msg });
  }
}

function migrateTaskHistory(ctx: MigrationContext): void {
  const src = path.join(ctx.paths.cacheDir, "tasks", "history");
  const dest = path.join(ctx.paths.stateDir, "tasks", "history");

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: "tasks/history/", status: "skipped", detail: "source directory not found" });
    return;
  }

  try {
    const files = fs.readdirSync(src).filter((f) => f.endsWith(".jsonl"));

    if (files.length === 0) {
      ctx.recordStep({ name: "tasks/history/", status: "skipped", detail: "no *.jsonl files found in source directory" });
      return;
    }

    if (ctx.dryRun) {
      ctx.recordStep({
        name: "tasks/history/",
        status: "success",
        detail: `[dry-run] would copy ${files.length} *.jsonl file(s) from ${src} → ${dest}`,
      });
      return;
    }

    ensureDir(dest);

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
      ctx.recordStep({
        name: "tasks/history/",
        status: "success",
        detail: `copied ${copied} files to ${dest} — sources left in place (delete manually when ready)`,
      });
    } else {
      ctx.recordStep({
        name: "tasks/history/",
        status: "failed",
        detail: `copied ${copied}/${files.length} files; ${failed} failed`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.recordStep({ name: "tasks/history/", status: "failed", detail: msg });
  }
}

function migrateLockfile(ctx: MigrationContext): void {
  const src = path.join(ctx.paths.configDir, "akm.lock");
  const dest = path.join(ctx.paths.dataDir, "akm.lock");

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: "akm.lock", status: "skipped", detail: "source not found" });
    return;
  }
  if (fs.existsSync(dest)) {
    ctx.recordStep({ name: "akm.lock", status: "skipped", detail: "destination already exists" });
    return;
  }

  if (ctx.dryRun) {
    ctx.recordStep({ name: "akm.lock", status: "success", detail: `[dry-run] would copy ${src} → ${dest}` });
    return;
  }

  ensureDir(ctx.paths.dataDir);
  const ok = copyAndVerify(src, dest);
  if (ok) {
    ctx.recordStep({
      name: "akm.lock",
      status: "success",
      detail:
        `copied to ${dest} — source left at ${src}.\n` +
        `      IMPORTANT: akm now reads ONLY from $DATA/akm.lock. If this step is skipped,\n` +
        `      akm will start with an empty lockfile and 'akm add' will rebuild it from scratch.`,
    });
  } else {
    ctx.recordStep({ name: "akm.lock", status: "failed", detail: `size mismatch after copy: ${src} → ${dest}` });
  }
}

function migrateConfigBackups(ctx: MigrationContext): void {
  const src = path.join(ctx.paths.cacheDir, "config-backups");
  const dest = path.join(ctx.paths.dataDir, "config-backups");

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: "config-backups/", status: "skipped", detail: "source directory not found" });
    return;
  }
  if (fs.existsSync(dest)) {
    ctx.recordStep({ name: "config-backups/", status: "skipped", detail: "destination already exists" });
    return;
  }

  if (ctx.dryRun) {
    let srcCount = 0;
    try {
      srcCount = countFilesRecursive(src);
    } catch {
      // best-effort count for dry-run output
    }
    ctx.recordStep({
      name: "config-backups/",
      status: "success",
      detail: `[dry-run] would recursively copy ${srcCount} file(s) from ${src} → ${dest}`,
    });
    return;
  }

  try {
    const srcCount = countFilesRecursive(src);
    const { copied, failed } = copyDirRecursive(src, dest);
    const destCount = fs.existsSync(dest) ? countFilesRecursive(dest) : 0;

    if (failed === 0 && destCount === srcCount) {
      ctx.recordStep({
        name: "config-backups/",
        status: "success",
        detail: `copied ${copied} files to ${dest} — sources left in place (delete manually when ready)`,
      });
    } else {
      ctx.recordStep({
        name: "config-backups/",
        status: "failed",
        detail: `file count mismatch: source ${srcCount}, destination ${destCount}; ${failed} copy errors`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.recordStep({ name: "config-backups/", status: "failed", detail: msg });
  }
}

async function migrateTaskHistoryToDb(ctx: MigrationContext): Promise<void> {
  const src = path.join(ctx.paths.cacheDir, "tasks", "history");

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: "tasks/history/ → state.db", status: "skipped", detail: "source directory not found" });
    return;
  }

  const files = fs.readdirSync(src).filter((f) => f.endsWith(".jsonl"));

  if (files.length === 0) {
    ctx.recordStep({
      name: "tasks/history/ → state.db",
      status: "skipped",
      detail: "no *.jsonl files found in source directory",
    });
    return;
  }

  if (ctx.dryRun) {
    ctx.recordStep({
      name: "tasks/history/ → state.db",
      status: "success",
      detail: `[dry-run] would parse ${files.length} *.jsonl file(s) and import rows into ${ctx.paths.stateDbPath}`,
    });
    return;
  }

  try {
    ensureDir(ctx.paths.dataDir);

    const { openStateDatabase, upsertTaskHistory } = await import("../src/core/state-db");
    const db = openStateDatabase(ctx.paths.stateDbPath);

    let imported = 0;
    let failed = 0;

    try {
      for (const file of files) {
        const filePath = path.join(src, file);
        const text = fs.readFileSync(filePath, "utf8");
        const lines = text.split("\n").filter((l) => l.trim().length > 0);

        for (const line of lines) {
          try {
            const row = JSON.parse(line) as {
              id: string;
              status: string;
              startedAt: string;
              finishedAt: string;
              durationMs: number;
              log: string;
              target: { kind: string; ref?: string; profile?: string };
              detail?: Record<string, unknown>;
            };

            const meta: Record<string, unknown> = { durationMs: row.durationMs };
            if (row.detail !== undefined) meta.detail = row.detail;
            if (row.target?.kind === "prompt" && row.target.profile !== undefined) {
              meta.profile = row.target.profile;
            }

            upsertTaskHistory(db, {
              task_id: row.id,
              status: row.status,
              started_at: row.startedAt,
              completed_at: row.status !== "failed" ? row.finishedAt : null,
              failed_at: row.status === "failed" ? row.finishedAt : null,
              log_path: row.log || null,
              target_kind: row.target?.kind ?? null,
              target_ref: row.target?.kind === "workflow" ? (row.target.ref ?? null) : null,
              metadata_json: JSON.stringify(meta),
            });
            imported++;
          } catch {
            failed++;
          }
        }
      }
    } finally {
      db.close();
    }

    if (failed === 0) {
      ctx.recordStep({
        name: "tasks/history/ → state.db",
        status: "success",
        detail: `imported ${imported} task history row(s) from ${files.length} JSONL file(s) into state.db — sources left in place (delete manually when ready)`,
      });
    } else {
      ctx.recordStep({
        name: "tasks/history/ → state.db",
        status: "failed",
        detail: `imported ${imported} row(s); ${failed} line(s) could not be parsed`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.recordStep({ name: "tasks/history/ → state.db", status: "failed", detail: msg });
  }
}

function noteRegistryIndexCache(ctx: MigrationContext): void {
  const src = path.join(ctx.paths.cacheDir, "registry-index");

  if (!fs.existsSync(src)) {
    ctx.recordStep({ name: "registry-index/ (note)", status: "skipped", detail: "no old $CACHE/registry-index/ directory found" });
    return;
  }

  const legacyFiles = fs.readdirSync(src).filter((f) => f.endsWith(".json") && !f.startsWith("website-"));

  if (legacyFiles.length === 0) {
    ctx.recordStep({ name: "registry-index/ (note)", status: "skipped", detail: "no old *.json cache files found" });
    return;
  }

  if (!ctx.dryRun) {
    console.log(
      `\n  Note: found ${legacyFiles.length} old registry-index JSON file(s) in ${src}.` +
        `\n        These are ignored in v0.9 — data is now stored in the registry_index_cache` +
        `\n        table in $DATA/index.db and will be rebuilt on next 'akm registry search'.` +
        `\n        You may safely delete these files after migration:\n` +
        legacyFiles.map((f) => `          ${path.join(src, f)}`).join("\n"),
    );
  }

  ctx.recordStep({
    name: "registry-index/ (note)",
    status: "success",
    detail:
      `${legacyFiles.length} old file(s) noted at ${src} — registry index cache will be rebuilt on next ` +
      `'akm registry search'. Safe to delete: ${src}/*.json`,
  });
}

// ── 0.7 → 0.8 migration ──────────────────────────────────────────────────────

const v07To08Migration: MigrationVersion = {
  label: "0.7 → 0.8",
  sourceVersion: "0.7",
  isNeeded: (paths) => {
    // Needed if any legacy source exists in the old locations.
    const candidates = [
      path.join(paths.cacheDir, "index.db"),
      path.join(paths.cacheDir, "workflow.db"),
      path.join(paths.cacheDir, "events.jsonl"),
      path.join(paths.cacheDir, "tasks", "history"),
      path.join(paths.configDir, "akm.lock"),
      path.join(paths.cacheDir, "config-backups"),
      path.join(paths.cacheDir, "registry-index"),
    ];
    return candidates.some((p) => fs.existsSync(p));
  },
  run: async (ctx) => {
    migrateDb(ctx, "index.db"); // Step 1
    migrateDb(ctx, "workflow.db"); // Step 2
    await migrateEventsJsonl(ctx); // Step 3
    migrateTaskHistory(ctx); // Step 4
    migrateLockfile(ctx); // Step 5
    migrateConfigBackups(ctx); // Step 6
    await migrateTaskHistoryToDb(ctx); // Step 7
    noteRegistryIndexCache(ctx); // Step 8
  },
};

// ── 0.8 → 0.9 step: graph file → DB ──────────────────────────────────────────

/**
 * Candidate locations for legacy file-based graph snapshots. The akm codebase
 * never wrote graph data to files (since 0.8 graph data lives entirely in
 * index.db), so this is mostly a forward-looking placeholder. We still scan
 * a small set of conventional paths so that any external tool that exported
 * a snapshot can be re-imported.
 */
function legacyGraphCandidatePaths(ctx: MigrationContext): string[] {
  return [
    path.join(ctx.paths.cacheDir, "graph-snapshot.json"),
    path.join(ctx.paths.dataDir, "graph-snapshot.json"),
    path.join(ctx.paths.dataDir, "graph-export.json"),
  ];
}

function findLegacyGraphFile(ctx: MigrationContext): string | null {
  for (const candidate of legacyGraphCandidatePaths(ctx)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  // Also accept any *.json under $CACHE/graph/ if present.
  const graphDir = path.join(ctx.paths.cacheDir, "graph");
  if (fs.existsSync(graphDir) && fs.statSync(graphDir).isDirectory()) {
    try {
      const json = fs
        .readdirSync(graphDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(graphDir, f));
      if (json.length > 0) return json[0]!;
    } catch {
      // ignored
    }
  }
  return null;
}

interface LegacyGraphSnapshotShape {
  schemaVersion?: number;
  generatedAt?: string;
  stashRoot?: string;
  files?: Array<{
    path: string;
    type: string;
    bodyHash?: string;
    entities?: string[];
    relations?: Array<{ from: string; to: string; type?: string; confidence?: number }>;
    confidence?: number;
  }>;
  entities?: string[];
  relations?: Array<{ from: string; to: string; type?: string; confidence?: number }>;
  quality?: {
    consideredFiles?: number;
    extractedFiles?: number;
    entityCount?: number;
    relationCount?: number;
    extractionCoverage?: number;
    density?: number;
  };
}

function validateGraphSnapshot(parsed: unknown): { ok: true; data: LegacyGraphSnapshotShape } | { ok: false; reason: string } {
  if (parsed == null || typeof parsed !== "object") return { ok: false, reason: "root is not an object" };
  const obj = parsed as LegacyGraphSnapshotShape;
  if (typeof obj.stashRoot !== "string" || obj.stashRoot.length === 0) {
    return { ok: false, reason: "missing string field 'stashRoot'" };
  }
  if (!Array.isArray(obj.files)) return { ok: false, reason: "missing array field 'files'" };
  for (const [i, f] of obj.files.entries()) {
    if (!f || typeof f !== "object") return { ok: false, reason: `files[${i}] is not an object` };
    if (typeof f.path !== "string") return { ok: false, reason: `files[${i}].path must be a string` };
    if (typeof f.type !== "string") return { ok: false, reason: `files[${i}].type must be a string` };
    if (!Array.isArray(f.entities)) return { ok: false, reason: `files[${i}].entities must be an array` };
    if (!Array.isArray(f.relations)) return { ok: false, reason: `files[${i}].relations must be an array` };
  }
  return { ok: true, data: obj };
}

async function migrateGraphFileToDb(ctx: MigrationContext): Promise<void> {
  const name = "Graph snapshot import";

  const legacyFile = findLegacyGraphFile(ctx);
  if (!legacyFile) {
    ctx.recordStep({ name, status: "skipped", detail: "no legacy graph file found" });
    return;
  }

  if (!fs.existsSync(ctx.paths.indexDbPath)) {
    ctx.recordStep({
      name,
      status: "skipped",
      detail: `index.db not found at ${ctx.paths.indexDbPath}; run akm to initialize, then re-run this migration`,
    });
    return;
  }

  if (ctx.dryRun) {
    ctx.recordStep({
      name,
      status: "success",
      detail: `[dry-run] would parse ${legacyFile} and import into ${ctx.paths.indexDbPath} graph tables`,
    });
    return;
  }

  try {
    const raw = fs.readFileSync(legacyFile, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.recordStep({ name, status: "failed", detail: `${legacyFile} is not valid JSON: ${msg}` });
      return;
    }

    const validation = validateGraphSnapshot(parsed);
    if (!validation.ok) {
      ctx.recordStep({
        name,
        status: "failed",
        detail: `${legacyFile} does not match expected GraphSnapshot shape: ${validation.reason}`,
      });
      return;
    }
    const snapshot = validation.data;

    const { openExistingDatabase, closeDatabase } = await import("../src/indexer/db");
    const { replaceStoredGraph, loadStoredGraphMeta } = await import("../src/indexer/graph-db");

    const db = openExistingDatabase(ctx.paths.indexDbPath);
    try {
      const graph = {
        schemaVersion: snapshot.schemaVersion ?? 2,
        generatedAt: snapshot.generatedAt ?? new Date().toISOString(),
        stashRoot: snapshot.stashRoot!,
        files: (snapshot.files ?? []).map((f) => ({
          path: f.path,
          type: f.type,
          ...(f.bodyHash ? { bodyHash: f.bodyHash } : {}),
          entities: f.entities ?? [],
          relations: (f.relations ?? []).map((r) => ({
            from: r.from,
            to: r.to,
            ...(r.type ? { type: r.type } : {}),
            ...(typeof r.confidence === "number" ? { confidence: r.confidence } : {}),
          })),
          ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
        })),
        ...(snapshot.entities ? { entities: snapshot.entities } : {}),
        ...(snapshot.relations
          ? {
              relations: snapshot.relations.map((r) => ({
                from: r.from,
                to: r.to,
                ...(r.type ? { type: r.type } : {}),
                ...(typeof r.confidence === "number" ? { confidence: r.confidence } : {}),
              })),
            }
          : {}),
        ...(snapshot.quality
          ? {
              quality: {
                consideredFiles: snapshot.quality.consideredFiles ?? 0,
                extractedFiles: snapshot.quality.extractedFiles ?? 0,
                entityCount: snapshot.quality.entityCount ?? 0,
                relationCount: snapshot.quality.relationCount ?? 0,
                extractionCoverage: snapshot.quality.extractionCoverage ?? 0,
                density: snapshot.quality.density ?? 0,
              },
            }
          : {}),
      };

      // GraphFile type from src/indexer/graph-extraction.ts. The cast is safe
      // because validateGraphSnapshot enforced the required fields above.
      replaceStoredGraph(db, graph as unknown as Parameters<typeof replaceStoredGraph>[1]);

      // Verify that at least one file was actually imported. If all files were
      // orphans (no matching entries row), the import is effectively a no-op
      // and we must not consume the source file.
      const importedCount = (
        db.prepare("SELECT COUNT(*) AS cnt FROM graph_files WHERE stash_root = ?").get(snapshot.stashRoot!) as {
          cnt: number;
        }
      ).cnt;

      const meta = loadStoredGraphMeta(snapshot.stashRoot!, db);
      if (!meta) {
        ctx.recordStep({
          name,
          status: "failed",
          detail: `import did not produce a graph_meta row for stash ${snapshot.stashRoot}`,
        });
        return;
      }

      if (importedCount === 0) {
        ctx.recordStep({
          name,
          status: "failed",
          detail:
            `import produced zero graph_files rows for stash ${snapshot.stashRoot} — ` +
            `the entries table has no matching paths. Run "akm index" first, then retry the migration. ` +
            `Source file ${legacyFile} was NOT renamed.`,
        });
        return;
      }

      // Rename source so a re-run does not double-import. Contents preserved.
      const renamed = `${legacyFile}.migrated`;
      try {
        fs.renameSync(legacyFile, renamed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.recordStep({
          name,
          status: "success",
          detail: `imported graph for ${snapshot.stashRoot} into ${ctx.paths.indexDbPath} but could not rename ${legacyFile}: ${msg}`,
        });
        return;
      }

      ctx.recordStep({
        name,
        status: "success",
        detail:
          `imported graph snapshot from ${legacyFile} into ${ctx.paths.indexDbPath} ` +
          `(stash ${snapshot.stashRoot}; ${importedCount} file(s) imported of ${graph.files.length} in source). ` +
          `Source renamed to ${renamed} — delete manually when ready.`,
      });
    } finally {
      closeDatabase(db);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.recordStep({ name, status: "failed", detail: msg });
  }
}

// ── 0.8 → 0.9 migration ──────────────────────────────────────────────────────

const v08To09Migration: MigrationVersion = {
  label: "0.8 → 0.9",
  sourceVersion: "0.8",
  isNeeded: (_paths) => {
    // The graph import step is a no-op when no legacy file exists, but we
    // still want this migration listed so the user sees the step it would
    // perform. Returning true ensures the run() executes and records a
    // "skipped" step rather than silently omitting the whole section.
    return true;
  },
  run: async (ctx) => {
    await migrateGraphFileToDb(ctx);
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const MIGRATIONS: MigrationVersion[] = [v07To08Migration, v08To09Migration];

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

// ── --list output ────────────────────────────────────────────────────────────

function printList(): void {
  console.log("akm storage migrations (in execution order):");
  for (const m of MIGRATIONS) {
    console.log(`  • ${m.label}    [sourceVersion=${m.sourceVersion}]`);
  }
  console.log();
  console.log("Resolved paths:");
  console.log(`  $CACHE  = ${cacheDir}`);
  console.log(`  $CONFIG = ${configDir}`);
  console.log(`  $DATA   = ${dataDir}`);
  console.log(`  $STATE  = ${stateDir}`);
}

// ── Filtering ────────────────────────────────────────────────────────────────

/**
 * Compare two dotted version strings ("0.7", "0.8.0", etc.) numerically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compareVersion(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function filteredMigrations(): MigrationVersion[] {
  if (!FROM_VERSION) return MIGRATIONS;
  return MIGRATIONS.filter((m) => compareVersion(m.sourceVersion, FROM_VERSION) >= 0);
}

// ── Summary printing ─────────────────────────────────────────────────────────

function printGroupedSummary(): void {
  console.log("\nakm storage migration — RESULTS");
  console.log("================================");

  let totalFailures = 0;

  for (const report of versionReports) {
    console.log(`\n=== Migration: ${report.label} ===`);
    if (!report.ran) {
      console.log(`  (not run — ${report.skipReason ?? "isNeeded returned false"})`);
      continue;
    }
    if (report.results.length === 0) {
      console.log("  (no steps recorded)");
      continue;
    }
    for (const r of report.results) {
      const glyph = r.status === "success" ? "✓" : r.status === "skipped" ? "⊘" : "✗";
      console.log(`  ${glyph} ${r.name}${r.status === "skipped" ? ` — ${r.detail}` : ""}`);
      if (r.status !== "skipped") {
        console.log(`      ${r.detail}`);
      }
      if (r.status === "failed") totalFailures += 1;
    }
  }

  if (totalFailures > 0) {
    console.log(`\n${totalFailures} step(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nMigration complete. No errors.");
  }

  console.log(`
Old files at the original locations are safe to delete manually after verifying akm works:
  ${path.join(cacheDir, "index.db")}
  ${path.join(cacheDir, "workflow.db")}
  ${path.join(cacheDir, "events.jsonl")}
  ${path.join(cacheDir, "tasks", "history")}
  ${path.join(cacheDir, "config-backups")}
  ${path.join(configDir, "akm.lock")}

Next step — repopulate graph data (if migrating from 0.7):
  The 0.8.0 graph schema redesign (DB_VERSION 12 → 13) rebuilds the graph
  tables in index.db. Non-graph tables regenerate automatically on first
  open, but graph extraction requires LLM calls. Run:
    akm improve
  once after migration so graph-backed features (akm graph related/entity,
  graph-boosted search ranking) have data to work with. See
  docs/migration/v0.7-to-v0.8.md#graph-extraction-will-re-run-after-upgrade.
`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runMigrations(opts: { dryRun: boolean; paths?: ResolvedPaths } = { dryRun: DRY_RUN }): Promise<VersionRunReport[]> {
  const paths = opts.paths ?? PATHS;
  const reports: VersionRunReport[] = [];

  const migrations = filteredMigrations();

  for (const migration of migrations) {
    const stepResults: StepResult[] = [];
    const ctx: MigrationContext = {
      dryRun: opts.dryRun,
      recordStep: (r) => stepResults.push(r),
      paths,
    };

    let needed = false;
    try {
      needed = await migration.isNeeded(paths);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reports.push({
        label: migration.label,
        ran: false,
        skipReason: `isNeeded() threw: ${msg}`,
        results: [],
      });
      continue;
    }

    if (!needed) {
      reports.push({ label: migration.label, ran: false, skipReason: "isNeeded() returned false", results: [] });
      continue;
    }

    try {
      await migration.run(ctx);
      reports.push({ label: migration.label, ran: true, results: stepResults });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stepResults.push({ name: "(migration aborted)", status: "failed", detail: msg });
      reports.push({ label: migration.label, ran: true, results: stepResults });
    }
  }

  return reports;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (LIST_ONLY) {
    printList();
    return;
  }

  console.log("akm storage migration");
  console.log("=====================");
  console.log(`  $CACHE  = ${cacheDir}`);
  console.log(`  $CONFIG = ${configDir}`);
  console.log(`  $DATA   = ${dataDir}`);
  console.log(`  $STATE  = ${stateDir}`);
  console.log();
  console.log("Planned migrations (after --from filter):");
  for (const m of filteredMigrations()) {
    console.log(`  • ${m.label}`);
  }
  if (FROM_VERSION) console.log(`  (filtered: --from ${FROM_VERSION})`);
  console.log();

  if (!DRY_RUN) {
    const proceed = await confirm();
    if (!proceed) {
      console.log("Aborted. No changes made.");
      return;
    }
  } else {
    console.log("[dry-run] No changes will be written.\n");
  }

  const reports = await runMigrations({ dryRun: DRY_RUN, paths: PATHS });
  versionReports.push(...reports);

  printGroupedSummary();

  if (DRY_RUN) {
    console.log("Dry run complete. No changes made.");
  }
}

// Run main only when this file is executed directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const here = new URL(import.meta.url).pathname;
    return path.resolve(entry) === here;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await main();
}
