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
import { replaceFilesWithBackups, type TaskFileRoot, walkRootFiles } from "./task-files";

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
  root: TaskFileRoot,
  directory: string,
  role: EngineKeyRole,
  extension: string,
  out: Map<string, EngineKeyFileInput>,
): void {
  let top: fs.Stats;
  try {
    top = fs.lstatSync(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  // A link may lead anywhere; an asset behind one is the user's to rewrite.
  if (!top.isDirectory()) return;
  walkRootFiles(
    root,
    directory,
    extension,
    () => undefined,
    (candidate) => {
      const stat = fs.lstatSync(candidate);
      if (stat.size > MAX_ASSET_BYTES || out.has(candidate)) return;
      out.set(candidate, {
        filePath: candidate,
        bytes: fs.readFileSync(candidate),
        mode: stat.mode & 0o777,
        role,
        writable: root.writable,
      });
    },
  );
}

/** Every file under each root that can name an engine, as planner input. Read-only. */
export function inspectEngineKeyFiles(roots: readonly TaskFileRoot[]): EngineKeyFileInput[] {
  const files = new Map<string, EngineKeyFileInput>();
  for (const root of [...roots].sort((a, b) => a.bundleId.localeCompare(b.bundleId))) {
    if (root.layout === "akm-task") {
      collect(root, root.root, "task", ".yml", files);
      continue;
    }
    for (const { dir, role, extension } of STASH_DIRECTORIES) {
      collect(root, path.join(root.root, dir), role, extension, files);
    }
  }
  return [...files.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * Write every `changed` file with its keys rewritten, under one backup (see
 * {@link replaceFilesWithBackups}). Returns the paths it rewrote.
 */
export function applyEngineKeysPlan(plan: EngineKeysPlan, options: { readonly backupRoot: string }): string[] {
  const changes = plan.files.filter((file): file is EngineKeyChange => file.status === "changed");
  replaceFilesWithBackups(changes, options.backupRoot);
  return changes.map((change) => change.filePath);
}
