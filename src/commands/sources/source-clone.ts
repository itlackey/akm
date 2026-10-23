// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { adapterForId } from "../../core/adapter/registry";
import { placementSpecFor, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug } from "../../core/asset/asset-ref";
import { serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter, replaceFrontmatterBlocks } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, displayRef, parseQualifiedRefInput } from "../../core/asset/resolve-ref";
import { isWithin } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { defaultBundleForTarget } from "../../core/mutation-target";
import { warn } from "../../core/warn";
import {
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWriteTarget,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { resolveAdapterConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { findSourceForPath, resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { buildFileContext } from "../../indexer/walk/file-context";
import { isRemoteOrigin, resolveSourcesForLocator, resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
import { resolveAssetPath } from "../../sources/resolve";
import { inferAssetName } from "../read/knowledge";

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
    ref?: string;
  };
  overwritten: boolean;
  remoteFetched?: { origin: string; stashRoot: string; cacheDir: string };
}

function destinationRef(
  config: ReturnType<typeof loadConfig> | undefined,
  target: ResolvedWriteTarget | undefined,
  type: string,
  name: string,
): string | undefined {
  if (!config || !target) return undefined;
  return displayRef({ type, name, bundleId: target.source.name }, defaultBundleForTarget(config));
}

export async function akmClone(options: CloneOptions): Promise<CloneResponse> {
  const unmanagedDest = options.dest;
  const hasUnmanagedDest = unmanagedDest !== undefined;
  if (hasUnmanagedDest && options.target !== undefined) {
    throw new UsageError("--dest and --bundle cannot be used together; choose an unmanaged path or a managed bundle.");
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
  const resolvedWriteTarget = config ? resolveWriteTarget(config, options.target, { flag: "--bundle" }) : undefined;
  const writeTarget = resolvedWriteTarget ? prepareWriteTargetForMutation(resolvedWriteTarget) : undefined;

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
      "No writable source configured and no --dest provided. Run `akm bundle create` or pass --dest.",
      "STASH_DIR_NOT_FOUND",
    );
  }

  let searchSources =
    parsed.origin && !isBundleSlug(parsed.origin)
      ? resolveSourcesForLocator(parsed.origin, allSources)
      : resolveSourcesForOrigin(parsed.origin, allSources);

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

  // A ref whose conceptId is not under a known type directory (a flat skill
  // repo, a website or wiki page) is opaque: its source and type come from the
  // adapter that owns the concept, not from the shape of the ref.
  const known = placementSpecFor(parsed.type) !== undefined;
  let sourcePath: string | undefined;
  let opaqueType: string | undefined;
  let lastError: Error | undefined;
  for (const source of searchSources) {
    try {
      if (known) {
        sourcePath = await resolveAssetPath(source.path, parsed.type, parsed.name);
      } else {
        const owned = resolveOpaqueAsset(source, parsed.name);
        if (!owned) throw new NotFoundError(`Source asset not found for ref: ${options.sourceRef}`, "ASSET_NOT_FOUND");
        sourcePath = owned.path;
        opaqueType = owned.type;
      }
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

  // Where the clone lands: a known-type ref keeps its type and name; an opaque
  // one is placed by what the source file is.
  const sourceExt = path.extname(sourcePath);
  const cloneType = known ? parsed.type : placementTypeForOpaque(options.sourceRef, sourcePath, opaqueType);
  const defaultName = known ? parsed.name : slugName(parsed.name);
  const destName = options.newName ?? defaultName;
  const typeDir = stashDirFor(cloneType) as string;
  // A ref's name often omits its extension (`knowledge/<name>` names `<name>.md`), and an opaque one is a slug:
  // either way the copy keeps the source file's extension, or it would be written as a file the index ignores.
  const destFileName = path.extname(destName) ? destName : destName + sourceExt;
  const isSkill = cloneType === "skill";
  // A concept id is the path without its markdown extension.
  const originConceptId = (known ? conceptIdFromTypeName(parsed.type, parsed.name) : parsed.name).replace(/\.md$/i, "");
  const originRef = sourceSource?.registryId ? `${sourceSource.registryId}//${originConceptId}` : undefined;

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
  if (isSkill) {
    const sourceSkillDir = path.resolve(path.dirname(sourcePath));
    const destSkillDir = path.resolve(path.join(destRoot, typeDir, destName));
    if (sourceSkillDir === destSkillDir) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  } else {
    const resolvedSource = path.resolve(sourcePath);
    const effectiveDestName = !path.extname(destFileName) && sourceExt ? destFileName + sourceExt : destFileName;
    const resolvedDest = path.resolve(path.join(destRoot, typeDir, effectiveDestName));
    if (resolvedSource === resolvedDest) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  }

  return withAssetMutationLease("clone", async () => {
    let destPath: string;
    let overwritten: boolean;
    let operationPaths: string[];
    if (isSkill) {
      // sourcePath is the authored path; a symlinked skill directory must be
      // copied by content, never as the link.
      const sourceSkillDir = fs.realpathSync(path.dirname(sourcePath));
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
        stampCloneOrigin(path.join(stagingDir, "SKILL.md"), originRef);
        if (overwritten) fs.rmSync(destSkillDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, destSkillDir);
      } catch (err) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw err;
      }

      destPath = path.join(destSkillDir, "SKILL.md");
      operationPaths = [...new Set([...replacedPaths, ...listTreeFiles(destSkillDir)])];
    } else {
      destPath = path.join(destRoot, typeDir, destFileName);
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
        if (cloneType !== "workflow" && sourceExt.toLowerCase() === ".md") stampCloneOrigin(stagingPath, originRef);
        if (overwritten) fs.rmSync(destPath, { recursive: true, force: true });
        fs.renameSync(stagingPath, destPath);
      } catch (err) {
        fs.rmSync(stagingPath, { force: true });
        throw err;
      }
      operationPaths = [destPath];
    }

    const ref = destinationRef(config, writeTarget, cloneType, destName);

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
      destination: { path: destPath, ...(ref ? { ref } : {}) },
      overwritten,
      ...(remoteFetched ? { remoteFetched } : {}),
    };
  });
}

/**
 * Find an opaque concept (one whose id is not under a known type directory) in
 * a source through the adapter that owns it, and name the type that adapter
 * recognizes the file as. The same ownership + recognition `akm show` and the
 * index use, so a clone sees exactly the file the index holds for the ref.
 */
function resolveOpaqueAsset(source: SearchSource, conceptId: string): { path: string; type?: string } | undefined {
  const adapterId = source.adapterId ?? detectAdapterId(source.path);
  const owner = resolveAdapterConceptOwner(source.path, adapterId, conceptId, { mode: "read" });
  if (!owner) return undefined;
  let type: string | undefined;
  try {
    const component = { id: adapterId, adapter: adapterId, root: source.path, writable: false };
    type = adapterForId(adapterId)?.recognize(component, buildFileContext(source.path, owner.path))?.type;
  } catch {
    // An adapter that cannot recognize the file leaves its type unknown.
  }
  return { path: owner.realPath, type };
}

/**
 * Where an opaque asset is cloned: a skill (SKILL.md) as a directory under
 * `skills/`, any other recognized placement type under its own directory, and
 * markdown of an unknown type (a website or wiki page, a flat doc) as
 * `knowledge/`. Anything else cannot be placed.
 */
function placementTypeForOpaque(sourceRef: string, sourcePath: string, indexedType: string | undefined): string {
  if (indexedType === "skill" && path.basename(sourcePath) === "SKILL.md") return "skill";
  if (indexedType !== undefined && indexedType !== "skill" && placementSpecFor(indexedType) !== undefined) {
    return indexedType;
  }
  if (path.extname(sourcePath).toLowerCase() === ".md") return "knowledge";
  throw new UsageError(
    `cannot clone ${sourceRef}: its type${indexedType ? ` "${indexedType}"` : ""} has no place in a bundle and ` +
      `${path.basename(sourcePath)} is not markdown; use \`akm import <path>\` or copy the file.`,
  );
}

/** Clone name of an opaque asset: the last segment of its concept id, slugified like every other asset name. */
function slugName(conceptId: string): string {
  const last = conceptId.split("/").pop() ?? conceptId;
  const stem = last.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return inferAssetName("", "clone", stem);
}

/**
 * Record where a cloned markdown asset came from by merging the origin ref into
 * its `sources:` frontmatter. `sources:` is free-form provenance that `akm lint` does
 * not resolve, unlike `xrefs:`: the origin bundle is often not installed where the
 * clone is read (a shared domain bundle), and an `xrefs:` entry would be reported as
 * a missing ref there. Only the `sources` block is rewritten; every other
 * byte stays as written. A file whose frontmatter cannot be edited that way
 * (and still parse back to exactly the intended mapping) is left untouched.
 */
function stampCloneOrigin(filePath: string, originRef: string | undefined): void {
  if (!originRef) return;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const existing = parsed.data.sources;
  const prior = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
  if (existing !== undefined && prior.length === 0) return;
  if (prior.includes(originRef)) return;
  const sources = [...prior, originRef];
  let next: string | null;
  if (parsed.frontmatter === null) {
    next = `---\n${serializeFrontmatter({ sources })}\n---\n${raw}`;
  } else {
    next = replaceFrontmatterBlocks(raw, ["sources"], serializeFrontmatter({ sources }).split("\n"));
    if (next === null || !isDeepStrictEqual(parseFrontmatter(next).data, { ...parsed.data, sources })) return;
  }
  fs.writeFileSync(filePath, next);
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
  const parentDir = path.dirname(path.resolve(destination));
  const relativeParent = path.relative(resolvedRoot, parentDir);
  if (relativeParent === "" || relativeParent === ".") return;
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new UsageError(`Clone destination escapes the selected target: ${destination}.`, "PATH_ESCAPE_VIOLATION");
  }

  if (!isWithin(parentDir, resolvedRoot)) {
    throw new UsageError(
      `Clone destination has a symbolic-link parent outside the selected target boundary: ${parentDir}.`,
      "PATH_ESCAPE_VIOLATION",
    );
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
