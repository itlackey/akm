// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";

const SKELETON_DIR = path.join(import.meta.dir, "../assets/stash-skeleton");

/**
 * Copy the default stash skeleton into a newly created stash directory.
 *
 * Each file in src/assets/stash-skeleton/ is written to the stash root only
 * if the destination does not already exist — existing files are never
 * overwritten. Non-fatal: if the skeleton directory is missing or a copy
 * fails the caller continues normally.
 */
export function copyStashSkeleton(stashDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(SKELETON_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = path.join(SKELETON_DIR, entry);
    const dest = path.join(stashDir, entry);
    if (fs.existsSync(dest)) continue;
    try {
      fs.copyFileSync(src, dest);
    } catch {
      // Non-fatal — stash is usable without skeleton files
    }
  }
}
