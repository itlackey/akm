// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRASH_TOOL_TIMEOUT_MS = 30_000;

function homeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}

/** `[command, ...args]` trash tools tried in order on Linux; the target path is appended. */
const LINUX_TRASH_TOOLS: ReadonlyArray<readonly string[]> = [["trash-put"], ["gio", "trash"]];

/**
 * FreeDesktop trash without a helper tool: move `target` into
 * `$XDG_DATA_HOME/Trash/files` and write the `.trashinfo` that lets a file
 * manager restore it. A plain rename, so it fails (rather than copying) when
 * the trash is on another filesystem.
 */
function moveToXdgTrash(target: string): void {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homeDir(), ".local", "share");
  const filesDir = path.join(dataHome, "Trash", "files");
  const infoDir = path.join(dataHome, "Trash", "info");
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(infoDir, { recursive: true });
  const base = path.basename(target);
  let name = base;
  for (
    let n = 1;
    fs.existsSync(path.join(filesDir, name)) || fs.existsSync(path.join(infoDir, `${name}.trashinfo`));
    n++
  ) {
    name = `${base}.${n}`;
  }
  const deletedAt = new Date().toISOString().slice(0, 19);
  fs.writeFileSync(
    path.join(infoDir, `${name}.trashinfo`),
    `[Trash Info]\nPath=${encodeURI(path.resolve(target))}\nDeletionDate=${deletedAt}\n`,
  );
  try {
    fs.renameSync(target, path.join(filesDir, name));
  } catch (error) {
    fs.unlinkSync(path.join(infoDir, `${name}.trashinfo`));
    throw error;
  }
}

/**
 * Move `target` to the operating system's trash. Never deletes permanently:
 * when no trash is available the target is left where it is and this throws.
 * Linux tries `trash-put`, then `gio trash`, then the FreeDesktop trash
 * directory; macOS moves into `~/.Trash`; Windows has no supported trash here.
 */
export function moveToTrash(target: string, tools: ReadonlyArray<readonly string[]> = LINUX_TRASH_TOOLS): void {
  if (!fs.existsSync(target)) return;
  if (process.platform === "win32") {
    throw new Error("moving to the Recycle Bin is not supported on Windows; the directory was left in place");
  }
  if (process.platform === "darwin") {
    const trashDir = path.join(homeDir(), ".Trash");
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(target, path.join(trashDir, `${path.basename(target)}.${Date.now()}`));
    return;
  }
  for (const [command, ...args] of tools) {
    const result = childProcess.spawnSync(command as string, [...args, target], {
      // The live environment, as the harness commands get it: Bun's default is the env the process started with.
      env: process.env,
      encoding: "utf8",
      stdio: "pipe",
      timeout: TRASH_TOOL_TIMEOUT_MS,
    });
    if (!result.error && result.status === 0 && !fs.existsSync(target)) return;
    // A tool that is missing falls through to the next; one that ran and
    // failed does too, because the target is still in place.
  }
  moveToXdgTrash(target);
}
