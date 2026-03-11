import fs from "node:fs";
import path from "node:path";
import { isRelevantAssetFile, resolveAssetPathFromName, TYPE_DIRS } from "./asset-spec";
import { type AgentikitAssetType, hasErrnoCode, isWithin, normalizeAssetType } from "./common";
import { NotFoundError, UsageError } from "./errors";

/**
 * Resolve an asset path from a stash directory, type, and name.
 *
 * When `type` is "script" or "tool" (which is a transparent alias for "script"),
 * resolution tries both the primary type directory and the alias directory:
 *   - script → tries scripts/ then tools/
 *   - tool   → tries tools/ then scripts/
 * This ensures that `script:deploy.sh` can find files in either `scripts/` or `tools/`.
 */
export function resolveAssetPath(stashDir: string, type: AgentikitAssetType, name: string): string {
  // For script/tool, try the primary directory first, then the alias directory.
  if (type === "script" || type === "tool") {
    const primaryDir = TYPE_DIRS[type];
    const aliasDir = type === "script" ? "tools" : "scripts";
    const dirsToTry = [primaryDir, aliasDir];

    let primaryError: Error | undefined;
    let lastError: Error | undefined;
    for (let i = 0; i < dirsToTry.length; i++) {
      try {
        return resolveInTypeDir(stashDir, dirsToTry[i], type, name);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (i === 0) primaryError = error;
        lastError = error;
        // Only fall through on NotFoundError -- rethrow security/usage errors immediately
        if (err instanceof UsageError) throw err;
      }
    }
    // Prefer the primary directory's error when it's about extension validation
    // (i.e., the file was found but had the wrong extension) over a generic
    // "not found" from the alias directory.
    const errorToThrow =
      primaryError && primaryError.message.includes("supported script extension")
        ? primaryError
        : (lastError ?? new NotFoundError(`Stash asset not found for ref: ${normalizeAssetType(type)}:${name}`));
    throw errorToThrow;
  }

  return resolveInTypeDir(stashDir, TYPE_DIRS[type], type, name);
}

/**
 * Try to resolve an asset path within a specific type directory.
 */
function resolveInTypeDir(
  stashDir: string,
  typeDir: string,
  type: AgentikitAssetType,
  name: string,
): string {
  const root = path.join(stashDir, typeDir);
  const target = resolveAssetPathFromName(type, root, name);
  const resolvedRoot = resolveAndValidateTypeRoot(root, type, name);
  const resolvedTarget = path.resolve(target);
  if (!isWithin(resolvedTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.");
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new NotFoundError(`Stash asset not found for ref: ${normalizeAssetType(type)}:${name}`);
  }
  const realTarget = fs.realpathSync(resolvedTarget);
  if (!isWithin(realTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.");
  }
  // Use "script" for relevance check since tool is an alias for script
  const relevanceType = type === "tool" ? "script" : type;
  if (!isRelevantAssetFile(relevanceType, path.basename(resolvedTarget))) {
    if (type === "tool" || type === "script") {
      throw new NotFoundError(
        "Script ref must resolve to a file with a supported script extension. Refer to the Agentikit documentation for the complete list of supported script extensions.",
      );
    }
    throw new NotFoundError(`Stash asset not found for ref: ${normalizeAssetType(type)}:${name}`);
  }
  return realTarget;
}

function resolveAndValidateTypeRoot(root: string, type: AgentikitAssetType, name: string): string {
  const rootStat = readTypeRootStat(root, type, name);
  if (!rootStat.isDirectory()) {
    throw new NotFoundError(`Stash type root is not a directory for ref: ${normalizeAssetType(type)}:${name}`);
  }
  return fs.realpathSync(root);
}

function readTypeRootStat(root: string, type: AgentikitAssetType, name: string): fs.Stats {
  try {
    return fs.statSync(root);
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new NotFoundError(`Stash type root not found for ref: ${normalizeAssetType(type)}:${name}`);
    }
    throw error;
  }
}
