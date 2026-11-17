// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { bundles, UsageError } from "akm-cli/workspace";
import { fields } from "../input.js";
import { bundleRoot, entryAt, listFolder, parentOf, segment, underRoot } from "./bundle-path.js";
import { desktopApp } from "./software.js";

/**
 * Moving, renaming, making and deleting files and folders are plain file operations, as in a file manager. akm says
 * whether each is accepted (`actions` on the entry, `place` on the folder it goes into); Desktop does the file operation
 * and asks akm to index again, which pairs a moved file with the asset it was and carries its history.
 */

const str = (value: unknown, what: string) => {
  if (typeof value !== "string") throw new UsageError(`${what} is required.`);
  return value;
};
const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Put `from` at `name` inside `folder` of `toBundle` (the same bundle when absent), by moving it or by copying it. akm's
 * verdicts on the entry and on the folder it goes into decide; nothing at the destination is replaced.
 */
async function place(body: unknown, how: "move" | "copy") {
  const value = fields<Record<string, unknown>>(body, ["bundle", "from", "toBundle", "folder", "name"], `file ${how}`);
  const bundle = str(value.bundle, "bundle"),
    from = str(value.from, "from"),
    toBundle = value.toBundle === undefined ? bundle : str(value.toBundle, "toBundle"),
    folder = str(value.folder ?? "", "folder"),
    name = segment(value.name, "a name");
  const to = folder ? `${folder}/${name}` : name;
  const entry = await entryAt(bundle, from);
  const verdict = entry.actions[how];
  if (!verdict.allowed) throw new UsageError(verdict.reason);
  if (how === "move" && to === from && toBundle === bundle) return { bundle, from, toBundle, to, done: false };
  const destination = (await listFolder(toBundle, folder)).place;
  if (!destination.allowed) throw new UsageError(destination.reason);
  const source = underRoot((await bundleRoot(bundle)).physicalRoot, from),
    target = underRoot((await bundleRoot(toBundle)).physicalRoot, to);
  if (exists(target))
    throw new UsageError(`There is already a file or folder named ${name} there.`, "RESOURCE_ALREADY_EXISTS");
  try {
    if (how === "move") fs.renameSync(source, target);
    else fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  } catch (cause) {
    throw new UsageError(
      `${entry.name} could not be ${how === "move" ? "moved" : "copied"}: ${(cause as Error).message}`,
    );
  }
  // The file operation stands whatever the index says: a failure is reported, never read as it not having happened.
  try {
    const indexed = await bundles.index();
    const after = (await listFolder(toBundle, folder)).entries.find((listed) => listed.name === name);
    return {
      bundle,
      from,
      toBundle,
      to,
      done: true,
      assets: after?.assets ?? [],
      moves: indexed.moves,
      warnings: indexed.warnings ?? [],
    };
  } catch (cause) {
    return { bundle, from, toBundle, to, done: true, indexError: (cause as Error).message };
  }
}

/** Move or rename: a plain rename on disk, then the index follows the file and carries its history. */
export const moveEntry = (body: unknown) => place(body, "move");
/** Copy a file or folder to a folder, as a file manager does; the copy is a new file. */
export const copyEntry = (body: unknown) => place(body, "copy");

/** A new folder, `name`, inside `folder`. */
export async function makeFolder(body: unknown) {
  const value = fields<Record<string, unknown>>(body, ["bundle", "folder", "name"], "folder create");
  const bundle = str(value.bundle, "bundle"),
    folder = str(value.folder ?? "", "folder"),
    name = segment(value.name, "a name");
  const place = (await listFolder(bundle, folder)).place;
  if (!place.allowed) throw new UsageError(place.reason);
  const { physicalRoot } = await bundleRoot(bundle);
  const target = underRoot(physicalRoot, folder ? `${folder}/${name}` : name);
  if (exists(target))
    throw new UsageError(`There is already a file or folder named ${name} there.`, "RESOURCE_ALREADY_EXISTS");
  fs.mkdirSync(target);
  return { bundle, path: folder ? `${folder}/${name}` : name };
}

/** Delete a file that is not an asset, or an empty folder: whatever akm's `delete` verdict allows. */
export async function deleteEntry(body: unknown) {
  const value = fields<Record<string, unknown>>(body, ["bundle", "path"], "file delete");
  const bundle = str(value.bundle, "bundle"),
    inside = str(value.path, "path");
  const entry = await entryAt(bundle, inside);
  if (!entry.actions.delete.allowed) throw new UsageError(entry.actions.delete.reason);
  const { physicalRoot } = await bundleRoot(bundle);
  const target = underRoot(physicalRoot, inside);
  if (fs.lstatSync(target).isDirectory()) fs.rmdirSync(target);
  else fs.unlinkSync(target);
  return { bundle, path: inside, parent: parentOf(inside), name: path.basename(inside) };
}

/** Show a file or folder in the system file manager (the Electron shell only). */
export async function revealEntry(body: unknown) {
  const value = fields<Record<string, unknown>>(body, ["bundle", "path"], "file reveal");
  const bundle = str(value.bundle, "bundle"),
    inside = str(value.path, "path");
  const entry = await entryAt(bundle, inside);
  const { physicalRoot } = await bundleRoot(bundle);
  await desktopApp("reveal", { path: underRoot(physicalRoot, entry.path) });
  return { bundle, path: inside };
}
