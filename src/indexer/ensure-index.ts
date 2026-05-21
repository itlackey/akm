/**
 * Auto-index: silently run an incremental `akm index` when the local index
 * is stale or absent, so that `search`, `show`, and `feedback` always operate
 * against current on-disk state without requiring the user to manually run
 * `akm index` first.
 *
 * This replaces the old filesystem fallbacks that were scattered across
 * `searchLocal()` and `show.ts`, centralizing the "indexed yet?" gap handling
 * behind a single entry point.
 */

import fs from "node:fs";
import path from "node:path";
import { ASSET_SPECS, type AssetSpec, TYPE_DIRS } from "../core/asset-spec";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import { closeDatabase, getEntryCount, getMeta, openExistingDatabase } from "./db";

function getIndexableFiles(root: string, spec: AssetSpec): string[] {
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && spec.isRelevantFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function hasNewerIndexableFiles(stashDir: string, builtAt: string | undefined): boolean {
  if (!builtAt) return true;
  const builtAtMs = new Date(builtAt).getTime();
  if (!Number.isFinite(builtAtMs)) return true;

  for (const [type, spec] of Object.entries(ASSET_SPECS)) {
    const typeRoot = path.join(stashDir, TYPE_DIRS[type] ?? spec.stashDir);
    const files = getIndexableFiles(typeRoot, spec);
    for (const file of files) {
      try {
        if (fs.statSync(file).mtimeMs > builtAtMs) return true;
      } catch {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether the local index is stale relative to the given stash directory.
 * Returns `true` when the index is missing, empty, or was built against a
 * different primary stash dir.
 */
export function isIndexStale(stashDir: string): boolean {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return true;

  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase(dbPath);
    const entryCount = getEntryCount(db);
    if (entryCount === 0) return true;

    const builtAt = getMeta(db, "builtAt");
    if (hasNewerIndexableFiles(stashDir, builtAt)) return true;

    const storedStashDir = getMeta(db, "stashDir");
    if (storedStashDir !== stashDir) {
      // Check if the incoming stashDir appears in the stored stashDirs array
      try {
        const storedDirs = JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[];
        if (!storedDirs.includes(stashDir)) return true;
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  } finally {
    if (db) closeDatabase(db);
  }
}

/**
 * Run an incremental index when the local index is stale. Best-effort —
 * failures are logged as warnings but never thrown, so the caller can
 * proceed (and surface a proper "not in index" error if the index is
 * still unusable).
 *
 * Returns `true` if an index run was attempted.
 */
export async function ensureIndex(stashDir: string): Promise<boolean> {
  if (!isIndexStale(stashDir)) return false;

  try {
    const { akmIndex } = await import("./indexer.js");
    await akmIndex({ stashDir });
    return true;
  } catch (error) {
    warn("Auto-index failed, proceeding with existing index:", error instanceof Error ? error.message : String(error));
    return true;
  }
}
