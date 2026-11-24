// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a directory bundle keeps at a stored key, asked by a check that resolves a path it was handed (lint's reachability rules
 * for a ref). The keys are the ones a placement spelling gives a ref (`memories/x.md`, `skills/x/SKILL.md`), which may
 * name a file no adapter lists as an asset (a loose `.md` of no type); `findAsset` would say no to that, and `missing-ref`
 * has always said yes. So these answer from what the bundle keeps, not from what its adapter recognizes. `akm lint` and
 * its base checks import this module directly, under the `base` exemption, so the lint counts each of them.
 */

import fs from "node:fs";
import path from "node:path";
import { archivedOriginalPaths } from "../directory-archive";

/** Whether the bundle rooted at `root` keeps a file at the bundle-relative `key`. */
export function holdsFile(root: string, key: string): boolean {
  return fs.existsSync(path.join(root, key));
}

/** Whether the bundle rooted at `root` retired the asset that was kept at `key` (its tombstone names that key). */
export function isRetired(root: string, key: string): boolean {
  return archivedOriginalPaths(root).has(key.replace(/\\/g, "/"));
}

/** The names of the directories directly inside the bundle's folder `key` (none when it is no folder), in directory order. */
export function heldFolders(root: string, key: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, key), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The files below the bundle's folder `key`, at any depth, that `accept` takes by name: absolute paths, in directory order. */
export function heldFilesBelow(root: string, key: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && accept(entry.name)) found.push(full);
    }
  };
  walk(path.join(root, key));
  return found;
}

/** The text of a file of a bundle that no adapter lists as an asset (`heldFilesBelow` found it). */
export function heldText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Save the text of a file no adapter lists as an asset, as it lies (the file keeps its place and its links). */
export function saveHeldText(file: string, text: string): void {
  fs.writeFileSync(file, text, "utf8");
}
