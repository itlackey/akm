// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task-file migration step: the task files and workflow files named on the command line, converted to task source
 * v5 under one backup. No file that is not named is changed.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type WorkflowFilesOfBundle, workflowFilesIn } from "../../src/commands/health/workflow-files";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { getDataDir } from "../../src/core/paths";
import { type BundleRoot, bundleRoots } from "./bundle-roots";
import {
  checkConvertedTaskFiles,
  createFiles,
  inspectTaskFiles,
  replaceFilesWithBackups,
  type TaskFileInput,
  type TaskFileRoot,
} from "./migrate/task-files";
import { planTaskToV5File, type TaskToV5Converted, type TaskToV5Outcome } from "./migrate/task-to-v5";
import {
  checkFailureGuidance,
  planWorkflowToV5File,
  type WorkflowToV5Converted,
  type WorkflowToV5Outcome,
  workflowBlocked,
} from "./migrate/workflow-to-v5";

/** Every enabled bundle's task directory: the roots whose adapter holds task sources. */
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
  taskFiles: readonly TaskFileInput[],
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
 * Plan version 5 for the named files, and check each conversion as a start checks it. A named workflow file becomes a
 * task file that does not exist yet.
 */
async function planNamed(named: readonly string[]): Promise<{
  outcomes: (TaskToV5Outcome | WorkflowToV5Outcome)[];
  converted: TaskToV5Converted[];
  created: WorkflowToV5Converted[];
}> {
  resetConfigCache();
  const roots = taskRoots(loadConfig());
  const inputs: TaskFileInput[] = inspectTaskFiles(roots);
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
    planned.set(input.filePath, planTaskToV5File(input));
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
 * with why.
 */
export async function applyTaskFilesV5Migration(named: readonly string[]): Promise<TaskFilesV5MigrationStatus> {
  const { outcomes, converted, created } = await planNamed(named);
  if (converted.length + created.length === 0) return v5Status(outcomes, false);
  const backupPath = path.join(getDataDir(), "backups", "tasks", `${Date.now()}-${randomUUID()}`);
  const { replaced, made, conflicts } = withConfigLock(() => {
    const replacing = replaceFilesWithBackups(converted, backupPath);
    const making = createFiles(
      created.map((file) => ({ filePath: file.taskPath, after: file.after, mode: file.mode })),
    );
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
