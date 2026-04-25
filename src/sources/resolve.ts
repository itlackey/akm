import fs from "node:fs";
import path from "node:path";
import {
  deriveCanonicalAssetNameFromStashRoot,
  isRelevantAssetFile,
  resolveAssetPathFromName,
  TYPE_DIRS,
} from "../core/asset-spec";
import { hasErrnoCode, isWithin } from "../core/common";
import { NotFoundError, UsageError } from "../core/errors";
import { runMatchers } from "../indexer/file-context";
import { walkStashFlat } from "../indexer/walker";

/**
 * Resolve an asset path from a stash directory, type, and name.
 */
export async function resolveAssetPath(stashDir: string, type: string, name: string): Promise<string> {
  try {
    return resolveInTypeDir(stashDir, TYPE_DIRS[type], type, name);
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
  const target = resolveAssetPathFromName(type, root, name);
  const resolvedRoot = resolveAndValidateTypeRoot(root, type, name);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(resolvedTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.", "PATH_ESCAPE_VIOLATION");
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new NotFoundError(`Stash asset not found for ref: ${type}:${name}`, "ASSET_NOT_FOUND");
  }
  const realTarget = fs.realpathSync(resolvedTarget);
  if (!isWithin(realTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.", "PATH_ESCAPE_VIOLATION");
  }
  if (!isRelevantAssetFile(type, path.basename(resolvedTarget))) {
    if (type === "script") {
      throw new NotFoundError(
        "Script ref must resolve to a file with a supported script extension. Refer to the akm documentation for the complete list of supported script extensions.",
      );
    }
    throw new NotFoundError(`Stash asset not found for ref: ${type}:${name}`, "ASSET_NOT_FOUND");
  }
  return realTarget;
}

function resolveAndValidateTypeRoot(root: string, type: string, name: string): string {
  const rootStat = readTypeRootStat(root, type, name);
  if (!rootStat.isDirectory()) {
    throw new NotFoundError(
      `Asset directory for ${type} assets is not accessible — got a file where a directory was expected for ref: ${type}:${name}. ` +
        "Run `akm index` to rebuild the index, or check your source configuration.",
      "ASSET_NOT_FOUND",
      "Run `akm list` to see your configured sources and verify the source path exists.",
    );
  }
  return fs.realpathSync(root);
}

function readTypeRootStat(root: string, type: string, name: string): fs.Stats {
  try {
    return fs.statSync(root);
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new NotFoundError(
        `Asset not found for ref: ${type}:${name}. No ${type} assets are present in the configured source.`,
        "ASSET_NOT_FOUND",
        "Run `akm list` to see your configured sources, or `akm index` to rebuild the search index.",
      );
    }
    throw error;
  }
}

async function resolveByCanonicalName(stashDir: string, type: string, name: string): Promise<string | undefined> {
  const normalizedName = name.replace(/\\/g, "/");

  for (const ctx of walkStashFlat(stashDir)) {
    const match = await runMatchers(ctx);
    if (!match || match.type !== type) continue;

    const canonicalName = deriveCanonicalAssetNameFromStashRoot(type, stashDir, ctx.absPath);
    if (canonicalName !== normalizedName) continue;

    const realTarget = fs.realpathSync(ctx.absPath);
    const resolvedRoot = fs.realpathSync(stashDir);
    if (!isWithin(realTarget, resolvedRoot)) {
      throw new UsageError("Ref resolves outside the stash root.", "PATH_ESCAPE_VIOLATION");
    }
    return realTarget;
  }

  return undefined;
}
