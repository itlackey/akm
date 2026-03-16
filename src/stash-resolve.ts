import fs from "node:fs";
import path from "node:path";
import {
  deriveCanonicalAssetNameFromStashRoot,
  isRelevantAssetFile,
  resolveAssetPathFromName,
  TYPE_DIRS,
} from "./asset-spec";
import { hasErrnoCode, isWithin } from "./common";
import { NotFoundError, UsageError } from "./errors";
import { runMatchers } from "./file-context";
import { walkStashFlat } from "./walker";

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
    throw new UsageError("Ref resolves outside the stash root.");
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new NotFoundError(`Stash asset not found for ref: ${type}:${name}`);
  }
  const realTarget = fs.realpathSync(resolvedTarget);
  if (!isWithin(realTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.");
  }
  if (!isRelevantAssetFile(type, path.basename(resolvedTarget))) {
    if (type === "script") {
      throw new NotFoundError(
        "Script ref must resolve to a file with a supported script extension. Refer to the akm documentation for the complete list of supported script extensions.",
      );
    }
    throw new NotFoundError(`Stash asset not found for ref: ${type}:${name}`);
  }
  return realTarget;
}

function resolveAndValidateTypeRoot(root: string, type: string, name: string): string {
  const rootStat = readTypeRootStat(root, type, name);
  if (!rootStat.isDirectory()) {
    throw new NotFoundError(`Stash type root is not a directory for ref: ${type}:${name}`);
  }
  return fs.realpathSync(root);
}

function readTypeRootStat(root: string, type: string, name: string): fs.Stats {
  try {
    return fs.statSync(root);
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new NotFoundError(`Stash type root not found for ref: ${type}:${name}`);
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
      throw new UsageError("Ref resolves outside the stash root.");
    }
    return realTarget;
  }

  return undefined;
}
