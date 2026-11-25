// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PackageFile } from "../../core/adapter/bundle-adapter";
import { placementSpecFor, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug, makeBundleRef } from "../../core/asset/asset-ref";
import { serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter, replaceFrontmatterBlocks } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, displayRef, parseQualifiedPlacementRef } from "../../core/asset/resolve-ref";
import { bundleNameOf } from "../../core/assets/gate";
import { type Asset, assetAtKey, findAsset, packageFilesAt } from "../../core/assets/read";
import { assetTypeFresh, embedPendingWrites, indexedPathOf } from "../../core/assets/type";
import { writeAssets } from "../../core/assets/write";
import { bundleAt } from "../../core/bundle-at-dir";
import { isWithin, relativeToRoot, safeRealpath } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { defaultBundleForTarget } from "../../core/mutation-target";
import { prepareWriteTargetForMutation, type ResolvedWriteTarget, resolveWriteTarget } from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { findSourceForPath, resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { isRemoteOrigin, resolveSourcesForLocator, resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { syncFromRef } from "../../sources/providers/sync-from-ref";
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
  return displayRef(
    { conceptId: conceptIdFromTypeName(type, name), bundleId: target.source.name },
    defaultBundleForTarget(config),
  );
}

export async function akmClone(options: CloneOptions): Promise<CloneResponse> {
  const unmanagedDest = options.dest;
  const hasUnmanagedDest = unmanagedDest !== undefined;
  if (hasUnmanagedDest && options.target !== undefined) {
    throw new UsageError("--dest and --bundle cannot be used together; choose an unmanaged path or a managed bundle.");
  }

  // F1b/F4b: accept the conceptId spelling (`akm clone scripts/deploy.sh`).
  // F5 origin split (parseQualifiedPlacementRef): `akm clone` also accepts a NON-slug
  // clone SOURCE as the `origin//conceptId` prefix — a registry ref
  // (`npm:@scope/pkg`), a bare path, or a URL — resolved by
  // resolveSourcesForOrigin's registry-id / path matching + the remote-fetch
  // fallback below (the strict new-grammar parser rejects such origins as they
  // are not bundle slugs).
  const parsed = parseQualifiedPlacementRef(options.sourceRef);
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
        sourcePath = heldFile(source, conceptIdFromTypeName(parsed.type, parsed.name))?.file;
        if (!sourcePath)
          throw new NotFoundError(`Source asset not found for ref: ${options.sourceRef}`, "ASSET_NOT_FOUND");
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

  // Guard against self-clone. Compare physical paths: sourcePath is the
  // authored path, and a source that is a symlink to the destination is the
  // same file (or skill) even though the authored paths differ.
  if (isSkill) {
    const sourceSkillDir = safeRealpath(path.dirname(sourcePath));
    const destSkillDir = safeRealpath(path.join(destRoot, typeDir, destName));
    if (sourceSkillDir === destSkillDir) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  } else {
    const resolvedSource = safeRealpath(sourcePath);
    const effectiveDestName = !path.extname(destFileName) && sourceExt ? destFileName + sourceExt : destFileName;
    const resolvedDest = safeRealpath(path.join(destRoot, typeDir, effectiveDestName));
    if (resolvedSource === resolvedDest) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  }

  // The source, read through the bundle it is in: a package whole, non-asset files included (§0.2 P12).
  const sourceKey = sourceSource ? relativeToRoot(sourcePath, sourceSource.path) : undefined;
  if (!sourceSource || !sourceKey) {
    throw new NotFoundError(`Source asset not found for ref: ${options.sourceRef}`, "ASSET_NOT_FOUND");
  }
  const sourceBundle = bundleAt(sourceSource.path);
  const key = sourceKey.split(path.sep).join("/");
  const stampMarkdown = (bytes: Buffer): Buffer => {
    const stamped = stampedOrigin(bytes.toString("utf8"), originRef);
    return stamped === undefined ? bytes : Buffer.from(stamped);
  };
  const files = isSkill
    ? packageFilesAt(sourceBundle, key).map((file) =>
        file.path === "SKILL.md" ? { ...file, bytes: stampMarkdown(file.bytes) } : file,
      )
    : [];
  const sourceEntry = isSkill ? undefined : assetAtKey(sourceBundle, key)?.entry;
  const sourceBytes = sourceEntry?.bytes();
  const sourceMode = sourceEntry?.mode?.();
  if (!isSkill && !sourceBytes) {
    throw new NotFoundError(`Source asset not found for ref: ${options.sourceRef}`, "ASSET_NOT_FOUND");
  }
  const content =
    sourceBytes && cloneType !== "workflow" && sourceExt.toLowerCase() === ".md"
      ? stampMarkdown(sourceBytes)
      : (sourceBytes ?? Buffer.alloc(0));
  const refused = (at: string): UsageError =>
    new UsageError(`Asset already exists ${destLabel}: ${at}. Use --force to overwrite.`, "RESOURCE_ALREADY_EXISTS");

  const response = await withAssetMutationLease("clone", async () => {
    const ref = destinationRef(config, writeTarget, cloneType, destName);
    const name = isSkill ? destName : destFileName;
    const unplaced = path.join(destRoot, typeDir, isSkill ? path.join(destName, "SKILL.md") : destFileName);
    let destPath = unplaced;
    let overwritten: boolean;
    if (!writeTarget) {
      // `--dest`: a directory the user named, outside every bundle: no adapter places, no index row follows.
      overwritten = copyUnmanaged(destRoot, unplaced, isSkill ? files : content, sourceMode, {
        force: options.force === true,
        refused,
      });
    } else {
      assertNoDestinationSymlinkParent(destRoot, isSkill ? path.dirname(unplaced) : unplaced);
      let held = false;
      writeAssets(writeTarget, { purpose: "clone", message: `Clone ${ref}` }, (w) => {
        const placed = w.address(conceptIdFromTypeName(cloneType, name));
        destPath = placed.file ?? unplaced;
        held = placed.exists;
        if (held && !options.force) throw refused(isSkill ? path.dirname(destPath) : destPath);
        if (isSkill) {
          try {
            w.mirrorPackage({ type: cloneType, name }, files, { replace: options.force === true });
          } catch (error) {
            // A folder without SKILL.md is no asset to the check above; the refusal is still today's.
            if (error instanceof UsageError && error.code === "RESOURCE_ALREADY_EXISTS") {
              throw refused(path.dirname(destPath));
            }
            throw error;
          }
        } else
          w.create(
            { type: cloneType, name, content, ...(sourceMode !== undefined ? { mode: sourceMode } : {}) },
            { exclusive: !options.force, verbatim: true },
          );
      });
      overwritten = held;
    }

    return {
      source: { path: sourcePath, registryId: sourceSource?.registryId },
      destination: { path: destPath, ...(ref ? { ref } : {}) },
      overwritten,
      ...(remoteFetched ? { remoteFetched } : {}),
    };
  });
  // The write recorded the clone's rows; their vectors are made now, fail-open, after the lease is released.
  await embedPendingWrites();
  return response;
}

/**
 * `--dest`: write the clone into a directory the user named, which is no bundle (no adapter places the file, no index
 * row follows). A package is staged as a folder and swapped in for the old one, so a failure leaves the old one; a file
 * is staged beside its target. Says whether it replaced something.
 */
function copyUnmanaged(
  destRoot: string,
  entryPath: string,
  what: PackageFile[] | Buffer,
  mode: number | undefined,
  options: { force: boolean; refused: (at: string) => UsageError },
): boolean {
  const target = Array.isArray(what) ? path.dirname(entryPath) : entryPath;
  assertNoDestinationSymlinkParent(destRoot, target);
  const existing = lstatIfExists(target);
  if (existing && !options.force) throw options.refused(target);
  const staging = `${target}.tmp-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true }); // asset-io: user-input
    if (Array.isArray(what)) {
      for (const file of what) {
        const at = path.join(staging, file.path);
        fs.mkdirSync(path.dirname(at), { recursive: true }); // asset-io: user-input
        if (file.link !== undefined) {
          fs.symlinkSync(file.link, at, "dir"); // asset-io: user-input
          continue;
        }
        fs.writeFileSync(at, file.bytes, { mode: file.mode }); // asset-io: user-input
        fs.chmodSync(at, file.mode); // asset-io: user-input
      }
    } else {
      fs.writeFileSync(staging, what, { flag: "wx", mode }); // asset-io: user-input
      if (mode !== undefined) fs.chmodSync(staging, mode); // asset-io: user-input
    }
    // A final symlink is removed as an entry, never traversed.
    if (existing) fs.rmSync(target, { recursive: true, force: true }); // asset-io: user-input
    fs.renameSync(staging, target); // asset-io: user-input
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true }); // asset-io: user-input
    throw error;
  }
  return existing !== undefined;
}

/**
 * `raw` with the origin ref merged into its `sources:` frontmatter, or undefined when it is to stay as written. `sources:`
 * is free-form provenance that `akm lint` does not resolve, unlike `xrefs:`: the origin bundle is often not installed
 * where the clone is read (a shared domain bundle), and an `xrefs:` entry would be reported as a missing ref there. Only
 * the `sources` block is rewritten; every other byte stays as written. A file whose frontmatter cannot be edited that
 * way (and still parse back to exactly the intended mapping) is left untouched.
 */
export function stampedOrigin(raw: string, originRef: string | undefined): string | undefined {
  if (!originRef) return undefined;
  const parsed = parseFrontmatter(raw);
  const existing = parsed.data.sources;
  const prior = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
  if (existing !== undefined && prior.length === 0) return undefined;
  if (prior.includes(originRef)) return undefined;
  const sources = [...prior, originRef];
  if (parsed.frontmatter === null) return `---\n${serializeFrontmatter({ sources })}\n---\n${raw}`;
  const next = replaceFrontmatterBlocks(raw, ["sources"], serializeFrontmatter({ sources }).split("\n"));
  if (next === null || !isDeepStrictEqual(parseFrontmatter(next).data, { ...parsed.data, sources })) return undefined;
  return next;
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath); // asset-io: user-input
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The asset `conceptId` names in the bundle at `source`, and the file that holds it as authored (not a link's target). */
function heldFile(source: SearchSource, conceptId: string): { asset: Asset; file: string } | undefined {
  const bundle = bundleAt(source.path);
  const ref = makeBundleRef(bundleNameOf(bundle), conceptId);
  const asset = findAsset(ref, bundle);
  const file = asset ? indexedPathOf(asset) : "";
  return asset && file ? { asset, file } : undefined;
}

/**
 * Find an opaque concept (one whose id is not under a known type directory) in
 * a source through the adapter that owns it, and name the type that adapter
 * recognizes the file as. The same ownership + recognition `akm show` and the
 * index use, so a clone sees exactly the file the index holds for the ref.
 */
function resolveOpaqueAsset(source: SearchSource, conceptId: string): { path: string; type?: string } | undefined {
  const held = heldFile(source, conceptId);
  return held ? { path: safeRealpath(held.file), type: assetTypeFresh(held.asset) } : undefined;
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

export function assertNoDestinationSymlinkParent(root: string, destination: string): void {
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
