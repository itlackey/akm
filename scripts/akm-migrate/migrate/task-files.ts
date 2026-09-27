// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Filesystem boundary for the task-source migration: every task file under a
 * bundle's task directory, whatever version it declares, planned to task
 * source v4 and written back under one backup. The version-specific work is
 * the pure planners the runtime reader already runs in memory on every read
 * (`src/tasks/source/task-to-v3.ts`, `task-to-v4.ts`, chained exactly as
 * `parse-task-source.ts` chains them); this module only walks directories,
 * snapshots bytes, and replaces files.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import { parseTaskSourceV4 } from "../../../src/tasks/source/task-source-v4";
import { planTaskToV3File } from "../../../src/tasks/source/task-to-v3";
import {
  planTaskToV4File,
  type TaskToV4Changed,
  type TaskToV4FileInput,
  type TaskToV4FileOutcome,
  type TaskToV4MigrationPlan,
  taskToV4PlanFromOutcomes,
} from "../../../src/tasks/source/task-to-v4";

export interface TaskFileRoot {
  readonly bundleId: string;
  readonly root: string;
  readonly bundleRoot?: string;
  readonly writable: boolean;
  readonly layout?: "akm-stash" | "akm-task";
}

export interface AppliedTaskFilesPlan {
  readonly changed: readonly string[];
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

function walkTasks(root: TaskFileRoot, tasksDir: string, out: TaskToV4FileInput[]): void {
  const physicalRoot = realDirectory(root.root);
  const physicalBundleRoot = realDirectory(root.bundleRoot ?? root.root);
  if (!contained(physicalBundleRoot, physicalRoot)) {
    throw migrationError(`${root.root} resolves outside bundle ${root.bundleId}.`);
  }

  const visit = (directory: string): void => {
    const physicalDirectory = fs.realpathSync(directory);
    if (!contained(physicalRoot, physicalDirectory)) {
      throw migrationError(`${directory} resolves outside bundle ${root.bundleId}.`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw migrationError(`task migration does not follow symbolic link ${candidate}.`);
      if (entry.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
      const stat = fs.lstatSync(candidate);
      const mode = stat.mode & 0o777;
      out.push({
        filePath: candidate,
        bytes: fs.readFileSync(candidate),
        mode,
        writable: root.writable,
        onDiskWritable: isWritable(candidate) && isWritable(directory) && (mode & 0o222) !== 0,
        containmentRoot: physicalRoot,
      });
    }
  };
  visit(tasksDir);
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

/**
 * Plan one file to task source v4 whatever version it declares: a v2 file
 * goes through the v2->v3 planner and its v3 bytes on through the v3->v4
 * planner; a v3 or v4 file goes straight to the v3->v4 planner, which also
 * strips the retired `schedule[].enabled` key from a v4 file. `before` is
 * always the bytes on disk, so the backup and a rollback see the original.
 */
export function planTaskFileToV4(input: TaskToV4FileInput): TaskToV4FileOutcome {
  const v3 = planTaskToV3File(input);
  if (v3.status === "blocked") return v3;
  if (v3.status === "skipped") return planTaskToV4File(input);
  const v4 = planTaskToV4File({ ...input, bytes: v3.after });
  if (v4.status !== "changed") return { ...v4, before: v3.before, beforeHash: v3.beforeHash };
  return { ...v4, reason: "task-converted", before: v3.before, beforeHash: v3.beforeHash };
}

/** Plan a complete, stable file set; input order cannot change the result. */
export function planTaskFilesMigration(inputs: readonly TaskToV4FileInput[]): TaskToV4MigrationPlan {
  return taskToV4PlanFromOutcomes(inputs.map(planTaskFileToV4));
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

/**
 * Write every `changed` file in its v4 shape. Each emitted document is
 * re-parsed by the runtime v4 parser first, so nothing the runtime cannot
 * read reaches disk; every original is backed up under `backupRoot` before
 * any file is touched; a failed replace restores the files already replaced
 * from those backups. Blocked files are left alone.
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
      ...(change.containmentRoot ? { workspaceRoot: change.containmentRoot } : {}),
    });
  }
  for (const change of changes) {
    writeDurable(taskFileBackupPath(options.backupRoot, change.filePath), change.before, change.mode, true);
  }
  const replaced: TaskToV4Changed[] = [];
  try {
    for (const change of changes) {
      replaceAtomically(change.filePath, change.after, change.mode);
      replaced.push(change);
    }
  } catch (cause) {
    for (const change of [...replaced].reverse()) {
      replaceAtomically(
        change.filePath,
        fs.readFileSync(taskFileBackupPath(options.backupRoot, change.filePath)),
        change.mode,
      );
    }
    throw cause;
  }
  return { changed: changes.map((file) => file.filePath) };
}
