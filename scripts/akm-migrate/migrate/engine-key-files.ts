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
import { isFileOrFileSymlink } from "../../../src/indexer/walk/walker";
import type { EngineKeyChange, EngineKeyFileInput, EngineKeyRole, EngineKeysPlan } from "./engine-key-planner";
import { replaceFilesWithBackups, type TaskFileRoot, walkRootFiles } from "./task-files";

/** Where a stash keeps the files that can name an engine; a task root is itself the task directory. */
const STASH_DIRECTORIES: ReadonlyArray<{ dir: string; role: EngineKeyRole; extension: string }> = [
  { dir: "commands", role: "command", extension: ".md" },
  { dir: "agents", role: "command", extension: ".md" },
  { dir: "workflows", role: "workflow", extension: ".md" },
  { dir: "tasks", role: "task", extension: ".yml" },
];

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
  // A link to a directory in the root is not descended, as the runtime's walk does not descend one: it reads no asset
  // behind it. The root itself is not skipped: `walkRootFiles` refuses one that is a link, as the task step does.
  if (directory !== root.root && !top.isDirectory()) return;
  walkRootFiles(
    root,
    directory,
    extension,
    // A link to a file is an asset the runtime reads, so it is read through to find its `engine:` keys; it may lead
    // anywhere, so it is never rewritten, and the planner reports it with those keys pending.
    (link) => {
      if (!link.endsWith(extension) || out.has(link) || !isFileOrFileSymlink(link)) return;
      out.set(link, {
        filePath: link,
        bytes: fs.readFileSync(link),
        mode: fs.statSync(link).mode & 0o777,
        role,
        writable: root.writable,
        link: true,
      });
    },
    (candidate) => {
      if (out.has(candidate)) return;
      out.set(candidate, {
        filePath: candidate,
        bytes: fs.readFileSync(candidate),
        mode: fs.lstatSync(candidate).mode & 0o777,
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
 * {@link replaceFilesWithBackups}). Returns the paths it rewrote and the ones that
 * changed since they were planned, which it left as they are.
 */
export function applyEngineKeysPlan(
  plan: EngineKeysPlan,
  options: { readonly backupRoot: string },
): { readonly rewritten: readonly string[]; readonly conflicts: readonly string[] } {
  const changes = plan.files.filter((file): file is EngineKeyChange => file.status === "changed");
  const { replaced, conflicts } = replaceFilesWithBackups(changes, options.backupRoot);
  return { rewritten: replaced, conflicts };
}
