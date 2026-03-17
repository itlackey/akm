/**
 * Manifest: compact asset listing for cheap capability discovery.
 *
 * Returns a lightweight list of all assets (name, type, ref, one-line
 * description) that stays under 500 tokens for 50 assets. This gives
 * agents a fast way to discover available capabilities without loading
 * full content or running a search query.
 */

import fs from "node:fs";
import path from "node:path";
import { deriveCanonicalAssetNameFromStashRoot } from "./asset-spec";
import { loadConfig } from "./config";
import { closeDatabase, getAllEntries, getEntryCount, getMeta, openDatabase } from "./db";
import { generateMetadataFlat, loadStashFile, type StashEntry } from "./metadata";
import { getDbPath } from "./paths";
import { resolveStashSources } from "./search-source";
import { makeAssetRef } from "./stash-ref";
import type { ManifestEntry, ManifestResponse } from "./stash-types";
import { walkStashFlat } from "./walker";
import { warn } from "./warn";

const MAX_DESCRIPTION_LENGTH = 80;

/**
 * Truncate a description string to a maximum length, appending "..." if truncated.
 */
function truncateDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  if (desc.length <= MAX_DESCRIPTION_LENGTH) return desc;
  return `${desc.slice(0, MAX_DESCRIPTION_LENGTH)}...`;
}

/**
 * Build a compact ManifestEntry from a StashEntry.
 */
function toManifestEntry(entry: StashEntry, filePath: string, stashDir: string, registryId?: string): ManifestEntry {
  const canonical = deriveCanonicalAssetNameFromStashRoot(entry.type, stashDir, filePath);
  const refName = canonical && !canonical.startsWith("../") && !canonical.startsWith("..\\") ? canonical : entry.name;
  const ref = makeAssetRef(entry.type, refName, registryId);

  const result: ManifestEntry = {
    name: entry.name,
    type: entry.type,
    ref,
  };

  const desc = truncateDescription(entry.description);
  if (desc) {
    result.description = desc;
  }

  return result;
}

/**
 * Get the manifest from the database (fast path).
 */
function getManifestFromDb(stashDir: string, type?: string): ManifestEntry[] | null {
  const dbPath = getDbPath();
  try {
    if (!fs.existsSync(dbPath)) return null;

    const config = loadConfig();
    const embeddingDim = config.embedding?.dimension;
    const db = openDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);
    try {
      const entryCount = getEntryCount(db);
      const storedStashDir = getMeta(db, "stashDir");
      if (entryCount === 0 || storedStashDir !== stashDir) return null;

      const typeFilter = type && type !== "any" ? type : undefined;
      const allEntries = getAllEntries(db, typeFilter);
      const sources = resolveStashSources(stashDir, config);

      // Deduplicate by file path
      const seenFilePaths = new Set<string>();
      const entries: ManifestEntry[] = [];
      for (const ie of allEntries) {
        if (seenFilePaths.has(ie.filePath)) continue;
        seenFilePaths.add(ie.filePath);

        // Find origin for this entry
        const source = sources.find((s) => ie.filePath.startsWith(path.resolve(s.path) + path.sep));
        entries.push(toManifestEntry(ie.entry, ie.filePath, ie.stashDir, source?.registryId));
      }

      return entries;
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    warn(
      "Manifest: index unavailable, falling back to walker:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Get the manifest by walking the stash directory (fallback when no index).
 */
async function getManifestFromWalker(stashDir: string, type?: string): Promise<ManifestEntry[]> {
  const config = loadConfig();
  const sources = resolveStashSources(stashDir, config);
  const allStashDirs = sources.map((s) => s.path);

  const entries: ManifestEntry[] = [];

  for (const currentStashDir of allStashDirs) {
    const fileContexts = walkStashFlat(currentStashDir);

    // Group by parent directory
    const dirGroups = new Map<string, string[]>();
    for (const ctx of fileContexts) {
      const group = dirGroups.get(ctx.parentDirAbs);
      if (group) group.push(ctx.absPath);
      else dirGroups.set(ctx.parentDirAbs, [ctx.absPath]);
    }

    for (const [dirPath, files] of dirGroups) {
      // Try loading existing .stash.json first
      let stash = loadStashFile(dirPath);

      if (stash) {
        const coveredFiles = new Set(stash.entries.map((e) => e.filename).filter((e): e is string => !!e));
        const uncoveredFiles = files.filter((f) => !coveredFiles.has(path.basename(f)));
        if (uncoveredFiles.length > 0) {
          const generated = await generateMetadataFlat(currentStashDir, uncoveredFiles);
          if (generated.entries.length > 0) {
            stash = { entries: [...stash.entries, ...generated.entries] };
          }
        }
      } else {
        const generated = await generateMetadataFlat(currentStashDir, files);
        if (generated.entries.length === 0) continue;
        stash = generated;
      }

      const source = sources.find((s) => dirPath.startsWith(path.resolve(s.path) + path.sep));

      for (const entry of stash.entries) {
        if (type && type !== "any" && entry.type !== type) continue;
        const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
        entries.push(toManifestEntry(entry, entryPath, currentStashDir, source?.registryId));
      }
    }
  }

  return entries;
}

/**
 * Generate a compact manifest of all assets in the stash.
 *
 * Tries the database first (fast path). Falls back to walker-based listing
 * if no index is available.
 */
export async function akmManifest(options?: { stashDir?: string; type?: string }): Promise<ManifestResponse> {
  const stashDir = options?.stashDir || (await import("./common.js")).resolveStashDir();
  const type = options?.type;

  // Fast path: try database
  const dbEntries = getManifestFromDb(stashDir, type);
  if (dbEntries !== null) {
    return {
      schemaVersion: 1,
      entries: dbEntries,
      count: dbEntries.length,
    };
  }

  // Fallback: walk filesystem
  const walkerEntries = await getManifestFromWalker(stashDir, type);
  return {
    schemaVersion: 1,
    entries: walkerEntries,
    count: walkerEntries.length,
  };
}
