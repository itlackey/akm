// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The entries of a bundle that is a directory: its files. Every adapter of a
 * directory bundle takes `list`, `entry`, `write` and `remove` from here, so
 * the core reaches a directory's files the way it reaches any bundle's entries.
 */

import fs from "node:fs";
import path from "node:path";
import { buildFileContext, type FileContext } from "../../../indexer/walk/file-context";
import { walkStashFlatWithStatus } from "../../../indexer/walk/walker";
import { hasErrnoCode, writeFileAtomic } from "../../common";
import { ConfigError, UsageError } from "../../errors";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent } from "../types";

/** The file an entry names, or undefined when the entry's path leaves the bundle. */
function fileOf(c: BundleComponent, entry: string): string | undefined {
  const root = path.resolve(c.root);
  const file = path.resolve(root, entry);
  const relative = path.relative(root, file);
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : file;
}

function entry(c: BundleComponent, name: string): FileContext | undefined {
  try {
    fs.realpathSync(c.root);
  } catch (error) {
    // A root that is gone holds nothing. Any other failure (EACCES) is not "nothing": say the root is unreadable.
    if (hasErrnoCode(error, "ENOENT")) return undefined;
    throw new ConfigError(`Unable to read bundle directory at "${c.root}".`, "STASH_DIR_UNREADABLE");
  }
  const file = fileOf(c, name);
  if (file === undefined) return undefined;
  try {
    const authored = fs.lstatSync(file);
    if (!authored.isFile() && !authored.isSymbolicLink()) return undefined;
    // A symlink counts when it resolves to a file.
    if (!fs.statSync(fs.realpathSync(file)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return buildFileContext(c.root, file);
}

function write(c: BundleComponent, name: string, content: Buffer): void {
  const file = fileOf(c, name);
  if (file === undefined) throw new UsageError(`"${name}" is outside the bundle.`, "PATH_ESCAPE_VIOLATION");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Atomic, and readable by the owner only, even while it is being written.
  writeFileAtomic(file, content, 0o600);
}

function remove(c: BundleComponent, name: string): boolean {
  const file = fileOf(c, name);
  if (file === undefined || !fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * The entry access of a directory bundle. `walkMode` is the walk `list` makes:
 * by default the akm-bundle walk; `"all-directories"` for every directory but
 * `.git` and `node_modules`.
 */
export function directoryEntries(
  walkMode?: "all-directories",
): Pick<BundleAdapter, "walkMode" | "list" | "entry" | "write" | "remove"> {
  return {
    ...(walkMode ? { walkMode } : {}),
    list: (c) => walkStashFlatWithStatus(c.root, { includeAllDirectories: walkMode === "all-directories" }),
    entry,
    write,
    remove,
  };
}
