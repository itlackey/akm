// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { type AssetRef, parseRefInput } from "../../core/asset/resolve-ref";
import { isContainedResolvedPath } from "../../core/common";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { lookup } from "../indexer";
import { deriveInstallations } from "../installations";
import { resolveSourceEntries } from "../search/search-source";

export interface ResolveAssetPathOptions {
  stashDir?: string;
  mode?: "index-only" | "index-first" | "disk-only";
  writableBundleIds?: ReadonlySet<string>;
  directoryIndexNames?: readonly string[];
  preserveDirectNameFallback?: boolean;
  honorOrigin?: boolean;
}

function normalizeRef(ref: string | AssetRef): AssetRef {
  // String inputs use the current `[bundle//]conceptId` grammar.
  return typeof ref === "string" ? parseRefInput(ref) : ref;
}

function buildDiskCandidates(sourcePath: string, ref: AssetRef, preserveDirectNameFallback: boolean): string[] {
  const placementStashDir = stashDirFor(ref.type);
  // Opaque adapter conceptIds are index-resolved. Core cannot infer their
  // adapter-owned serialization or path extension before indexing.
  if (placementStashDir === undefined) return [];
  const typeDir = path.join(sourcePath, placementStashDir);
  const candidates = [
    assetPathForName(ref.type, typeDir, ref.name),
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
  const installations = deriveInstallations(sources);
  for (const [index, source] of sources.entries()) {
    const bundleId = installations[index]?.id;
    if (options.writableBundleIds && (!bundleId || !options.writableBundleIds.has(bundleId))) continue;
    const candidates = buildDiskCandidates(source.path, ref, preserveDirectNameFallback);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const resolved = resolveDirectoryEntry(candidate, directoryIndexNames);
      if (!resolved) continue;
      // Name grammar only: a symlinked asset resolves to its target.
      if (!isContainedResolvedPath(path.resolve(resolved), path.resolve(source.path))) continue;
      return fs.realpathSync(resolved);
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
