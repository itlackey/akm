// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { recognizeMatch } from "../core/adapter/recognize-match";
import {
  assetPathForName,
  deriveCanonicalAssetNameFromStashRoot,
  isRelevantAssetFile,
  stashDirFor,
} from "../core/asset/asset-placement";
import { conceptIdFromTypeName } from "../core/asset/resolve-ref";
import { hasErrnoCode, isContainedResolvedPath } from "../core/common";
import { NotFoundError, UsageError } from "../core/errors";
import { walkStashFlat } from "../indexer/walk/walker";

/**
 * Resolve an asset path from a stash directory, type, and name. The path keeps
 * the authored spelling, not the symlink target's: an asset that links to a
 * file with another name (or none) is still the kind its own name says, and a
 * read through it reaches the same bytes.
 */
export async function resolveAssetPath(stashDir: string, type: string, name: string): Promise<string> {
  try {
    return resolveInTypeDir(stashDir, stashDirFor(type) as string, type, name);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;

    const fallback = await resolveByCanonicalName(stashDir, type, name);
    if (fallback) return fallback;

    throw error;
  }
}

/**
 * Try to resolve an asset path within a specific type directory.
 */
function resolveInTypeDir(stashDir: string, typeDir: string, type: string, name: string): string {
  const root = path.join(stashDir, typeDir);
  const target = assetPathForName(type, root, name);
  resolveAndValidateTypeRoot(root, type, name);
  const resolvedTarget = path.resolve(target);
  // Name grammar: the name must not climb out of the type directory (`..` or
  // an absolute name). Lexical only: an asset that is a symlink to a file
  // elsewhere resolves, because installing a bundle is the trust decision.
  if (!isContainedResolvedPath(resolvedTarget, path.resolve(root))) {
    throw new UsageError("Ref resolves outside the stash root.", "PATH_ESCAPE_VIOLATION");
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new NotFoundError(`Stash asset not found for ref: ${conceptIdFromTypeName(type, name)}`, "ASSET_NOT_FOUND");
  }
  if (!isRelevantAssetFile(type, path.basename(resolvedTarget))) {
    if (type === "script") {
      throw new NotFoundError(
        "Script ref must resolve to a file with a supported script extension. Refer to the akm documentation for the complete list of supported script extensions.",
      );
    }
    throw new NotFoundError(`Stash asset not found for ref: ${conceptIdFromTypeName(type, name)}`, "ASSET_NOT_FOUND");
  }
  return resolvedTarget;
}

function resolveAndValidateTypeRoot(root: string, type: string, name: string): void {
  const rootStat = readTypeRootStat(root, type, name);
  if (!rootStat.isDirectory()) {
    throw new NotFoundError(
      `Asset directory for ${type} assets is not accessible — got a file where a directory was expected for ref: ${conceptIdFromTypeName(type, name)}. ` +
        "Run `akm index` to rebuild the index, or check your source configuration.",
      "ASSET_NOT_FOUND",
      "Run `akm bundle list` to see your configured sources and verify the source path exists.",
    );
  }
}

function readTypeRootStat(root: string, type: string, name: string): fs.Stats {
  try {
    return fs.statSync(root);
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new NotFoundError(
        `Asset not found for ref: ${conceptIdFromTypeName(type, name)}. No ${type} assets are present in the configured source.`,
        "ASSET_NOT_FOUND",
        "Run `akm bundle list` to see your configured sources, or `akm index` to rebuild the search index.",
      );
    }
    throw error;
  }
}

async function resolveByCanonicalName(stashDir: string, type: string, name: string): Promise<string | undefined> {
  const normalizedName = name.replace(/\\/g, "/");

  for (const ctx of walkStashFlat(stashDir)) {
    const match = recognizeMatch(ctx);
    if (!match || match.type !== type) continue;

    const canonicalName = deriveCanonicalAssetNameFromStashRoot(type, stashDir, ctx.absPath);
    if (canonicalName !== normalizedName) continue;

    return ctx.absPath;
  }

  return undefined;
}
