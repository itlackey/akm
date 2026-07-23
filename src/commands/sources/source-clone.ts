// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stashDirFor } from "../../core/asset/asset-placement";
import { displayRef, parseQualifiedRefInput } from "../../core/asset/resolve-ref";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import { commitWriteTargetBoundary, prepareWriteTargetForMutation, resolveWriteTarget } from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { findSourceForPath, resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { isRemoteOrigin, resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import { resolveAssetPath } from "../../sources/resolve";

export interface CloneOptions {
  /** Source ref (e.g., npm:@scope/pkg//script:deploy.sh) */
  sourceRef: string;
  /** Optional new name for the cloned asset */
  newName?: string;
  /** If true, overwrite existing asset in working stash */
  force?: boolean;
  /** Unmanaged destination directory escape hatch */
  dest?: string;
  /** Configured bundle to receive the managed clone */
  target?: string;
}

export interface CloneResponse {
  source: {
    path: string;
    registryId?: string;
  };
  destination: {
    path: string;
    ref: string;
  };
  overwritten: boolean;
  remoteFetched?: { origin: string; stashRoot: string; cacheDir: string };
}

export async function akmClone(options: CloneOptions): Promise<CloneResponse> {
  const unmanagedDest = options.dest;
  const hasUnmanagedDest = unmanagedDest !== undefined;
  if (hasUnmanagedDest && options.target !== undefined) {
    throw new UsageError("--dest and --target cannot be used together; choose an unmanaged path or a managed bundle.");
  }

  // F1b/F4b: accept the 0.9.0 conceptId spelling (`akm clone scripts/deploy.sh`).
  // F5 origin split (parseQualifiedRefInput): `akm clone` also accepts a NON-slug
  // clone SOURCE as the `origin//conceptId` prefix — a registry ref
  // (`npm:@scope/pkg`), a bare path, or a URL — resolved by
  // resolveSourcesForOrigin's registry-id / path matching + the remote-fetch
  // fallback below (the strict new-grammar parser rejects such origins as they
  // are not bundle slugs).
  const parsed = parseQualifiedRefInput(options.sourceRef);
  const config = hasUnmanagedDest ? undefined : loadConfig();
  const writeTarget = config ? prepareWriteTargetForMutation(resolveWriteTarget(config, options.target)) : undefined;

  // An unmanaged --dest does not require any configured write target.
  let allSources: SearchSource[];
  try {
    allSources = resolveSourceEntries();
  } catch (err) {
    if (hasUnmanagedDest) {
      allSources = [];
    } else {
      throw err;
    }
  }

  const destRoot = unmanagedDest !== undefined ? path.resolve(unmanagedDest) : writeTarget?.source.path;

  if (!destRoot) {
    throw new ConfigError(
      "No writable source configured and no --dest provided. Run `akm init` or pass --dest.",
      "STASH_DIR_NOT_FOUND",
    );
  }

  let searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  // Remote fetch fallback: if no local source matched and origin looks remote, fetch it
  let remoteFetched: CloneResponse["remoteFetched"] | undefined;
  if (searchSources.length === 0 && parsed.origin && isRemoteOrigin(parsed.origin, allSources)) {
    const installResult = await syncFromRef(parsed.origin);
    const syntheticSource: SearchSource = {
      path: installResult.contentDir,
      registryId: installResult.id,
    };
    searchSources = [syntheticSource];
    allSources = [...allSources, syntheticSource];
    remoteFetched = {
      origin: parsed.origin,
      stashRoot: installResult.contentDir,
      cacheDir: installResult.cacheDir,
    };
  }

  let sourcePath: string | undefined;
  let lastError: Error | undefined;
  for (const source of searchSources) {
    try {
      sourcePath = await resolveAssetPath(source.path, parsed.type, parsed.name);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (!sourcePath) {
    if (remoteFetched) {
      throw new NotFoundError(
        `Source asset not found for ref: ${options.sourceRef} (remote package fetched but asset not found inside it)`,
        "ASSET_NOT_FOUND",
        "The remote package was fetched but doesn't contain the requested asset. Check the asset name and type.",
      );
    }
    throw lastError ?? new NotFoundError(`Source asset not found for ref: ${options.sourceRef}`, "ASSET_NOT_FOUND");
  }

  const sourceSource = findSourceForPath(sourcePath, allSources);

  const destName = options.newName ?? parsed.name;
  const typeDir = stashDirFor(parsed.type) as string;

  // Validate destName to prevent path traversal (parsed.name is already
  // validated by the ref parser, but newName comes directly from user input).
  // Run whenever newName is provided, including empty string.
  if (options.newName !== undefined) {
    if (destName === "") {
      throw new UsageError("Clone name must not be empty.");
    }
    const normalized = path.posix.normalize(destName.replace(/\\/g, "/"));
    if (
      path.isAbsolute(destName) ||
      normalized === "." ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      destName.includes("\0")
    ) {
      throw new UsageError(`Unsafe clone name "${destName}": must not contain path traversal or absolute paths.`);
    }
    // Ensure the resolved destination is strictly inside the type directory,
    // not equal to it (which can happen with crafted multi-segment names).
    // path.relative() is used instead of startsWith() for cross-platform safety.
    const destTypeDir = path.resolve(path.join(destRoot, typeDir));
    const resolvedDest = path.resolve(path.join(destRoot, typeDir, destName));
    const rel = path.relative(destTypeDir, resolvedDest);
    if (rel === "" || rel.startsWith("..")) {
      throw new UsageError(`Unsafe clone name "${destName}": resolves outside the target type directory.`);
    }
  }
  const destLabel = hasUnmanagedDest
    ? "at destination"
    : writeTarget?.selector
      ? `in target "${writeTarget.selector}"`
      : "in working stash";

  // Guard against self-clone
  if (parsed.type === "skill") {
    const sourceSkillDir = path.resolve(path.dirname(sourcePath));
    const destSkillDir = path.resolve(path.join(destRoot, typeDir, destName));
    if (sourceSkillDir === destSkillDir) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  } else {
    const resolvedSource = path.resolve(sourcePath);
    const sourceExt = path.extname(sourcePath);
    const effectiveDestName = !path.extname(destName) && sourceExt ? destName + sourceExt : destName;
    const resolvedDest = path.resolve(path.join(destRoot, typeDir, effectiveDestName));
    if (resolvedSource === resolvedDest) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  }

  return withAssetMutationLease("clone", async () => {
    let destPath: string;
    let overwritten: boolean;
    let operationPaths: string[];
    if (parsed.type === "skill") {
      const sourceSkillDir = path.dirname(sourcePath);
      const destSkillDir = path.join(destRoot, typeDir, destName);
      assertNoDestinationSymlinkParent(destRoot, destSkillDir);
      const existing = lstatIfExists(destSkillDir);
      overwritten = existing !== undefined;

      if (overwritten && !options.force) {
        throw new UsageError(
          `Asset already exists ${destLabel}: ${destSkillDir}. Use --force to overwrite.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      const replacedPaths = existing?.isDirectory() && !existing.isSymbolicLink() ? listTreeFiles(destSkillDir) : [];

      // Stage first so a failed source copy leaves the old entry untouched. A
      // final symlink is removed as an entry, never traversed.
      const stagingDir = `${destSkillDir}.tmp-${randomUUID()}`;
      try {
        fs.cpSync(sourceSkillDir, stagingDir, { recursive: true, errorOnExist: true, force: false });
        if (overwritten) fs.rmSync(destSkillDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, destSkillDir);
      } catch (err) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw err;
      }

      destPath = path.join(destSkillDir, "SKILL.md");
      operationPaths = [...new Set([...replacedPaths, ...listTreeFiles(destSkillDir)])];
    } else {
      destPath = path.join(destRoot, typeDir, destName);
      assertNoDestinationSymlinkParent(destRoot, destPath);
      const existing = lstatIfExists(destPath);
      overwritten = existing !== undefined;

      if (overwritten && !options.force) {
        throw new UsageError(
          `Asset already exists ${destLabel}: ${destPath}. Use --force to overwrite.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const stagingPath = `${destPath}.tmp-${randomUUID()}`;
      try {
        fs.copyFileSync(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
        if (overwritten) fs.rmSync(destPath, { recursive: true, force: true });
        fs.renameSync(stagingPath, destPath);
      } catch (err) {
        fs.rmSync(stagingPath, { force: true });
        throw err;
      }
      operationPaths = [destPath];
    }

    const ref = displayRef(
      { type: parsed.type, name: destName, bundleId: writeTarget?.source.name ?? "local" },
      config?.defaultBundle,
    );

    if (writeTarget) {
      const commitRoot = writeTarget.source.repoPath ?? writeTarget.source.path;
      const commitPaths = operationPaths.map((filePath) =>
        path.relative(commitRoot, filePath).replaceAll(path.sep, "/"),
      );
      commitWriteTargetBoundary(writeTarget, `Clone ${ref}`, { paths: commitPaths });
      if (!(await indexWrittenAssets(writeTarget.source.path, [destPath], { bundleId: writeTarget.source.name }))) {
        warn(`Clone ${ref} succeeded, but its targeted index update failed; run \`akm index\` to refresh it.`);
      }
    }

    return {
      source: { path: sourcePath, registryId: sourceSource?.registryId },
      destination: { path: destPath, ref },
      overwritten,
      ...(remoteFetched ? { remoteFetched } : {}),
    };
  });
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertNoDestinationSymlinkParent(root: string, destination: string): void {
  const resolvedRoot = path.resolve(root);
  const relativeParent = path.relative(resolvedRoot, path.dirname(path.resolve(destination)));
  if (relativeParent === "" || relativeParent === ".") return;
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new UsageError(`Clone destination escapes the selected target: ${destination}.`, "PATH_ESCAPE_VIOLATION");
  }

  let current = resolvedRoot;
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    if (lstatIfExists(current)?.isSymbolicLink()) {
      throw new UsageError(
        `Clone destination has a symbolic-link parent outside the selected target boundary: ${current}.`,
        "PATH_ESCAPE_VIOLATION",
      );
    }
  }
}

function listTreeFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTreeFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}
