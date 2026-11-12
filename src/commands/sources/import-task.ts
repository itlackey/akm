// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import {
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../sources/write-source";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../../tasks/activation-config";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { normaliseTaskId } from "../../tasks/task-id";

/** Import authored source without projecting it through task-add's reduced flag grammar. */
export async function importTaskFile(input: { source: string; name?: string; force?: boolean; target?: string }) {
  if (input.source === "-" || /^https?:\/\//i.test(input.source)) {
    throw new UsageError("--type task requires a local task definition file.", "INVALID_FLAG_VALUE");
  }
  let yaml: string;
  try {
    if (!fs.statSync(input.source).isFile()) {
      throw new UsageError(`Expected a readable task definition file: "${input.source}".`, "INVALID_FLAG_VALUE");
    }
    yaml = fs.readFileSync(input.source, "utf8");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (!(error instanceof Error) || !("code" in error)) throw error;
    throw new UsageError(`Expected a readable task definition file: "${input.source}".`, "INVALID_FLAG_VALUE");
  }
  parseTaskSource({ yaml, filePath: input.source });
  const id = normaliseTaskId(input.name ?? path.basename(input.source).replace(/\.ya?ml$/i, ""));
  const config = loadConfig();
  const target = resolveWriteTarget(config, input.target, { requireWritable: true, flag: "--bundle" });
  const file = assetPathForName("task", path.join(target.source.path, "tasks"), id);
  const existed = fs.existsSync(file);
  if (existed && !input.force) {
    throw new UsageError(`Task "${id}" already exists. Pass --force to overwrite.`, "RESOURCE_ALREADY_EXISTS");
  }
  const ref = makeBundleRef(target.source.name, `tasks/${id}`);
  const prepared = prepareWriteTargetForMutation(target);
  // Importing never activates a task: `akm task enable` does. Persist that host choice before publishing a new
  // file, so a ref left on the list by an earlier task of the same id cannot activate the imported one.
  if (!existed && schedulerEnabledRefs(loadConfig())?.includes(ref)) setSchedulerRefEnabled(ref, false);
  const result = await writeAssetToSource(prepared.source, prepared.config, { type: "task", name: id }, yaml);
  commitWriteTargetBoundary(prepared, `Import tasks/${id}`);
  return { ...result, ref };
}
