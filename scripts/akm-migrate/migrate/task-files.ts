// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Filesystem boundary for the task-source migration: every task file under a
 * bundle's task directory, whatever version it declares, planned to task
 * source v4 and written back under one backup. The version-specific work is
 * the pure planner `scripts/akm-migrate/migrate/task-to-v4.ts`, which only this
 * migration runs — the runtime reads only task source v4; this module only
 * walks directories, snapshots bytes, and replaces files.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import { parseTaskSourceV4 } from "../../../src/tasks/source/task-source-v4";
import {
  planTaskToV4File,
  type TaskToV4Changed,
  type TaskToV4FileInput,
  type TaskToV4MigrationPlan,
  taskToV4PlanFromOutcomes,
} from "./task-to-v4";

export interface TaskFileRoot {
  readonly bundleId: string;
  readonly root: string;
  readonly bundleRoot?: string;
  readonly writable: boolean;
  readonly layout?: "akm-stash" | "akm-task";
}

export interface AppliedTaskFilesPlan {
  readonly changed: readonly string[];
  /** Files that changed after they were planned: left as they now are. */
  readonly conflicts: readonly string[];
}

function migrationError(detail: string): ConfigError {
  return new ConfigError(`Task migration failed: ${detail}`, "INVALID_CONFIG_FILE");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realDirectory(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw migrationError(`${filePath} must be a real directory.`);
  return fs.realpathSync(filePath);
}

function isWritable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Visit every file ending in `extension` under `directory`, depth first in name
 * order, never leaving the root's own bundle. A symbolic link is not followed:
 * `onLink` says what it means (a task migration refuses one, an asset migration
 * reads one that leads to a file and never rewrites it).
 */
export function walkRootFiles(
  root: TaskFileRoot,
  directory: string,
  extension: string,
  onLink: (link: string) => void,
  visit: (file: string, parent: string) => void,
): void {
  const physicalRoot = realDirectory(root.root);
  const physicalBundleRoot = realDirectory(root.bundleRoot ?? root.root);
  if (!contained(physicalBundleRoot, physicalRoot)) {
    throw migrationError(`${root.root} resolves outside bundle ${root.bundleId}.`);
  }

  const walk = (current: string): void => {
    const physicalDirectory = fs.realpathSync(current);
    if (!contained(physicalRoot, physicalDirectory)) {
      throw migrationError(`${current} resolves outside bundle ${root.bundleId}.`);
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        onLink(candidate);
        continue;
      }
      if (entry.isDirectory()) {
        walk(candidate);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(extension)) visit(candidate, current);
    }
  };
  walk(directory);
}

function walkTasks(root: TaskFileRoot, tasksDir: string, out: TaskToV4FileInput[]): void {
  walkRootFiles(
    root,
    tasksDir,
    ".yml",
    (link) => {
      throw migrationError(`task migration does not follow symbolic link ${link}.`);
    },
    (candidate, directory) => {
      const stat = fs.lstatSync(candidate);
      const mode = stat.mode & 0o777;
      out.push({
        filePath: candidate,
        bytes: fs.readFileSync(candidate),
        mode,
        writable: root.writable,
        onDiskWritable: isWritable(candidate) && isWritable(directory) && (mode & 0o222) !== 0,
      });
    },
  );
}

/** Every `.yml` under each root's task directory, as planner input. Read-only. */
export function inspectTaskFiles(roots: readonly TaskFileRoot[]): TaskToV4FileInput[] {
  const files: TaskToV4FileInput[] = [];
  for (const root of [...roots].sort((a, b) => a.bundleId.localeCompare(b.bundleId))) {
    const tasksDir = root.layout === "akm-task" ? root.root : path.join(root.root, "tasks");
    try {
      const stat = fs.lstatSync(tasksDir);
      if (stat.isSymbolicLink()) throw migrationError(`task migration does not follow symbolic link ${tasksDir}.`);
      if (!stat.isDirectory()) throw migrationError(`${tasksDir} must be a directory.`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    walkTasks(root, tasksDir, files);
  }
  return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Plan a complete, stable file set; input order cannot change the result. */
export function planTaskFilesMigration(inputs: readonly TaskToV4FileInput[]): TaskToV4MigrationPlan {
  return taskToV4PlanFromOutcomes(inputs.map(planTaskToV4File));
}

export function taskFileBackupPath(backupRoot: string, filePath: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
  return path.join(backupRoot, "files", `${digest}-${path.basename(filePath)}`);
}

/** Directory fsync where the platform supports it; the file fsync and rename below hold either way. */
function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw cause;
  }
}

function writeDurable(filePath: string, bytes: Buffer, mode: number, exclusive = false): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, exclusive ? "wx" : "w", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, mode);
  fsyncDirectory(path.dirname(filePath));
}

function replaceAtomically(filePath: string, bytes: Buffer, mode: number): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.migrate-${crypto.randomUUID()}`);
  try {
    writeDurable(temporary, bytes, mode, true);
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A file to replace: its path, its bytes before and after, and its mode. */
export interface FileReplacement {
  readonly filePath: string;
  readonly before: Buffer;
  readonly after: Buffer;
  readonly mode: number;
}

/** Whether the file on disk holds exactly `bytes` now; a file that cannot be read holds nothing. */
function holds(filePath: string, bytes: Buffer): boolean {
  try {
    return fs.readFileSync(filePath).equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Replace each file with its new bytes. A file whose bytes are no longer the
 * ones it was planned from (an editor or a bundle sync wrote it since) is a
 * conflict: it is neither backed up nor replaced, and the paths are returned.
 * The bytes are checked before the backup and again immediately before the
 * file is replaced, so a backup is always what was replaced. Every original is
 * backed up under `backupRoot` before any file is touched, and a failed replace
 * restores the files already replaced from those backups, except one that has
 * changed since it was replaced, which is left as it is and named.
 */
export function replaceFilesWithBackups(
  changes: readonly FileReplacement[],
  backupRoot: string,
): { readonly replaced: readonly string[]; readonly conflicts: readonly string[] } {
  const conflicts: string[] = [];
  const backedUp: FileReplacement[] = [];
  for (const change of changes) {
    if (!holds(change.filePath, change.before)) {
      conflicts.push(change.filePath);
      continue;
    }
    writeDurable(taskFileBackupPath(backupRoot, change.filePath), change.before, change.mode, true);
    backedUp.push(change);
  }
  const replaced: FileReplacement[] = [];
  try {
    for (const change of backedUp) {
      if (!holds(change.filePath, change.before)) {
        fs.rmSync(taskFileBackupPath(backupRoot, change.filePath), { force: true });
        conflicts.push(change.filePath);
        continue;
      }
      replaceAtomically(change.filePath, change.after, change.mode);
      replaced.push(change);
    }
  } catch (cause) {
    const unrestored: string[] = [];
    for (const change of [...replaced].reverse()) {
      if (holds(change.filePath, change.after)) {
        replaceAtomically(
          change.filePath,
          fs.readFileSync(taskFileBackupPath(backupRoot, change.filePath)),
          change.mode,
        );
      } else {
        unrestored.push(change.filePath);
      }
    }
    if (unrestored.length === 0) throw cause;
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}; not restored from the backup, because it changed after it was replaced: ${unrestored.join(", ")}`,
      { cause },
    );
  }
  return { replaced: replaced.map((change) => change.filePath), conflicts };
}

/**
 * Write every `changed` file in its v4 shape. Each emitted document is
 * re-parsed by the runtime v4 parser first, so nothing the runtime cannot
 * read reaches disk; the replacement is {@link replaceFilesWithBackups}.
 * Blocked files are left alone.
 */
export function applyTaskFilesPlan(
  plan: TaskToV4MigrationPlan,
  options: { readonly backupRoot: string },
): AppliedTaskFilesPlan {
  const changes = plan.files.filter((file): file is TaskToV4Changed => file.status === "changed");
  for (const change of changes) {
    parseTaskSourceV4({
      yaml: change.after.toString("utf8"),
      filePath: change.filePath,
    });
  }
  const { replaced, conflicts } = replaceFilesWithBackups(changes, options.backupRoot);
  return { changed: replaced, conflicts };
}
