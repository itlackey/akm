// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { type AssetRef, parseAssetRef } from "../../core/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "../../core/asset-spec";
import { isWithin } from "../../core/common";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { lookup } from "../indexer";
import { resolveSourceEntries } from "../search/search-source";

export interface ResolveAssetPathOptions {
  stashDir?: string;
  mode?: "index-only" | "index-first" | "disk-only";
  writableDirSet?: ReadonlySet<string>;
  directoryIndexNames?: readonly string[];
  preserveDirectNameFallback?: boolean;
  honorOrigin?: boolean;
}

function normalizeRef(ref: string | AssetRef): AssetRef {
  return typeof ref === "string" ? parseAssetRef(ref) : ref;
}

function buildDiskCandidates(sourcePath: string, ref: AssetRef, preserveDirectNameFallback: boolean): string[] {
  const typeDir = path.join(sourcePath, TYPE_DIRS[ref.type] ?? `${ref.type}s`);
  const candidates = [
    resolveAssetPathFromName(ref.type, typeDir, ref.name),
    path.join(sourcePath, ref.type, `${ref.name}.md`),
    path.join(sourcePath, ref.type, ref.name),
  ];
  if (preserveDirectNameFallback) {
    candidates.push(path.join(sourcePath, `${ref.name}.md`), path.join(sourcePath, ref.name));
  }
  return candidates;
}

function resolveDirectoryEntry(filePath: string, directoryIndexNames: readonly string[]): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.isFile()) return filePath;
  if (!stat.isDirectory()) return null;
  for (const indexName of directoryIndexNames) {
    const candidate = path.join(filePath, indexName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

async function resolveViaIndex(ref: AssetRef): Promise<string | null> {
  try {
    const entry = await lookup(ref);
    return entry?.filePath ?? null;
  } catch {
    return null;
  }
}

function resolveViaDisk(ref: AssetRef, options: ResolveAssetPathOptions): string | null {
  let sources = resolveSourceEntries(options.stashDir);
  if (options.honorOrigin !== false) {
    sources = resolveSourcesForOrigin(ref.origin, sources);
  }
  const directoryIndexNames = options.directoryIndexNames ?? ["SKILL.md"];
  const preserveDirectNameFallback = options.preserveDirectNameFallback ?? true;
  for (const source of sources) {
    if (options.writableDirSet && !options.writableDirSet.has(path.resolve(source.path))) continue;
    const candidates = buildDiskCandidates(source.path, ref, preserveDirectNameFallback);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const resolved = resolveDirectoryEntry(candidate, directoryIndexNames);
      if (!resolved) continue;
      const resolvedRoot = fs.realpathSync(source.path);
      const realTarget = fs.realpathSync(resolved);
      if (!isWithin(realTarget, resolvedRoot)) continue;
      return realTarget;
    }
  }
  return null;
}

export async function resolveAssetPath(
  ref: string | AssetRef,
  options: ResolveAssetPathOptions = {},
): Promise<string | null> {
  const parsed = normalizeRef(ref);
  const mode = options.mode ?? "index-first";
  if (mode !== "disk-only") {
    const indexed = await resolveViaIndex(parsed);
    if (indexed) return indexed;
    if (mode === "index-only") return null;
  }
  return resolveViaDisk(parsed, options);
}
