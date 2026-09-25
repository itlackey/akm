// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Setup wizard step for reviewing task definitions and activating schedules. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import * as p from "../../cli/clack";
import { akmTasksSync } from "../../commands/tasks/tasks";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig, mutateConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  prepareWriteTargetForMutation,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { schedulerActivationSourceId, schedulerActivations } from "../../tasks/activation-config";
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import { type EmbeddedTask, listEmbeddedTasks } from "../../tasks/embedded";
import { parseSchedule } from "../../tasks/schedule";
import type { SchedulerBackendInspection } from "../../tasks/scheduler-binding";
import {
  carryForwardSchedulerGrants,
  pendingGrantsFromInstalled,
  type SchedulerGrantCarryForwardResult,
  staleSchedulerGrantWarning,
} from "../../tasks/scheduler-grant-carry-forward";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { prompt } from "../prompt";

/**
 * A scheduled server-only nightly full sweep exists among the embedded
 * improve-schedule templates (folded in from the retired
 * `registerDefaultTasks`/`akm tasks init` path in 0.9, S6). This id is
 * preselected in the review multiselect on a detected server install — the
 * "battery heuristic" {@link detectServerDefault} preserved from that path.
 */
const SERVER_SUGGESTED_TASK_ID = "akm-improve-nightly";

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override for the two environment probes below. Inert in
// production; only tests call the setter.

interface ScheduledTasksEnvOverridesForTests {
  isCiEnvironment?: typeof isCiEnvironment;
  detectServerDefault?: typeof detectServerDefault;
}

let scheduledTasksEnvOverrides: ScheduledTasksEnvOverridesForTests | undefined;

/** TEST-ONLY. Swap the CI/server-detection probes; pass undefined to restore. */
export function _setScheduledTasksEnvForTests(fakes?: ScheduledTasksEnvOverridesForTests): void {
  scheduledTasksEnvOverrides = fakes;
}

/**
 * Decide whether `akm setup` is running in a CI environment, where it must
 * register NO scheduled tasks. Mirrors the common `CI=true` convention used by
 * GitHub Actions, GitLab CI, CircleCI, etc.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (scheduledTasksEnvOverrides?.isCiEnvironment) return scheduledTasksEnvOverrides.isCiEnvironment(env);
  const ci = env.CI;
  if (ci === undefined || ci === null) return false;
  const v = String(ci).trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/**
 * Platform-appropriate default for "Is this a server install?":
 *  - Linux without a battery → `true` (server).
 *  - macOS / any host with a battery (laptop) → `false`.
 * Used to preselect {@link SERVER_SUGGESTED_TASK_ID} in the task-review
 * multiselect.
 */
export function detectServerDefault(): boolean {
  if (scheduledTasksEnvOverrides?.detectServerDefault) return scheduledTasksEnvOverrides.detectServerDefault();
  if (os.platform() !== "linux") return false;
  // A laptop exposes a battery under /sys/class/power_supply/BAT*. Absence of
  // any battery is our heuristic for "server / desktop".
  try {
    const entries = fs.readdirSync("/sys/class/power_supply");
    const hasBattery = entries.some((e) => /^BAT/i.test(e));
    return !hasBattery;
  } catch {
    // If we cannot read power-supply info, prefer the safe server default on
    // Linux (the nightly sweep is low-impact and re-runnable).
    return true;
  }
}

function normaliseTaskIdForMatch(raw: string): string {
  return raw.trim().replace(/\.(yml|md)$/, "");
}

export interface SetupTaskDefinition {
  id: string;
  schedule: string;
  /** Every authored schedule, in parser/source order. */
  schedules?: readonly string[];
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
  /** Read-only native scheduler inventory, used to pre-check the review truthfully. */
  inspectInstalled: () => Promise<SchedulerBackendInspection>;
  carryForward: () => Promise<SchedulerGrantCarryForwardResult>;
}

export function listSetupTaskDefinitions(): SetupTaskDefinition[] {
  const config = loadConfig();
  const target = resolveWriteTarget(config, config.defaultBundle, { requireWritable: false });
  const taskDir = path.join(target.source.path, "tasks");
  const enabledRefs = new Set(
    schedulerActivations(config)
      .filter((activation) => activation.kind === "task")
      .map((activation) => activation.ref),
  );
  if (!fs.existsSync(taskDir)) return [];

  const tasks: SetupTaskDefinition[] = [];
  for (const file of fs.readdirSync(taskDir)) {
    if (!file.endsWith(".yml")) continue;
    const id = file.slice(0, -4);
    const filePath = path.join(taskDir, file);
    try {
      const parsed = parseTaskSource({
        yaml: fs.readFileSync(filePath, "utf8"),
        filePath,
        workspaceRoot: target.source.path,
      });
      const document = parsed.v4;
      if (document.schedule.length === 0) continue;
      const schedules = document.schedule.map((entry) => entry.cron);
      tasks.push({
        id,
        schedule: schedules[0]!,
        schedules: Object.freeze(schedules),
        enabled: enabledRefs.has(makeBundleRef(target.source.name, `tasks/${id}`)),
        ...(document.description !== undefined ? { description: document.description } : {}),
      });
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
  const target = prepareWriteTargetForMutation(
    resolveWriteTarget(config, config.defaultBundle, { requireWritable: true }),
  );
  const taskDir = path.join(target.source.path, "tasks");
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;

  const prepared = tasks.map((plan) => {
    const filePath = path.join(taskDir, `${plan.task.id}.yml`);
    const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
    let yaml: string;
    if (original !== undefined) {
      yaml = original;
    } else {
      const document = yamlParse(plan.task.yaml) as Record<string, unknown>;
      document.schedule = plan.schedule;
      yaml = yamlStringify(document);
    }

    const parsed = parseTaskSource({ yaml, filePath, workspaceRoot: target.source.path });
    for (const schedule of parsed.v4.schedule) {
      parseSchedule(schedule.cron, backendNameForPlatform());
    }
    return { filePath, original, yaml, ref: { type: "task" as const, name: plan.task.id } };
  });
  const changed = prepared.filter((entry) => entry.original !== entry.yaml);
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

  const selected = new Set(
    tasks.filter((plan) => plan.enabled).map((plan) => makeBundleRef(target.source.name, `tasks/${plan.task.id}`)),
  );
  const managed = new Set(tasks.map((plan) => makeBundleRef(target.source.name, `tasks/${plan.task.id}`)));
  mutateConfig((current) => {
    const existing = schedulerActivations(current);
    const next = existing.filter((activation) => activation.kind !== "task" || !managed.has(activation.ref));
    const sourceId = schedulerActivationSourceId(current, target.source.name);
    if (selected.size > 0 && !sourceId) {
      throw new UsageError(`Cannot activate setup tasks from disabled bundle ${JSON.stringify(target.source.name)}.`);
    }
    for (const ref of selected) {
      next.push({ kind: "task", ref, sourceId: sourceId! });
    }
    next.sort((left, right) => left.ref.localeCompare(right.ref) || left.kind.localeCompare(right.kind));
    if (JSON.stringify(existing) === JSON.stringify(next)) return current;
    return { ...current, scheduler: { ...current.scheduler, enabled: next } };
  });

  return changed.length;
}

const DEFAULT_SCHEDULED_TASKS_DEPS: ScheduledTasksDeps = {
  list: listSetupTaskDefinitions,
  prepare: prepareSetupTaskDefinitions,
  sync: akmTasksSync,
  inspectInstalled: async () => {
    const backend = selectBackend();
    return backend.inspectBindings ? await backend.inspectBindings({}) : { installed: [], artifacts: [] };
  },
  carryForward: () => carryForwardSchedulerGrants(),
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

  // ALL templates are offered, including ships-disabled ones (e.g. the
  // manual-recovery catchup task): an unselected template is still PREPARED,
  // so its YAML exists for `akm task run <id>` while its ref remains absent
  // from local scheduler activation. Filtering on `task.enabled`
  // here would make ships-disabled templates invisible and unpreparable.
  const embedded = listEmbeddedTasks();
  if (embedded.length === 0) return;

  const installed = await deps.list();
  const byId = new Map<string, SetupTaskDefinition>();
  for (const task of installed) byId.set(normaliseTaskIdForMatch(task.id), task);

  // `akm setup` skips startup reconciliation, so on the first command after an
  // install that dropped grants, `byId`'s `enabled` reflects a grant that a
  // carry-forward would immediately restore. Pre-check an id the operator
  // would see re-granted anyway, without mutating anything before the
  // confirmation below.
  const config = loadConfig();
  let pendingTaskIds = new Set<string>();
  try {
    const inspection = await deps.inspectInstalled();
    pendingTaskIds = new Set(
      pendingGrantsFromInstalled(inspection.installed, config)
        .filter((activation) => activation.kind === "task")
        .map((activation) => parseBundleRef(activation.ref).conceptId.replace(/^tasks\//, "")),
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    p.log.warn(`Native scheduler activation could not be inspected: ${message}`);
  }

  const preChecked = embedded
    .filter((task) => byId.get(task.id)?.enabled === true || pendingTaskIds.has(task.id))
    .map((task) => task.id);
  // Battery heuristic preserved from the retired `registerDefaultTasks` path
  // (S6): suggest the nightly full sweep on a detected server install, same
  // as every other embedded template, still gated behind the confirmation
  // below.
  if (
    !byId.has(SERVER_SUGGESTED_TASK_ID) &&
    !preChecked.includes(SERVER_SUGGESTED_TASK_ID) &&
    embedded.some((task) => task.id === SERVER_SUGGESTED_TASK_ID) &&
    detectServerDefault()
  ) {
    preChecked.push(SERVER_SUGGESTED_TASK_ID);
  }
  const selected = await prompt(() =>
    p.multiselect({
      message: "Which task definitions should be enabled? (scheduler activation is confirmed separately)",
      required: false,
      initialValues: preChecked,
      options: embedded.map((task) => {
        const current = byId.get(task.id);
        const schedule = current ? displayTaskSchedules(current) : task.schedule;
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
          `${task.id}: ${task.enabled ? "enabled" : "disabled"} | ${displayTaskSchedules(task)}${task.description ? ` | ${task.description}` : ""}`,
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

  // Carry forward any grant lost outside the wizard's own review (e.g. an upgrade that reset
  // host-local config) before `prepare` revokes every managed ref the operator left unchecked.
  // Otherwise `prepare`'s revocation is followed by carry-forward re-granting the very ref the
  // operator just deselected.
  const carryForwardResult = await deps.carryForward();
  for (const warning of carryForwardResult.warnings) p.log.warn(warning);
  for (const stale of carryForwardResult.staleGrants) p.log.warn(staleSchedulerGrantWarning(stale));
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
        "To migrate or repair existing scheduler bindings explicitly, run `akm task sync --rebind`.",
    );
    return;
  }
  p.log.success("Task schedules activated. Verify them with `akm task doctor`.");
}

function displayTaskSchedules(task: SetupTaskDefinition): string {
  return task.schedules && task.schedules.length > 0 ? task.schedules.join(", ") : task.schedule;
}
