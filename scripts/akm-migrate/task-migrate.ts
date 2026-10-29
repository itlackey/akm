// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The task-file migration step: every bundle's task directory, planned to task source v4 and rewritten under one backup. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { getDataDir } from "../../src/core/paths";
import { type BundleRoot, bundleRoots } from "./bundle-roots";
import type { TaskToV4MigrationPlan } from "./migrate/task-to-v4";
import { applyTaskFilesPlan, inspectTaskFiles, planTaskFilesMigration, type TaskFileRoot } from "./migrate/task-files";

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
    return {
      ...inspectCurrent().result,
      backupPath,
      applied: applied.changed.length,
      ...(applied.conflicts.length > 0 ? { conflicts: [...applied.conflicts] } : {}),
    };
  });
}
