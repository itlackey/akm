// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { addressOf, writeAssets } from "../../core/assets/write";
import { isWithin } from "../../core/common";
import { loadConfig, mutateConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { commitWriteTargetBoundary, prepareWriteTargetForMutation, resolveWriteTarget } from "../../core/write-source";
import { enabledRefsFromInstalled, schedulerEnabledRefs, setSchedulerRefEnabled } from "../../tasks/activation-config";
import { selectBackend } from "../../tasks/backends";
import type { SchedulerBackend } from "../../tasks/backends/types";
import { withSchedulerLock } from "../../tasks/scheduler-lock";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { normaliseTaskId } from "../../tasks/task-id";

/** Import authored source without projecting it through task-add's reduced flag grammar. */
export async function importTaskFile(
  input: { source: string; name?: string; force?: boolean; target?: string },
  deps: { backend?: SchedulerBackend } = {},
) {
  if (input.source === "-" || /^https?:\/\//i.test(input.source)) {
    throw new UsageError("--type task requires a local task definition file.", "INVALID_FLAG_VALUE");
  }
  let yaml: string;
  try {
    // asset-io: user-input import source
    if (!fs.statSync(input.source).isFile()) {
      throw new UsageError(`Expected a readable task definition file: "${input.source}".`, "INVALID_FLAG_VALUE");
    }
    // asset-io: user-input import source
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
  return withSchedulerLock(async () => {
    const existed = addressOf(target.source.name, `tasks/${id}`).exists;
    if (existed && !input.force) {
      throw new UsageError(`Task "${id}" already exists. Pass --force to overwrite.`, "RESOURCE_ALREADY_EXISTS");
    }
    const ref = makeBundleRef(target.source.name, `tasks/${id}`);
    const prepared = prepareWriteTargetForMutation(target);
    // Capture the legacy choice while the new file is still absent, so stale
    // installed rows cannot silently activate the imported task on the next sync.
    const legacyEnabled =
      !existed && schedulerEnabledRefs(config) === undefined
        ? enabledRefsFromInstalled(await (deps.backend ?? selectBackend()).list(), config)
        : undefined;
    // Persist the disabled host choice before publishing a new file. If this
    // fails, the source must stay absent so a stale row cannot activate it.
    if (!existed) {
      if (legacyEnabled !== undefined) {
        mutateConfig((current) => ({ ...current, scheduler: { ...current.scheduler, enabled: [...legacyEnabled] } }));
      }
      if (schedulerEnabledRefs(loadConfig())?.includes(ref)) setSchedulerRefEnabled(ref, false);
    }
    // A task file that is a link leaving `tasks/` is refused here, before the write refuses links as it does for every type.
    if (!isWithin(file, path.join(target.source.path, "tasks"))) {
      throw new UsageError(
        `Resolved asset path escapes its source: "${id}" in source "${target.source.name}".`,
        "PATH_ESCAPE_VIOLATION",
      );
    }
    // An overwrite rewrites the file the task is read from, whatever its spelling.
    const written =
      writeAssets(prepared, { purpose: "import-task" }, (w) => {
        const { file: kept } = w.address(`tasks/${id}`);
        w.create({ type: "task", name: id, content: yaml }, { exclusive: !input.force });
        return kept;
      }) ?? file;
    commitWriteTargetBoundary(prepared, `Import tasks/${id}`);
    return { path: written, ref };
  });
}
