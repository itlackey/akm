// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Setup wizard step for reviewing task definitions and activating schedules. */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import * as p from "../../cli/clack";
import { isCiEnvironment } from "../../commands/tasks/default-tasks";
import { akmTasksSync, setEnabledInYaml } from "../../commands/tasks/tasks";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { backendNameForPlatform } from "../../tasks/backends";
import { type EmbeddedTask, listEmbeddedTasks } from "../../tasks/embedded";
import { parseTaskDocument } from "../../tasks/parser";
import { parseSchedule } from "../../tasks/schedule";
import { prompt } from "../prompt";

function normaliseTaskIdForMatch(raw: string): string {
  return raw.trim().replace(/\.(yml|md)$/, "");
}

export interface SetupTaskDefinition {
  id: string;
  schedule: string;
  enabled: boolean;
  description?: string;
}

export interface PreparedSetupTask {
  task: EmbeddedTask;
  schedule: string;
  enabled: boolean;
  installed: boolean;
}

export interface ScheduledTasksDeps {
  list: () => SetupTaskDefinition[] | Promise<SetupTaskDefinition[]>;
  prepare: (tasks: PreparedSetupTask[]) => Promise<number>;
  sync: typeof akmTasksSync;
}

export function listSetupTaskDefinitions(): SetupTaskDefinition[] {
  const config = loadConfig();
  const target = resolveWriteTarget(config, config.defaultBundle, { requireWritable: false });
  const taskDir = path.join(target.source.path, "tasks");
  if (!fs.existsSync(taskDir)) return [];

  const tasks: SetupTaskDefinition[] = [];
  for (const file of fs.readdirSync(taskDir)) {
    if (!file.endsWith(".yml")) continue;
    const id = file.slice(0, -4);
    const filePath = path.join(taskDir, file);
    try {
      const task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
      tasks.push({ id: task.id, schedule: task.schedule, enabled: task.enabled, description: task.description });
    } catch (error) {
      throw new UsageError(
        `Cannot review task definition ${filePath}: ${error instanceof Error ? error.message : String(error)} ` +
          "Fix or remove the invalid task, then rerun `akm setup`. No task files or scheduler state were changed.",
        "INVALID_FLAG_VALUE",
        "Fix or remove the invalid task definition, then rerun `akm setup`.",
      );
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export interface PrepareSetupTaskDefinitionsDeps {
  writeAsset?: typeof writeAssetToSource;
  deleteAsset?: typeof deleteAssetFromSource;
  commitBoundary?: typeof commitWriteTargetBoundary;
}

export async function prepareSetupTaskDefinitions(
  tasks: PreparedSetupTask[],
  deps: PrepareSetupTaskDefinitionsDeps = {},
): Promise<number> {
  const config = loadConfig();
  const target = resolveWriteTarget(config, config.defaultBundle, { requireWritable: true });
  const taskDir = path.join(target.source.path, "tasks");
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;

  const prepared = tasks.map((plan) => {
    const filePath = path.join(taskDir, `${plan.task.id}.yml`);
    const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
    let yaml: string;
    if (original !== undefined) {
      yaml = setEnabledInYaml(original, plan.enabled);
    } else {
      const document = yamlParse(plan.task.yaml) as Record<string, unknown>;
      document.schedule = plan.schedule;
      document.enabled = plan.enabled;
      yaml = yamlStringify(document);
    }

    parseTaskDocument({ yaml, filePath, id: plan.task.id });
    parseSchedule(plan.schedule, backendNameForPlatform());
    return { filePath, original, yaml, ref: { type: "task" as const, name: plan.task.id } };
  });
  const changed = prepared.filter((entry) => entry.original !== entry.yaml);
  if (changed.length === 0) return 0;

  const attempted: typeof changed = [];
  try {
    for (const entry of changed) {
      attempted.push(entry);
      await writeAsset(target.source, target.config, entry.ref, entry.yaml);
    }
    commitBoundary(target, "Prepare scheduled tasks");
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of [...attempted].reverse()) {
      try {
        if (entry.original === undefined) {
          if (fs.existsSync(entry.filePath)) await deleteAsset(target.source, target.config, entry.ref);
        } else {
          await writeAsset(target.source, target.config, entry.ref, entry.original);
          fs.writeFileSync(entry.filePath, entry.original, "utf8");
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      commitBoundary(target, "Restore scheduled tasks after failed setup");
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Task definition preparation failed and rollback was incomplete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }

  return changed.length;
}

const DEFAULT_SCHEDULED_TASKS_DEPS: ScheduledTasksDeps = {
  list: listSetupTaskDefinitions,
  prepare: prepareSetupTaskDefinitions,
  sync: akmTasksSync,
};

export async function stepScheduledTasks(
  deps: ScheduledTasksDeps = DEFAULT_SCHEDULED_TASKS_DEPS,
  options: { nonInteractive?: boolean } = {},
): Promise<void> {
  if (options.nonInteractive || isCiEnvironment()) {
    p.log.info(
      "Non-interactive setup leaves task files and scheduler state unchanged. Run `akm setup` interactively to review tasks.",
    );
    return;
  }

  const embedded = listEmbeddedTasks().filter((task) => task.enabled);
  if (embedded.length === 0) return;

  const installed = await deps.list();
  const byId = new Map<string, SetupTaskDefinition>();
  for (const task of installed) byId.set(normaliseTaskIdForMatch(task.id), task);

  const preChecked = embedded.filter((task) => byId.get(task.id)?.enabled === true).map((task) => task.id);
  const selected = await prompt(() =>
    p.multiselect({
      message: "Which core task definitions should be enabled? (scheduler activation is confirmed separately)",
      required: false,
      initialValues: preChecked,
      options: embedded.map((task) => {
        const current = byId.get(task.id);
        const schedule = current?.schedule ?? task.schedule;
        const state = current ? (current.enabled ? "enabled" : "disabled") : "not prepared";
        return {
          value: task.id,
          label: task.label,
          hint: `${task.description} - ${schedule} [${state}]`,
        };
      }),
    }),
  );
  const selectedSet = new Set(selected as string[]);

  const scheduleFor = new Map<string, string>();
  for (const task of embedded) {
    if (!selectedSet.has(task.id) || byId.has(task.id)) continue;
    const edited = await prompt(() =>
      p.text({
        message: `Schedule for ${task.label}?`,
        initialValue: task.schedule,
        validate(value) {
          const candidate = (value ?? "").trim() || task.schedule;
          try {
            parseSchedule(candidate, backendNameForPlatform());
          } catch (error) {
            return error instanceof Error ? error.message : "Invalid schedule.";
          }
          return undefined;
        },
      }),
    );
    scheduleFor.set(task.id, ((edited as string) ?? "").trim() || task.schedule);
  }

  const plans = embedded.map((task) => {
    const current = byId.get(task.id);
    return {
      task,
      schedule: current?.schedule ?? scheduleFor.get(task.id) ?? task.schedule,
      enabled: selectedSet.has(task.id),
      installed: current !== undefined,
    };
  });
  const embeddedIds = new Set(embedded.map((task) => task.id));
  const custom = installed.filter((task) => !embeddedIds.has(normaliseTaskIdForMatch(task.id)));
  p.note(
    [
      ...plans.map(
        (plan) =>
          `${plan.task.label}: ${plan.enabled ? "enabled" : "disabled"} | ${plan.schedule} | ${plan.task.description}`,
      ),
      ...custom.map(
        (task) =>
          `${task.id}: ${task.enabled ? "enabled" : "disabled"} | ${task.schedule}${task.description ? ` | ${task.description}` : ""}`,
      ),
    ].join("\n"),
    "Task Schedule Review",
  );

  const activate = await prompt(() =>
    p.confirm({
      message: `Activate these schedules now? This will update task files and sync them to the ${backendNameForPlatform()} scheduler.`,
      initialValue: false,
    }),
  );
  if (!activate) {
    p.log.info("Task definitions and scheduler state were not changed.");
    return;
  }

  const changed = await deps.prepare(plans);
  if (changed > 0) p.log.success(`Prepared ${changed} task definition${changed === 1 ? "" : "s"}.`);
  const syncResult = await deps.sync();
  if (syncResult.skipped.length > 0) {
    for (const skipped of syncResult.skipped) {
      p.log.warn(`Task "${skipped.id}" was not activated: ${skipped.reason}`);
    }
    const activeCount = syncResult.installed.length + syncResult.updated.length + syncResult.unchanged.length;
    p.log.warn(
      `${activeCount === 0 ? "No task schedules were activated." : "Task schedule activation was incomplete."} ` +
        "If you are running AKM from source, run the installed `akm setup`. " +
        "To migrate or repair existing scheduler bindings explicitly, run `akm tasks sync --rebind`.",
    );
    return;
  }
  p.log.success("Task schedules activated. Verify them with `akm tasks doctor`.");
}
