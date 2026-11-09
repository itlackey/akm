// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task sources below version 4. 0.10 converts none of them (akm 0.9.32 did, and is the floor), so a plan that
 * found one reports it as a blocker with the recipe instead of a clean status.
 */

import { parse } from "yaml";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { bundleRoots } from "./bundle-roots";
import { inspectEngineKeyFiles } from "./migrate/engine-key-files";

const RECIPE = "run `npm i -g akm-cli@0.9.32 && akm migrate apply && akm task sync`, then upgrade";

/** One blocker line per task file whose `version` is a number below 4. */
export function legacyTaskBlockers(): string[] {
  resetConfigCache();
  const roots = bundleRoots(loadConfig()).map((root) => ({ ...root, adapter: root.adapter ?? detectAdapterId(root.root) }));
  const blockers: string[] = [];
  for (const file of inspectEngineKeyFiles(roots)) {
    if (file.role !== "task") continue;
    let version: unknown;
    try {
      version = (parse(file.bytes.toString("utf8")) as { version?: unknown } | null)?.version;
    } catch {
      continue;
    }
    if (typeof version === "number" && version < 4) {
      blockers.push(`task ${file.filePath} uses task schema version ${version}, which 0.10 does not convert: ${RECIPE}.`);
    }
  }
  return blockers;
}
