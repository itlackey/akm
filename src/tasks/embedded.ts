// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedded task templates.
 *
 * Curated sets of read-only YAML task templates ship inside the akm binary
 * under `src/assets/tasks/<category>/` — `core/` (general-purpose maintenance)
 * and `improve/` (the maintainer-oriented multi-cadence improve schedule,
 * folded in from the retired `registerDefaultTasks`/`akm tasks init` path in
 * 0.9, S6). Every category subdirectory is enumerated the same way; adding a
 * new one needs no code change here. Templates are resolved at runtime via
 * `import.meta.dir` (mirroring `SKELETON_DIR` in
 * src/commands/stash-skeleton.ts) and are NOT written to any stash at
 * install time — the `akm setup` wizard copies a template into the primary
 * stash only when the user opts in (copy-on-enable).
 *
 * Each entry exposes the parsed `command`, `schedule`, and `description`
 * alongside the raw `yaml`, so the wizard can both render a choice and write
 * the file verbatim (with an optional schedule edit applied).
 */

import fs from "node:fs";
import path from "node:path";
import { getDirname } from "../runtime";
import { parseTaskSource } from "./source/parse-task-source";

/** Directory holding the bundled task template categories. */
const TASKS_ASSETS_DIR = path.join(getDirname(import.meta.url), "../assets/tasks");
const DEFAULT_DISABLED_TASKS = new Set(["improve/akm-improve-catchup"]);

export interface EmbeddedTask {
  /**
   * Task id as written to disk and registered with the scheduler — the
   * template filename without its `.yml` suffix (e.g. `improve`). This is the
   * id matched against `akm search --type task` output.
   */
  id: string;
  /** Conceptual namespaced label shown in the wizard (e.g. `core/improve`). */
  label: string;
  /** Shell command the task runs on its schedule. */
  command: string;
  /** Default cron-style schedule shipped with the template. */
  schedule: string;
  /** Human-readable description shown in the wizard. */
  description: string;
  /** Whether setup may offer this template for installation. */
  enabled: boolean;
  /** Raw template YAML, written verbatim (with schedule edits) on enable. */
  yaml: string;
}

/**
 * Enumerate the embedded task templates from every category subdirectory of
 * the bundled assets directory. Sorted by category then id for deterministic
 * ordering. Returns an empty array if the directory is missing (defensive —
 * a build without assets should not crash the wizard).
 */
export function listEmbeddedTasks(): EmbeddedTask[] {
  let categories: string[];
  try {
    categories = fs
      .readdirSync(TASKS_ASSETS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const tasks: EmbeddedTask[] = [];
  for (const category of categories) {
    const categoryDir = path.join(TASKS_ASSETS_DIR, category);
    let entries: string[];
    try {
      entries = fs.readdirSync(categoryDir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".yml")) continue;
      const id = entry.slice(0, -4);
      const filePath = path.join(categoryDir, entry);
      let yaml: string;
      try {
        yaml = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      let parsed: ReturnType<typeof parseTaskSource>;
      try {
        parsed = parseTaskSource({ yaml, filePath, workspaceRoot: TASKS_ASSETS_DIR });
      } catch {
        continue;
      }
      // Setup defaults are trusted application metadata, not bundle-authored
      // task data. Task source can describe a schedule but cannot activate it.
      const task = parsed.v4;
      const [firstSchedule] = task.schedule;
      if (task.target.kind !== "run" || !firstSchedule) continue;
      tasks.push({
        id,
        label: `${category}/${id}`,
        command: task.target.run,
        schedule: firstSchedule.cron,
        description: task.description ?? "",
        enabled: !DEFAULT_DISABLED_TASKS.has(`${category}/${id}`),
        yaml,
      });
    }
  }
  return tasks;
}
