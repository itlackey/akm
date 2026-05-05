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
import { makeAssetRef } from "../core/asset-ref";
import { deriveCanonicalAssetNameFromStashRoot } from "../core/asset-spec";
import { resolveStashDir } from "../core/common";
import { type AkmConfig, loadConfig } from "../core/config";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import type { ManifestEntry, ManifestResponse } from "../sources/types";
import { closeDatabase, getAllEntries, getEntryCount, getMeta, openExistingDatabase } from "./db";
import { generateMetadataFlat, loadStashFile, type StashEntry } from "./metadata";
import { resolveSourceEntries, type SearchSource as SourceSpec } from "./search-source";
import { walkStashFlat } from "./walker";

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
 * Returns null if the entry cannot be converted (e.g. malformed name).
 */
function toManifestEntry(
  entry: StashEntry,
  filePath: string,
  stashDir: string,
  registryId?: string,
): ManifestEntry | null {
  try {
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
  } catch (error) {
    warn(
      `Manifest: skipping entry "${entry.name}" (${entry.type}):`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Get the manifest from the database (fast path).
 */
function getManifestFromDb(
  stashDir: string,
  _config: AkmConfig,
  sources: SourceSpec[],
  type?: string,
): ManifestEntry[] | null {
  const dbPath = getDbPath();
  try {
    if (!fs.existsSync(dbPath)) return null;

    const db = openExistingDatabase(dbPath);
    try {
      const entryCount = getEntryCount(db);
      const storedStashDir = getMeta(db, "stashDir");
      if (entryCount === 0 || storedStashDir !== stashDir) return null;

      const typeFilter = type && type !== "any" ? type : undefined;
      const allEntries = getAllEntries(db, typeFilter);

      // Deduplicate by file path
      const seenFilePaths = new Set<string>();
      const entries: ManifestEntry[] = [];
      for (const ie of allEntries) {
        if (seenFilePaths.has(ie.filePath)) continue;
        seenFilePaths.add(ie.filePath);

        // Find origin for this entry
        const source = sources.find((s) => ie.filePath.startsWith(path.resolve(s.path) + path.sep));
        const entry = toManifestEntry(ie.entry, ie.filePath, ie.stashDir, source?.registryId);
        if (entry) entries.push(entry);
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
async function getManifestFromWalker(sources: SourceSpec[], type?: string): Promise<ManifestEntry[]> {
  const allSourceDirs = sources.map((s) => s.path);

  const entries: ManifestEntry[] = [];

  for (const currentStashDir of allSourceDirs) {
    const fileContexts = walkStashFlat(currentStashDir);

    // Group by parent directory
    const dirGroups = new Map<string, string[]>();
    for (const ctx of fileContexts) {
      const group = dirGroups.get(ctx.parentDirAbs);
      if (group) group.push(ctx.absPath);
      else dirGroups.set(ctx.parentDirAbs, [ctx.absPath]);
    }

    for (const [dirPath, files] of dirGroups) {
      const generated = await generateMetadataFlat(currentStashDir, files);
      const legacyOverrides = loadStashFile(dirPath, { requireFilename: true });
      const mergedEntries = legacyOverrides
        ? generated.entries.map((entry) => mergeLegacyEntry(entry, legacyOverrides.entries))
        : generated.entries;
      const stash = mergedEntries.length > 0 ? { entries: mergedEntries } : legacyOverrides;
      if (!stash || stash.entries.length === 0) continue;

      const source = sources.find((s) => dirPath.startsWith(path.resolve(s.path) + path.sep));

      for (const stashEntry of stash.entries) {
        if (type && type !== "any" && stashEntry.type !== type) continue;
        if (!stashEntry.filename) continue;
        const entryPath = path.join(dirPath, stashEntry.filename);
        const manifestEntry = toManifestEntry(stashEntry, entryPath, currentStashDir, source?.registryId);
        if (manifestEntry) entries.push(manifestEntry);
      }
    }
  }

  return entries;
}

function mergeLegacyEntry(entry: StashEntry, legacyEntries: StashEntry[]): StashEntry {
  const legacy = legacyEntries.find((candidate) => candidate.filename === entry.filename);
  return legacy ? { ...entry, ...legacy, filename: entry.filename } : entry;
}

/**
 * Generate a compact manifest of all assets in the stash.
 *
 * Tries the database first (fast path). Falls back to walker-based listing
 * if no index is available.
 */
export async function akmManifest(options?: { stashDir?: string; type?: string }): Promise<ManifestResponse> {
  const stashDir = options?.stashDir ?? resolveStashDir();
  const type = options?.type;
  const config = loadConfig();
  const sources = resolveSourceEntries(stashDir, config);

  // Fast path: try database
  const dbEntries = getManifestFromDb(stashDir, config, sources, type);
  if (dbEntries !== null) {
    return {
      schemaVersion: 1,
      entries: dbEntries,
    };
  }

  // Fallback: walk filesystem
  const walkerEntries = await getManifestFromWalker(sources, type);
  return {
    schemaVersion: 1,
    entries: walkerEntries,
  };
}
