// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Copy a file or folder of a bundle to a folder of a bundle (the same or another), the way a file manager does and with
 * what akm's clone adds to a bare copy: the work is staged beside the destination and renamed into place (a failed copy
 * leaves nothing), file links are copied by content and never leave the bundle, the asset-mutation lease and the Git
 * boundary commit apply, the copy is indexed, and a Markdown asset records where it came from in its `sources`. The
 * destination is a folder the person chose, so the copy is a new file wherever it lands; nothing is overwritten.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertNoDestinationSymlinkParent,
  listTreeFiles,
  materializeFileLinks,
  stampCloneOrigin,
} from "../commands/sources/source-clone";
import { managedFolderOf, protectedTypeOf } from "../core/adapter/directory/place-rules";
import { assertFlatAssetName, normalizeCreateSubPath } from "../core/asset/asset-create";
import { indexFiles } from "../core/assets/files";
import { isWithin, safeRealpath } from "../core/common";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { resolveBundleWriteTarget } from "../core/mutation-target";
import { assertPlainWritable, commitWriteTargetBoundary, prepareWriteTargetForMutation } from "../core/write-source";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAssetRefsForFiles } from "../storage/repositories/index-entries-repository";
import { folderBlocker, plainWriteBlocker } from "./file-actions";
import { interactive } from "./lease";

export interface CopyEntryInput {
  bundle: string;
  /** The file or folder, relative to the bundle. */
  from: string;
  /** The bundle that receives the copy; the same bundle when absent. */
  toBundle?: string;
  /** The folder of that bundle the copy goes in; its root when absent. */
  folder?: string;
  /** The name of the copy in that folder. */
  name: string;
}

const text = (value: unknown, key: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${key} is required.`);
  return value.trim();
};

/** The ref of the one asset the index holds for a Markdown file, or undefined. */
function originOf(bundle: string, file: string): string | undefined {
  if (!file.toLowerCase().endsWith(".md")) return undefined;
  const db = openReadonlyExistingDatabase();
  if (!db) return undefined;
  try {
    const found = getAssetRefsForFiles(db, [file], bundle).get(file) ?? [];
    return found.length === 1 && found[0]?.type !== "workflow" ? found[0]?.ref : undefined;
  } finally {
    closeDatabase(db);
  }
}

function isSkillManifest(bundle: string, file: string): boolean {
  const db = openReadonlyExistingDatabase();
  if (!db) return false;
  try {
    return (getAssetRefsForFiles(db, [file], bundle).get(file) ?? []).some((asset) => asset.type === "skill");
  } finally {
    closeDatabase(db);
  }
}

export async function copyEntry(input: CopyEntryInput) {
  const bundle = text(input.bundle, "bundle");
  let from = text(input.from, "from");
  const toBundle = input.toBundle === undefined ? bundle : text(input.toBundle, "toBundle");
  const name = text(input.name, "name");
  assertFlatAssetName(name);
  if (name === "." || name === ".." || name.includes("\0")) throw new UsageError(`"${name}" is not a file name.`);
  const folder = normalizeCreateSubPath(input.folder);
  if (path.posix.isAbsolute(from) || from.split("/").includes(".."))
    throw new UsageError("Use a path inside the bundle.");
  if (protectedTypeOf(from) !== undefined || managedFolderOf(from) !== undefined)
    throw new UsageError("Env and secret files and the folders akm manages are not copied.");
  const config = loadConfig();
  const blocker = folderBlocker(folder) ?? plainWriteBlocker(config, toBundle);
  if (blocker !== null) throw new UsageError(blocker);
  const sourceRoot = resolveSourceEntries(undefined, config).find(
    (entry) => entry.registryId === bundle && !entry.unresolved,
  )?.path;
  if (!sourceRoot) throw new UsageError(`Bundle "${bundle}" is disabled or unavailable.`);
  // A skill's manifest is not a skill: it copies as the skill's folder, the rule `move` states for the same file.
  if (path.posix.basename(from) === "SKILL.md" && isSkillManifest(bundle, path.join(sourceRoot, from)))
    from = path.posix.dirname(from);
  const absolute = path.join(sourceRoot, from);
  if (!isWithin(safeRealpath(absolute), safeRealpath(sourceRoot)))
    throw new UsageError("The file must stay inside its bundle.", "PATH_ESCAPE_VIOLATION");
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat || !(stat.isFile() || stat.isDirectory())) throw new UsageError("Choose a file or a folder to copy.");

  return interactive("ui-file-copy", async () => {
    const resolved = resolveBundleWriteTarget(config, toBundle, { requireWritable: true });
    const target = prepareWriteTargetForMutation(resolved, { plain: true });
    assertPlainWritable(target.source, target.config);
    const root = target.source.path;
    const destination = path.join(root, folder, name);
    if (!isWithin(destination, root))
      throw new UsageError(`"${name}" resolves outside the bundle.`, "PATH_ESCAPE_VIOLATION");
    assertNoDestinationSymlinkParent(root, destination);
    if (fs.lstatSync(destination, { throwIfNoEntry: false }) !== undefined)
      throw new UsageError("That file name is already used in this folder.", "RESOURCE_ALREADY_EXISTS");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = `${destination}.tmp-${randomUUID()}`;
    try {
      if (stat.isDirectory()) {
        fs.cpSync(absolute, staging, { recursive: true, errorOnExist: true, force: false });
        materializeFileLinks(staging);
        // A skill is its folder: its SKILL.md records where it came from.
        const manifest = path.join(absolute, "SKILL.md");
        if (fs.existsSync(manifest)) stampCloneOrigin(path.join(staging, "SKILL.md"), originOf(bundle, manifest));
      } else {
        fs.copyFileSync(absolute, staging, fs.constants.COPYFILE_EXCL);
        stampCloneOrigin(staging, originOf(bundle, absolute));
      }
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    const files = stat.isDirectory() ? listTreeFiles(destination) : [destination];
    const commitRoot = target.source.repoPath ?? root;
    const to = path.posix.join(folder, name);
    commitWriteTargetBoundary(target, `Copy ${bundle}//${from} to ${toBundle}//${to}`, {
      paths: files.map((file) => path.relative(commitRoot, file).replaceAll(path.sep, "/")),
    });
    const indexed = await indexFiles(toBundle, files);
    return { bundle, from, toBundle, to, indexed };
  });
}
