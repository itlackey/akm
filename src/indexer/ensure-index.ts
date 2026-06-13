// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ASSET_SPECS, type AssetSpec, TYPE_DIRS } from "../core/asset/asset-spec";
import { getDataDir, getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import { closeDatabase, getEntryCount, getMeta, openExistingDatabase } from "./db/db";

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
 * #607: Spawn a background `akm index` process. Non-blocking — returns
 * immediately. Uses a PID file to prevent multiple concurrent background
 * reindexes. The background process writes completion status to a log file.
 */
function spawnBackgroundReindex(_stashDir: string): void {
  const dataDir = getDataDir();
  const pidFile = path.join(dataDir, "akm-index-background.pid");
  const logFile = path.join(dataDir, "logs", "index-background.log");

  if (fs.existsSync(pidFile)) {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          fs.unlinkSync(pidFile);
        }
      }
    } catch {
      // PID file unreadable — proceed
    }
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const akmBin = process.argv[0];
  const akmScript = process.argv[1];
  const child = spawn(akmBin, [akmScript, "index", "--background"], {
    detached: true,
    stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
    env: { ...process.env, AKM_INDEX_BACKGROUND_PID_FILE: pidFile },
  });

  if (child.pid) {
    try {
      fs.writeFileSync(pidFile, String(child.pid), "utf8");
    } catch {
      // best-effort PID file write
    }
    child.unref();
  }
}

/**
 * #607: Non-blocking auto-index. When the local index is stale, spawns a
 * background `akm index` process and returns immediately. The caller can
 * proceed with a search against the existing (possibly stale) index.
 *
 * Set `AKM_INDEX_INLINE=1` to force synchronous indexing (for tests and CI).
 *
 * Returns `true` if an index run was attempted.
 */
export async function ensureIndex(stashDir: string): Promise<boolean> {
  if (!isIndexStale(stashDir)) return false;

  if (process.env.AKM_INDEX_INLINE === "1") {
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

  try {
    spawnBackgroundReindex(stashDir);
    return true;
  } catch (error) {
    warn(
      "Background reindex spawn failed, proceeding with existing index:",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}
