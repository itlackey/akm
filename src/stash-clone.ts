import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "./asset-spec";
import { isRemoteOrigin, resolveSourcesForOrigin } from "./origin-resolve";
import { installRegistryRef } from "./registry-install";
import { makeAssetRef, parseAssetRef } from "./stash-ref";
import { resolveAssetPath } from "./stash-resolve";
import { findSourceForPath, getPrimarySource, resolveStashSources, type StashSource } from "./stash-source";

export interface CloneOptions {
  /** Source ref (e.g., npm:@scope/pkg//script:deploy.sh) */
  sourceRef: string;
  /** Optional new name for the cloned asset */
  newName?: string;
  /** If true, overwrite existing asset in working stash */
  force?: boolean;
  /** Destination directory (default: working stash) */
  dest?: string;
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

export async function agentikitClone(options: CloneOptions): Promise<CloneResponse> {
  const parsed = parseAssetRef(options.sourceRef);

  // When --dest is provided, the working stash is optional
  let allSources: StashSource[];
  try {
    allSources = resolveStashSources();
  } catch (err) {
    if (options.dest) {
      allSources = [];
    } else {
      throw err;
    }
  }

  const primarySource = getPrimarySource(allSources);
  const destRoot = options.dest ? path.resolve(options.dest) : primarySource?.path;

  if (!destRoot) {
    throw new Error("No working stash configured and no --dest provided. Run `akm init` or pass --dest.");
  }

  let searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  // Remote fetch fallback: if no local source matched and origin looks remote, fetch it
  let remoteFetched: CloneResponse["remoteFetched"] | undefined;
  if (searchSources.length === 0 && parsed.origin && isRemoteOrigin(parsed.origin, allSources)) {
    const installResult = await installRegistryRef(parsed.origin);
    const syntheticSource: StashSource = {
      path: installResult.stashRoot,
      registryId: installResult.id,
    };
    searchSources = [syntheticSource];
    allSources = [...allSources, syntheticSource];
    remoteFetched = {
      origin: parsed.origin,
      stashRoot: installResult.stashRoot,
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
    const context = remoteFetched ? ` (remote package fetched but asset not found inside it)` : "";
    throw lastError ?? new Error(`Source asset not found for ref: ${options.sourceRef}${context}`);
  }

  const sourceSource = findSourceForPath(sourcePath, allSources);

  const destName = options.newName ?? parsed.name;
  const typeDir = TYPE_DIRS[parsed.type];
  const destLabel = options.dest ? "at destination" : "in working stash";

  // Guard against self-clone
  if (parsed.type === "skill") {
    const sourceSkillDir = path.resolve(path.dirname(sourcePath));
    const destSkillDir = path.resolve(path.join(destRoot, typeDir, destName));
    if (sourceSkillDir === destSkillDir) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  } else {
    const resolvedSource = path.resolve(sourcePath);
    const resolvedDest = path.resolve(path.join(destRoot, typeDir, destName));
    if (resolvedSource === resolvedDest) {
      throw new Error(`Source and destination are the same path. Use --name to provide a new name for the clone.`);
    }
  }

  let destPath: string;
  if (parsed.type === "skill") {
    const sourceSkillDir = path.dirname(sourcePath);
    const destSkillDir = path.join(destRoot, typeDir, destName);
    const overwritten = fs.existsSync(destSkillDir);

    if (overwritten && !options.force) {
      throw new Error(`Asset already exists ${destLabel}: ${destSkillDir}. Use --force to overwrite.`);
    }

    if (overwritten) {
      fs.rmSync(destSkillDir, { recursive: true, force: true });
    }
    fs.cpSync(sourceSkillDir, destSkillDir, { recursive: true });

    destPath = path.join(destSkillDir, "SKILL.md");
    const ref = makeAssetRef(parsed.type, destName, "local");

    return {
      source: { path: sourcePath, registryId: sourceSource?.registryId },
      destination: { path: destPath, ref },
      overwritten,
      ...(remoteFetched ? { remoteFetched } : {}),
    };
  }

  destPath = path.join(destRoot, typeDir, destName);
  const overwritten = fs.existsSync(destPath);

  if (overwritten && !options.force) {
    throw new Error(`Asset already exists ${destLabel}: ${destPath}. Use --force to overwrite.`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);

  const ref = makeAssetRef(parsed.type, destName, "local");

  return {
    source: { path: sourcePath, registryId: sourceSource?.registryId },
    destination: { path: destPath, ref },
    overwritten,
    ...(remoteFetched ? { remoteFetched } : {}),
  };
}
