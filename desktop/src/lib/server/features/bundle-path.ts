// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assets, bundles, UsageError } from "akm-cli/workspace";

/** What akm accepts doing to a file or folder: allowed, or the sentence why not. */
export type Verdict = { allowed: true } | { allowed: false; reason: string };
export type Action = "read" | "edit" | "move" | "copy" | "retire" | "delete";
export interface ListedEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "other";
  assets: Array<{ ref: string; type: string }>;
  actions: Record<Action, Verdict>;
}
export interface Folder {
  entries: ListedEntry[];
  place: Verdict;
}
type Listed = { bundles: Array<{ name: string; enabled: boolean; path: string | null }> };

/** The folder of a bundle as akm lists it, hidden entries included: akm says what may be done to each. */
export async function listFolder(bundle: string, folder: string): Promise<Folder> {
  return (await assets.bundleFiles({ bundle, path: folder, hidden: true })) as unknown as Folder;
}

export const parentOf = (inside: string) => (inside.includes("/") ? inside.slice(0, inside.lastIndexOf("/")) : "");

/** The listed entry at a path inside a bundle. No answer about a path is not permission to touch it. */
export async function entryAt(bundle: string, inside: string): Promise<ListedEntry> {
  const entry = (await listFolder(bundle, parentOf(inside))).entries.find((listed) => listed.path === inside);
  if (!entry) throw new UsageError("This file is unavailable. Check its location and filesystem permissions.");
  return entry;
}

/** The root of an enabled bundle, as a real path. */
export async function bundleRoot(bundle: string) {
  const listing = (await bundles.list()) as Listed;
  const found = listing.bundles.find((entry) => entry.name === bundle && entry.enabled && entry.path);
  if (!bundle || !found) throw new UsageError("Choose a file in an enabled bundle.");
  return { root: found.path as string, physicalRoot: fs.realpathSync(found.path as string) };
}

/** A path inside a bundle, resolved through its parent folder's real path so no link can lead out of the bundle. */
export function underRoot(physicalRoot: string, inside: string): string {
  if (path.isAbsolute(inside) || inside.includes("\0")) throw new UsageError("Use a path relative to the bundle.");
  const wanted = path.resolve(physicalRoot, inside);
  let parent: string;
  try {
    parent = fs.realpathSync(path.dirname(wanted));
  } catch {
    throw new UsageError("This folder is unavailable. Check its location and filesystem permissions.");
  }
  const relative = path.relative(physicalRoot, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new UsageError("The path must stay inside its bundle.");
  return path.join(parent, path.basename(wanted));
}

/** One path segment: a name never carries a folder, so a rename cannot leave its folder. */
export function segment(name: unknown, what: string): string {
  if (
    typeof name !== "string" ||
    !name ||
    name !== path.basename(name) ||
    name === "." ||
    name === ".." ||
    name.includes("\0")
  )
    throw new UsageError(`Enter ${what} without a folder in it.`);
  return name;
}
