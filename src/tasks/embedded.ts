// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedded core task templates.
 *
 * A curated set of read-only YAML task templates ships inside the akm binary
 * under `src/assets/tasks/core/`. They are resolved at runtime via
 * `import.meta.dir` (mirroring `SKELETON_DIR` in
 * src/commands/stash-skeleton.ts) and are NOT written to any stash at
 * install/init time — the `akm setup` wizard copies a template into the
 * primary stash only when the user opts in (copy-on-enable).
 *
 * Each entry exposes the parsed `command`, `schedule`, and `description`
 * alongside the raw `yaml`, so the wizard can both render a choice and write
 * the file verbatim (with an optional schedule edit applied).
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { getDirname } from "../runtime";

/** Directory holding the bundled core task templates. */
const CORE_TASKS_DIR = path.join(getDirname(import.meta.url), "../assets/tasks/core");

export interface EmbeddedTask {
  /**
   * Task id as written to disk and registered with the scheduler — the
   * template filename without its `.yml` suffix (e.g. `improve`). This is the
   * id matched against `akm tasks list` output.
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
 * Enumerate the embedded core task templates from the bundled assets
 * directory. Sorted by id for deterministic ordering. Returns an empty array
 * if the directory is missing (defensive — a build without assets should not
 * crash the wizard).
 */
export function listEmbeddedTasks(): EmbeddedTask[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(CORE_TASKS_DIR);
  } catch {
    return [];
  }

  const tasks: EmbeddedTask[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yml")) continue;
    const id = entry.slice(0, -4);
    const filePath = path.join(CORE_TASKS_DIR, entry);
    let yaml: string;
    try {
      yaml = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let doc: { command?: unknown; schedule?: unknown; description?: unknown; enabled?: unknown };
    try {
      doc = yamlParse(yaml) ?? {};
    } catch {
      continue;
    }
    const command = typeof doc.command === "string" ? doc.command : "";
    const schedule = typeof doc.schedule === "string" ? doc.schedule : "";
    const description = typeof doc.description === "string" ? doc.description : "";
    const enabled = doc.enabled !== false;
    tasks.push({
      id,
      label: `core/${id}`,
      command,
      schedule,
      description,
      enabled,
      yaml,
    });
  }
  return tasks;
}
