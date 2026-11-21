// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The task-file migration step: every bundle's task directory, planned to task source v4 and rewritten under one backup. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { type WorkflowFilesOfBundle, workflowFilesIn } from "../../src/commands/health/workflow-files";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { getDataDir } from "../../src/core/paths";
import { type BundleRoot, bundleRoots } from "./bundle-roots";
import type { TaskToV4MigrationPlan } from "./migrate/task-to-v4";
import {
  applyTaskFilesPlan,
  checkConvertedTaskFiles,
  createFiles,
  inspectTaskFiles,
  planTaskFilesMigration,
  replaceFilesWithBackups,
  type TaskFileRoot,
} from "./migrate/task-files";
import type { TaskToV4FileInput } from "./migrate/task-to-v4";
import { planTaskToV5File, type TaskToV5Converted, type TaskToV5Outcome } from "./migrate/task-to-v5";
import {
  checkFailureGuidance,
  planWorkflowToV5File,
  type WorkflowToV5Converted,
  type WorkflowToV5Outcome,
  workflowBlocked,
} from "./migrate/workflow-to-v5";

export interface TaskFileSummary {
  filePath: string;
  status: "changed" | "skipped" | "blocked";
  reason: string;
  beforeHash: string;
  afterHash?: string;
  detail?: string;
  notice?: string;
}

export interface TaskFilesSummary {
  schemaVersion: 1;
  changed: number;
  skipped: number;
  blocked: number;
  files: TaskFileSummary[];
}

export interface TaskFilesMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready" | "blocked";
  blockers: string[];
  taskFiles: TaskFilesSummary;
  backupPath?: string;
  applied?: number;
  /** Files that changed after they were planned and were left as they are: a run again plans them afresh. */
  conflicts?: string[];
}

/** Every enabled bundle's task directory, and the working stash's: the roots whose adapter holds task sources. */
function taskRoots(config: AkmConfig): TaskFileRoot[] {
  return bundleRoots(config).flatMap((root) => {
    const tasks = taskRoot(root);
    return tasks ? [tasks] : [];
  });
}

/** One task root, or none when its adapter holds no tasks. */
function taskRoot(candidate: BundleRoot): TaskFileRoot | undefined {
  const { bundleId, bundleRoot, root, writable } = candidate;
  const adapter = candidate.adapter ?? detectAdapterId(root, "");
  if (!candidate.adapter && adapter === "") {
    const flatTasks = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
      .map((entry) => entry.name)
      .sort();
    if (flatTasks.length > 0) {
      throw new ConfigError(
        `Task migration cannot classify top-level task file(s) ${flatTasks.join(", ")} in bundle ${bundleId}; configure adapter "akm-task" or move them under tasks/.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  if (adapter !== "akm" && adapter !== "akm-task") return undefined;
  return { bundleId, root, bundleRoot, writable, layout: adapter === "akm-task" ? "akm-task" : "akm-stash" };
}

function summarize(plan: TaskToV4MigrationPlan): TaskFilesSummary {
  const files = plan.files.map((file) => ({
    filePath: file.filePath,
    status: file.status,
    reason: file.reason,
    beforeHash: file.beforeHash,
    ...(file.status === "changed" ? { afterHash: file.afterHash } : {}),
    ...(file.detail ? { detail: file.detail } : {}),
    ...(file.status === "changed" && file.notice ? { notice: file.notice } : {}),
  }));
  return {
    schemaVersion: 1,
    changed: files.filter((file) => file.status === "changed").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    blocked: files.filter((file) => file.status === "blocked").length,
    files,
  };
}

function inspectCurrent(): { result: TaskFilesMigrationStatus; plan: TaskToV4MigrationPlan } {
  resetConfigCache();
  const plan = planTaskFilesMigration(inspectTaskFiles(taskRoots(loadConfig())));
  const blockers = plan.files.flatMap((file) =>
    file.status === "blocked" ? [`${file.filePath}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`] : [],
  );
  const summary = summarize(plan);
  return {
    plan,
    result: {
      schemaVersion: 1,
      status: blockers.length > 0 ? "blocked" : summary.changed > 0 ? "ready" : "current",
      blockers,
      taskFiles: summary,
    },
  };
}

/** Read-only: what `apply` would rewrite, and what it cannot. */
export function inspectTaskFilesMigration(): TaskFilesMigrationStatus {
  return inspectCurrent().result;
}

/**
 * Rewrite every v2/v3 task file (and every v4 file still carrying the
 * retired `schedule[].enabled` key) as task source v4, under one backup
 * directory for the run. Blocked files are skipped, not fatal: whatever can
 * be migrated is, and the rest is reported (the entrypoint exits non-zero
 * while any file is still blocked).
 */
export function applyTaskFilesMigration(): TaskFilesMigrationStatus {
  return withConfigLock(() => {
    const before = inspectCurrent();
    if (before.result.taskFiles.changed === 0) return before.result;
    const backupPath = path.join(getDataDir(), "backups", "tasks", `${Date.now()}-${randomUUID()}`);
    const applied = applyTaskFilesPlan(before.plan, { backupRoot: backupPath });
    // The files are those the run rewrote (with their hashes); a file left as it was (a conflict) is not reported as
    // changed. Status and blockers are what the files are now.
    const rewritten = new Set(applied.changed);
    const files = before.result.taskFiles.files.filter((file) => file.status !== "changed" || rewritten.has(file.filePath));
    return {
      ...inspectCurrent().result,
      taskFiles: { ...before.result.taskFiles, changed: applied.changed.length, files },
      backupPath,
      applied: applied.changed.length,
      ...(applied.conflicts.length > 0 ? { conflicts: [...applied.conflicts] } : {}),
    };
  });
}

/** One task or workflow file named for conversion to version 5, and what became of it. */
export interface TaskFileV5Summary {
  filePath: string;
  status: "converted" | "skipped" | "blocked";
  reason: string;
  detail?: string;
  /** What version 4 or the workflow did that version 5 does not, to change by hand. */
  notes?: readonly string[];
  /** The task file a converted workflow was written to. */
  taskFile?: string;
  /** What to change, and how, for a workflow that is blocked. */
  guidance?: string;
}

export interface TaskFilesV5MigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready" | "blocked";
  blockers: string[];
  files: TaskFileV5Summary[];
  backupPath?: string;
  applied?: number;
  /** Files that changed after they were planned and were left as they are. */
  conflicts?: string[];
}

function realPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function blockedV5(filePath: string, reason: string, detail: string): TaskToV5Outcome {
  return { status: "blocked", filePath, before: Buffer.alloc(0), beforeHash: "", mode: 0, reason, detail };
}

/** The root whose workflows folder holds `file`, with the workflow's name (`<name>` of `workflows/<name>.md`). */
function workflowOf(roots: readonly TaskFileRoot[], file: string): { root: TaskFileRoot; name: string } | undefined {
  if (!file.endsWith(".md")) return undefined;
  for (const root of roots) {
    if (root.layout === "akm-task") continue;
    const relative = path.relative(realPath(path.join(root.root, "workflows")), file);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    return { root, name: relative.split(path.sep).join("/").replace(/\.md$/, "") };
  }
  return undefined;
}

function planWorkflow(
  root: TaskFileRoot,
  name: string,
  file: string,
  taskFiles: readonly TaskToV4FileInput[],
): WorkflowToV5Outcome {
  const stat = fs.lstatSync(file);
  const taskPath = path.join(root.root, "tasks", `${name}.yml`);
  const named = new RegExp(`workflows/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_/-])`);
  return planWorkflowToV5File({
    filePath: file,
    bytes: fs.readFileSync(file),
    mode: stat.mode & 0o777,
    writable: root.writable,
    name,
    taskPath,
    taskExists: fs.existsSync(taskPath),
    namedBy: taskFiles.filter((task) => named.test(task.bytes.toString("utf8"))).map((task) => task.filePath),
  });
}

/**
 * Plan version 5 for the named files, and check each conversion as a start checks it. A file the version 4 step
 * rewrites is converted from the bytes that step writes (`apply` has written them by now; a preview has not), so a
 * preview and an apply convert the same file. A named workflow file becomes a task file that does not exist yet.
 */
async function planNamed(named: readonly string[]): Promise<{
  outcomes: (TaskToV5Outcome | WorkflowToV5Outcome)[];
  converted: TaskToV5Converted[];
  created: WorkflowToV5Converted[];
}> {
  resetConfigCache();
  const roots = taskRoots(loadConfig());
  const inputs: TaskToV4FileInput[] = inspectTaskFiles(roots);
  const v4 = planTaskFilesMigration(inputs);
  const outcomes: (TaskToV5Outcome | WorkflowToV5Outcome)[] = [];
  const planned = new Map<string, TaskToV5Outcome>();
  const workflows = new Map<string, WorkflowToV5Outcome>();
  for (const name of new Set(named.map(realPath))) {
    const input = inputs.find((candidate) => realPath(candidate.filePath) === name);
    const workflow = input ? undefined : workflowOf(roots, name);
    if (workflow && fs.statSync(name, { throwIfNoEntry: false })?.isFile()) {
      workflows.set(name, planWorkflow(workflow.root, workflow.name, name, inputs));
      continue;
    }
    if (!input) {
      outcomes.push(
        blockedV5(
          name,
          "not-a-task-file",
          "it is not a .yml file under the tasks folder, or a .md file under the workflows folder, of an enabled bundle",
        ),
      );
      continue;
    }
    const earlier = v4.files.find((file) => file.filePath === input.filePath);
    if (earlier?.status === "blocked") {
      outcomes.push(
        blockedV5(
          input.filePath,
          "version-4-step-blocked",
          `${earlier.reason}${earlier.detail ? ` (${earlier.detail})` : ""}`,
        ),
      );
      continue;
    }
    planned.set(input.filePath, planTaskToV5File(input, earlier?.status === "changed" ? earlier.after : input.bytes));
  }
  const converted = [...planned.values()].filter(
    (outcome): outcome is TaskToV5Converted => outcome.status === "converted",
  );
  const convertedWorkflows = [...workflows.values()].filter(
    (outcome): outcome is WorkflowToV5Converted => outcome.status === "converted",
  );
  const failures = await checkConvertedTaskFiles(roots, [
    ...converted,
    ...convertedWorkflows.map((outcome) => ({ filePath: outcome.taskPath, after: outcome.after })),
  ]);
  for (const [filePath, outcome] of planned) {
    const failure = failures.get(filePath);
    outcomes.push(failure === undefined ? outcome : blockedV5(filePath, "version-5-check-failed", failure));
  }
  for (const outcome of workflows.values()) {
    const failure = outcome.status === "converted" ? failures.get(outcome.taskPath) : undefined;
    outcomes.push(
      outcome.status === "converted" && failure !== undefined
        ? workflowBlocked(outcome.filePath, "version-5-check-failed", failure, checkFailureGuidance(outcome.name))
        : outcome,
    );
  }
  return {
    outcomes,
    converted: converted.filter((file) => !failures.has(file.filePath)),
    created: convertedWorkflows.filter((file) => !failures.has(file.taskPath)),
  };
}

function v5Status(
  outcomes: readonly (TaskToV5Outcome | WorkflowToV5Outcome)[],
  pending: boolean,
  conflicts: readonly string[] = [],
): TaskFilesV5MigrationStatus {
  const files = outcomes
    .map((outcome): TaskFileV5Summary => {
      const written = outcome.status === "converted" && "taskPath" in outcome ? outcome.taskPath : outcome.filePath;
      if (outcome.status === "converted" && conflicts.includes(written)) {
        return {
          filePath: outcome.filePath,
          status: "blocked",
          reason: "changed-since-planned",
          detail: "the file changed after it was planned and was left as it is; run again",
        };
      }
      return {
        filePath: outcome.filePath,
        status: outcome.status,
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.status === "converted" && outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
        ...(outcome.status === "converted" && "taskPath" in outcome ? { taskFile: outcome.taskPath } : {}),
        ...(outcome.status === "blocked" && "guidance" in outcome ? { guidance: outcome.guidance } : {}),
      };
    })
    .sort((left, right) => (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0));
  const blockers = files
    .filter((file) => file.status === "blocked")
    .map((file) => `${file.filePath}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`);
  return { schemaVersion: 1, status: blockers.length > 0 ? "blocked" : pending ? "ready" : "current", blockers, files };
}

/** The workflow files left in the writable roots a named workflow file is converted in (see {@link workflowOf}). */
export function remainingWorkflowFiles(): WorkflowFilesOfBundle[] {
  const config = loadConfig();
  const first = (root: TaskFileRoot): number => Number(root.bundleId === config.defaultBundle);
  return taskRoots(config)
    .filter((root) => root.writable && root.layout !== "akm-task")
    .sort((a, b) => first(b) - first(a))
    .map((root) => ({ bundle: root.root, files: workflowFilesIn(root.root) }))
    .filter((entry) => entry.files.length > 0);
}

/** Read-only: what `apply` would convert of the named files to version 5, and what it cannot. */
export async function inspectTaskFilesV5Migration(named: readonly string[]): Promise<TaskFilesV5MigrationStatus> {
  const { outcomes, converted, created } = await planNamed(named);
  return v5Status(outcomes, converted.length + created.length > 0);
}

/**
 * Convert the named task files to task source v5 under one backup directory for the run, and make a task file of
 * each named workflow file, which stays where it is. A file that is not converted is left as it is and reported
 * with why. Run after {@link applyTaskFilesMigration}, whose result a named version 2 or 3 file is converted from.
 */
export async function applyTaskFilesV5Migration(named: readonly string[]): Promise<TaskFilesV5MigrationStatus> {
  const { outcomes, converted, created } = await planNamed(named);
  if (converted.length + created.length === 0) return v5Status(outcomes, false);
  const backupPath = path.join(getDataDir(), "backups", "tasks", `${Date.now()}-${randomUUID()}`);
  const { replaced, made, conflicts } = withConfigLock(() => {
    const replacing = replaceFilesWithBackups(converted, backupPath);
    const making = createFiles(created.map((file) => ({ filePath: file.taskPath, after: file.after, mode: file.mode })));
    return {
      replaced: replacing.replaced,
      made: making.created,
      conflicts: [...replacing.conflicts, ...making.conflicts],
    };
  });
  return {
    ...v5Status(outcomes, false, conflicts),
    ...(converted.length > 0 ? { backupPath } : {}),
    applied: replaced.length + made.length,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}
