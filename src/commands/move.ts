// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm move <ref> <dest>` (alias `mv`) — relocate an existing stash asset into
 * a subdirectory under the same type root, then reindex.
 *
 * Issue #504: organize existing stash assets into logical subdirectories. The
 * path layer already accepts slash-bearing asset names (parseAssetRef /
 * validateName permit subpaths with traversal guards; the indexer walks
 * recursively). The missing piece was a user-facing relocation mechanism — not
 * new path plumbing. This command provides exactly that and nothing more (no
 * auto-categorization / LLM bucketing — see #503 for creation-time support).
 *
 * Flow:
 *   1. Parse source ref + destination ref/subpath.
 *   2. Resolve the source on disk, restricted to writable sources only
 *      (registry-cached / read-only sources are refused).
 *   3. Compute the destination path via the same type root + asset-spec, and
 *      verify it stays within the source stash (isWithin) and keeps the same
 *      type root.
 *   4. Refuse if the destination already exists.
 *   5. Move the whole asset unit (directory for skill assets, single file
 *      otherwise) with mkdir -p on the destination parent.
 *   6. Reindex the affected source so `show` / `search` find the new subpath.
 *   7. Fire the single batch-at-boundary commit (#507) when the owning stash is
 *      git-backed, so the rename + reindexed `.akm/` state land as one complete
 *      commit (via `saveGitStash` → `git add -A`) instead of leaving dirty
 *      working-tree residue. No-op for non-git / clean stashes.
 */

import fs from "node:fs";
import path from "node:path";
import { type AssetRef, parseAssetRef } from "../core/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "../core/asset-spec";
import { isWithin } from "../core/common";
import { NotFoundError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { akmIndex } from "../indexer/indexer";
import { resolveAssetPath } from "../indexer/path-resolver";
import { findSourceForPath, getWritableStashDirs, resolveSourceEntries } from "../indexer/search-source";
import { isGitBackedStash, saveGitStash } from "../sources/providers/git";

export interface MoveResult {
  ok: true;
  type: string;
  from: string;
  to: string;
  fromPath: string;
  toPath: string;
  stashDir: string;
}

/**
 * Parse a destination argument. It may be a full ref (`knowledge:personal/guide.md`)
 * or a bare subpath/name (`personal/guide.md`) that inherits the source type.
 */
function resolveDestRef(dest: string, sourceRef: AssetRef): AssetRef {
  const trimmed = dest.trim();
  if (!trimmed) {
    throw new UsageError("Empty destination.", "MISSING_REQUIRED_ARGUMENT");
  }
  // A leading `type:` (before any `/`) marks a full ref. We look for a colon
  // that occurs before the first slash so subpaths like `team:a/b` are still
  // treated as refs while `a/b/c.md` is treated as a bare name.
  const colon = trimmed.indexOf(":");
  const slash = trimmed.indexOf("/");
  const looksLikeRef = colon > 0 && (slash === -1 || colon < slash);
  if (looksLikeRef) {
    return parseAssetRef(trimmed);
  }
  // Bare subpath — reuse the source type and parse through the same validator
  // so traversal / absolute / drive-letter guards apply uniformly.
  return parseAssetRef(`${sourceRef.type}:${trimmed}`);
}

/**
 * Move the on-disk unit for an asset. For directory-style assets (skill
 * `SKILL.md`) the unit is the directory that contains the resolved file; for
 * single-file assets it is the file itself. Returns the source/destination
 * paths actually moved.
 */
function moveAssetUnit(args: { type: string; resolvedSourceFile: string; typeRoot: string; destFilePath: string }): {
  fromUnit: string;
  toUnit: string;
} {
  const { type, resolvedSourceFile, typeRoot, destFilePath } = args;

  // Determine whether the asset is stored as a directory unit. The skill spec
  // resolves to `<typeRoot>/<name>/SKILL.md`; the unit to move is the parent
  // directory. All other built-in types are single files at the resolved path.
  const isDirectoryUnit = type === "skill";

  const fromUnit = isDirectoryUnit ? path.dirname(resolvedSourceFile) : resolvedSourceFile;
  const toUnit = isDirectoryUnit ? path.dirname(destFilePath) : destFilePath;

  // Guard against a no-op / overlapping move that would clobber the source.
  if (path.resolve(fromUnit) === path.resolve(toUnit)) {
    throw new UsageError("Destination is the same as the source; nothing to move.", "INVALID_FLAG_VALUE");
  }

  if (fs.existsSync(toUnit)) {
    throw new UsageError(`Destination already exists: ${toUnit}. Refusing to overwrite.`, "RESOURCE_ALREADY_EXISTS");
  }

  // Keep the moved unit inside the type root so a destination directory can
  // never escape via the directory-unit dirname computation.
  if (!isWithin(toUnit, typeRoot) && path.resolve(toUnit) !== path.resolve(typeRoot)) {
    throw new UsageError("Destination escapes the asset type root.", "PATH_ESCAPE_VIOLATION");
  }

  fs.mkdirSync(path.dirname(toUnit), { recursive: true });
  fs.renameSync(fromUnit, toUnit);
  return { fromUnit, toUnit };
}

/**
 * Relocate an existing asset to a new name/subpath under the same type root.
 */
export async function akmMove(input: { ref: string; dest: string }): Promise<MoveResult> {
  const sourceRef = parseAssetRef(input.ref);
  const destRef = resolveDestRef(input.dest, sourceRef);

  // (1) Destination must keep the same type root — a move never changes type.
  if (destRef.type !== sourceRef.type) {
    throw new UsageError(
      `Move cannot change asset type (${sourceRef.type} -> ${destRef.type}). ` +
        "The destination must stay under the same type root.",
      "INVALID_FLAG_VALUE",
    );
  }

  // (2) Resolve the source on disk, restricted to writable sources. This both
  //     refuses moves out of read-only / registry-cached sources and ensures
  //     we operate on the actual file rather than an index row.
  const writableDirSet = new Set(getWritableStashDirs().map((d) => path.resolve(d)));
  const resolvedSourceFile = await resolveAssetPath(sourceRef, {
    mode: "disk-only",
    writableDirSet,
  });
  if (!resolvedSourceFile) {
    // Distinguish "exists but read-only" from "absent" for a clearer message.
    const anywhere = await resolveAssetPath(sourceRef, { mode: "disk-only" });
    if (anywhere) {
      throw new UsageError(
        `Asset "${sourceRef.type}:${sourceRef.name}" lives in a read-only source and cannot be moved. ` +
          "Only assets in a writable stash can be relocated.",
        "INVALID_FLAG_VALUE",
      );
    }
    throw new NotFoundError(
      `Asset not found for ref: ${sourceRef.type}:${sourceRef.name}. ` +
        "Check the name with `akm search` or verify the asset exists in a writable stash.",
    );
  }

  // (3) Determine the owning source root and recompute both type roots there.
  const allSources = resolveSourceEntries();
  const source = findSourceForPath(resolvedSourceFile, allSources);
  if (!source || source.writable !== true) {
    throw new UsageError(
      `Asset "${sourceRef.type}:${sourceRef.name}" is not in a writable stash and cannot be moved.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const stashDir = source.path;
  const typeRoot = path.join(stashDir, TYPE_DIRS[sourceRef.type] ?? `${sourceRef.type}s`);

  const destFilePath = resolveAssetPathFromName(destRef.type, typeRoot, destRef.name);
  if (!isWithin(destFilePath, typeRoot)) {
    throw new UsageError(
      `Resolved destination path escapes its type root: "${destRef.name}".`,
      "PATH_ESCAPE_VIOLATION",
    );
  }

  const { fromUnit, toUnit } = moveAssetUnit({
    type: sourceRef.type,
    resolvedSourceFile,
    typeRoot,
    destFilePath,
  });

  // (4) Reindex the affected source so show/search resolve the new subpath and
  //     drop the old one. A full reindex is the simplest correct option: the
  //     move both adds a new path and removes the old one, and staleness
  //     detection alone only notices newer files.
  await akmIndex({ stashDir });

  // (5) Single batch-at-boundary commit (#507). When the owning stash is a git
  //     repo, stage the rename + reindexed `.akm/` state together as one commit
  //     via the same `saveGitStash` path `akm sync` / improve auto-sync use —
  //     NOT the retired per-asset commit. `saveGitStash` is a no-op for non-git
  //     stashes and for a clean tree, and gates any push on writable + remote.
  if (isGitBackedStash(stashDir)) {
    saveGitStash(undefined, `Move ${sourceRef.type}:${sourceRef.name} -> ${destRef.type}:${destRef.name}`, true, {
      repoDir: stashDir,
    });
  }

  const result: MoveResult = {
    ok: true,
    type: sourceRef.type,
    from: `${sourceRef.type}:${sourceRef.name}`,
    to: `${destRef.type}:${destRef.name}`,
    fromPath: fromUnit,
    toPath: toUnit,
    stashDir,
  };

  appendEvent({
    eventType: "move",
    ref: result.to,
    metadata: { from: result.from, to: result.to, type: result.type },
  });

  return result;
}
