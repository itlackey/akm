// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The folder listing behind the UI's folder picker (`GET /api/fs/folders`). A browser cannot read the path of a
 * folder the user picks, so the page asks this local server, which lists the sub-folders of one absolute path.
 * It lists folders only (never files or their contents), reads nothing else, and is behind the session token like
 * every other API route.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotFoundError, UsageError } from "../../core/errors";

const MAX_FOLDERS = 500;

export interface FolderListing {
  /** The absolute folder that was listed. */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  folders: Array<{ name: string; path: string }>;
  /** True when the folder holds more than {@link MAX_FOLDERS} sub-folders and the list was cut. */
  truncated: boolean;
}

/** `~` and `~/x` mean the home folder; anything else must already be absolute. */
function resolveFolderPath(raw: string, home: string): string {
  const requested = raw.trim();
  if (requested === "") return home;
  const expanded =
    requested === "~" ? home : requested.startsWith("~/") ? path.join(home, requested.slice(2)) : requested;
  if (!path.isAbsolute(expanded)) throw new UsageError("Give an absolute folder path, or ~ for your home folder.");
  return path.resolve(expanded);
}

/** The sub-folders of `raw` (default: the home folder). Hidden folders are left out unless `showHidden`. */
export function listFolders(raw: string, showHidden = false): FolderListing {
  const home = os.homedir();
  const target = resolveFolderPath(raw, home);
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(target).isDirectory()) throw new UsageError(`${target} is a file, not a folder.`);
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new NotFoundError(`${target} does not exist.`, "FILE_NOT_FOUND");
    throw new UsageError(`Cannot read ${target}: ${code ?? "unreadable"}.`);
  }
  const folders = entries
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      // A symbolic link counts when it points at a folder.
      if (!entry.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(target, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    folders: folders.slice(0, MAX_FOLDERS),
    truncated: folders.length > MAX_FOLDERS,
  };
}
