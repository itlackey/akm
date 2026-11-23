// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { protectedTypeOf } from "../core/adapter/directory/place-rules";
import { isWithin, relativeToRoot, safeRealpath } from "../core/common";
import { loadConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { findSourceForPath, resolveSourceEntries } from "../indexer/search/search-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAssetRefsForFiles } from "../storage/repositories/index-entries-repository";
import { bundleWriteBlockers, fileActions, placeVerdict } from "./file-actions";
import { newFileVerdict } from "./new-file";

export interface BundleFileLocation {
  bundle: string;
  path: string;
  parent: string;
}

const portable = (value: string) => value.split(path.sep).join("/");

/** Source roots and identities come from the same resolver as search, never from a ref's spelling. */
export function bundleFileLocation(filePath: string): BundleFileLocation | null {
  const source = findSourceForPath(filePath, resolveSourceEntries());
  if (!source?.registryId || source.unresolved || !isWithin(filePath, source.path)) return null;
  const relative = relativeToRoot(filePath, source.path) ?? path.relative(source.path, filePath);
  return {
    bundle: source.registryId,
    path: portable(relative),
    parent: portable(path.dirname(relative)).replace(/^\.$/, ""),
  };
}

/**
 * One directory, not a recursive walk or an index refresh. Each entry says what akm accepts doing to it (`actions`) and
 * why not. A file's contents are not listed; the first bytes of a file that is neither protected nor managed are probed
 * to tell text from binary, and a protected file is never opened.
 */
export function listBundleFiles(bundle: string, relative = "", showHidden = false) {
  if (!bundle) throw new UsageError("Choose a registered bundle.", "MISSING_REQUIRED_ARGUMENT");
  const source = resolveSourceEntries().find((entry) => entry.registryId === bundle);
  if (!source || source.unresolved)
    throw new NotFoundError(`Bundle ${JSON.stringify(bundle)} is disabled or unavailable.`);
  if (path.isAbsolute(relative) || relative.includes("\0")) throw new UsageError("Use a path relative to the bundle.");
  const target = path.resolve(source.path, relative);
  if (!isWithin(target, source.path)) throw new UsageError("The folder is outside this bundle.");
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new NotFoundError("The folder no longer exists.", "FILE_NOT_FOUND");
    throw new UsageError("This folder cannot be listed. Check its path and filesystem permissions.");
  }
  const physicalRoot = safeRealpath(source.path);
  const rows = children
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .map((entry) => {
      const absolute = path.join(target, entry.name);
      let kind: "directory" | "file" | "other" = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      let unavailable: string | undefined;
      if (entry.isSymbolicLink()) {
        try {
          if (!isWithin(absolute, source.path)) unavailable = "Link points outside this bundle.";
          else {
            const stat = fs.statSync(absolute);
            kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
          }
        } catch {
          unavailable = "Link target is unavailable.";
        }
      }
      // Size (a file's) and modified time, from the file the entry resolves to; absent when it cannot be read.
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(absolute);
      } catch {
        stat = undefined;
      }
      return {
        name: entry.name,
        path: portable(path.relative(source.path, absolute)),
        kind,
        ...(stat ? { modified: stat.mtime.toISOString(), ...(stat.isFile() ? { size: stat.size } : {}) } : {}),
        // Keep the displayed alias, but look up the file under this bundle's indexed root.
        absolute: path.join(source.path, path.relative(physicalRoot, safeRealpath(absolute))),
        ...(entry.isSymbolicLink() ? { symlink: true } : {}),
        ...(unavailable ? { unavailable } : {}),
      };
    })
    .sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) ||
        a.name.localeCompare(b.name),
    );
  let indexAvailable = false;
  let refs = new Map<string, Array<{ ref: string; type: string }>>();
  try {
    const db = openReadonlyExistingDatabase();
    if (db) {
      try {
        refs = getAssetRefsForFiles(
          db,
          rows.filter((row) => row.kind === "file" && !row.unavailable).map((row) => row.absolute),
          bundle,
        );
        indexAvailable = true;
      } finally {
        closeDatabase(db);
      }
    }
  } catch {
    /* Files remain browsable when the derived index needs repair. */
  }
  const current = portable(path.relative(source.path, target));
  const writeBlockers = bundleWriteBlockers(loadConfig(), bundle);
  return {
    bundle,
    path: current,
    parent: current ? portable(path.dirname(current)).replace(/^\.$/, "") : null,
    indexAvailable,
    // Whether a new file may be made in this folder, and the type its place gives it (null: none).
    newFile: newFileVerdict(current, writeBlockers),
    // Whether a folder may be made here, or a file or folder moved in: plain file operations, which need only a place akm
    // does not manage or protect and a bundle that is not read-only.
    place: placeVerdict(current, writeBlockers),
    entries: rows.map(({ absolute, ...row }) => {
      const assets = refs.get(absolute) ?? [];
      const isProtected =
        row.kind === "file" && protectedTypeOf(portable(path.relative(source.path, absolute))) !== undefined;
      return {
        ...row,
        assets,
        protected: isProtected,
        actions: fileActions(
          {
            bundle,
            relative: row.path,
            kind: row.kind,
            absolute: row.unavailable ? undefined : path.join(target, row.name),
            unavailable: row.unavailable,
            protected: isProtected,
            assets,
          },
          writeBlockers,
        ),
      };
    }),
  };
}
