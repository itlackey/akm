// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task sources below version 4. 0.10 converts none of them (akm 0.9.32 did, and is the floor). One in `scheduler.enabled`
 * would silently stop running, so it is a blocker with the recipe; one that is not enabled (an installed bundle's, say)
 * is a warning naming the file, which never changes the status. `akm lint` reports it as invalid.
 */

import path from "node:path";
import { parse } from "yaml";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { schedulerEnabledRefs } from "../../src/tasks/activation-config";
import { bundleRoots } from "./bundle-roots";
import { inspectEngineKeyFiles } from "./migrate/engine-key-files";

const RECIPE = "run `npm i -g akm-cli@0.9.32 && akm migrate apply && akm task sync`, then upgrade";

/** Task files whose `version` is a number below 4: the enabled ones as `blockers`, the rest as `warnings`. */
export function legacyTasks(): { blockers: string[]; warnings: string[] } {
  resetConfigCache();
  const config = loadConfig();
  const enabled = new Set(schedulerEnabledRefs(config) ?? []);
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const root of bundleRoots(config)) {
    const withAdapter = { ...root, adapter: root.adapter ?? detectAdapterId(root.root) };
    for (const file of inspectEngineKeyFiles([withAdapter])) {
      if (file.role !== "task") continue;
      let version: unknown;
      try {
        version = (parse(file.bytes.toString("utf8")) as { version?: unknown } | null)?.version;
      } catch {
        continue;
      }
      if (typeof version !== "number" || version >= 4) continue;
      const ref = `${root.bundleId}//${path.relative(root.root, file.filePath).split(path.sep).join("/").replace(/\.yml$/, "")}`;
      if (enabled.has(ref)) {
        blockers.push(`task ${file.filePath} (${ref}) is enabled and uses task schema version ${version}, which 0.10 does not convert, so it would stop running: ${RECIPE}.`);
      } else {
        warnings.push(`task ${file.filePath} uses task schema version ${version}, which 0.10 does not read or convert; it is not enabled, so nothing is lost (${RECIPE}).`);
      }
    }
  }
  return { blockers, warnings };
}
