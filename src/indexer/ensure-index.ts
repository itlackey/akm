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
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import { openExistingDatabase, getEntryCount, getMeta, closeDatabase } from "./db";

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
    warn(
      "Auto-index failed, proceeding with existing index:",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}
