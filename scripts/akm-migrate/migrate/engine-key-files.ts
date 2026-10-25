// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Filesystem boundary for the `assetEngineKeys` step: the command, agent,
 * workflow and task-source files of each bundle root, as planner input
 * ({@link planEngineKeys}), and the planned rewrites written back under one
 * backup, the way `task-files.ts` does for task sources.
 */

import fs from "node:fs";
import path from "node:path";
import type { EngineKeyChange, EngineKeyFileInput, EngineKeyRole, EngineKeysPlan } from "./engine-key-planner";
import { replaceAtomically, type TaskFileRoot, taskFileBackupPath, writeDurable } from "./task-files";

/** Where a stash keeps the files that can name an engine; a task root is itself the task directory. */
const STASH_DIRECTORIES: ReadonlyArray<{ dir: string; role: EngineKeyRole; extension: string }> = [
  { dir: "commands", role: "command", extension: ".md" },
  { dir: "agents", role: "command", extension: ".md" },
  { dir: "workflows", role: "workflow", extension: ".md" },
  { dir: "tasks", role: "task", extension: ".yml" },
];

/** A file larger than this is not an asset; it is not read. */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

function collect(
  directory: string,
  role: EngineKeyRole,
  extension: string,
  writable: boolean,
  out: Map<string, EngineKeyFileInput>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ENOTDIR") return;
    throw cause;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = path.join(directory, entry.name);
    // A link may lead anywhere; an asset behind one is the user's to rewrite.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collect(candidate, role, extension, writable, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(extension) || out.has(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.size > MAX_ASSET_BYTES) continue;
    out.set(candidate, {
      filePath: candidate,
      bytes: fs.readFileSync(candidate),
      mode: stat.mode & 0o777,
      role,
      writable,
    });
  }
}

/** Every file under each root that can name an engine, as planner input. Read-only. */
export function inspectEngineKeyFiles(roots: readonly TaskFileRoot[]): EngineKeyFileInput[] {
  const files = new Map<string, EngineKeyFileInput>();
  for (const root of [...roots].sort((a, b) => a.bundleId.localeCompare(b.bundleId))) {
    if (root.layout === "akm-task") {
      collect(root.root, "task", ".yml", root.writable, files);
      continue;
    }
    for (const { dir, role, extension } of STASH_DIRECTORIES) {
      collect(path.join(root.root, dir), role, extension, root.writable, files);
    }
  }
  return [...files.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * Write every `changed` file with its keys rewritten. Every original is backed
 * up under `backupRoot` before any file is touched, and a failed replace
 * restores the files already replaced from those backups.
 */
export function applyEngineKeysPlan(plan: EngineKeysPlan, options: { readonly backupRoot: string }): string[] {
  const changes = plan.files.filter((file): file is EngineKeyChange => file.status === "changed");
  for (const change of changes) {
    writeDurable(taskFileBackupPath(options.backupRoot, change.filePath), change.before, change.mode, true);
  }
  const replaced: typeof changes = [];
  try {
    for (const change of changes) {
      replaceAtomically(change.filePath, change.after, change.mode);
      replaced.push(change);
    }
  } catch (cause) {
    for (const change of [...replaced].reverse()) {
      replaceAtomically(change.filePath, change.before, change.mode);
    }
    throw cause;
  }
  return changes.map((change) => change.filePath);
}
