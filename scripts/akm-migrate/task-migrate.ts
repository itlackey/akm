// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The task-file migration step: every bundle's task directory, planned to task source v4 and rewritten under one backup. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { bundleComponentConfig, bundlesToSourceEntries } from "../../src/core/config/config-sources";
import { ConfigError } from "../../src/core/errors";
import { getDataDir } from "../../src/core/paths";
import { resolveWritable } from "../../src/core/write-source";
import { lockContentRootFor } from "../../src/integrations/lockfile";
import type { TaskToV4MigrationPlan } from "../../src/tasks/source/task-to-v4";
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
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function existingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/**
 * Reconcile two bundle roots that resolve to the same directory on disk
 * (issue #870 — e.g. `AKM_BUNDLE_DIR` pointed at a directory already
 * configured under a different bundle id). When the two roots agree on
 * everything that matters for migration (writability, layout) the
 * duplicate is silently dropped so each task file is enumerated once,
 * rather than surfacing as the opaque `duplicate task migration file path`
 * error further down the pipeline. When they disagree, name both bundle
 * ids and the shared path so the operator knows exactly what to fix.
 */
function reconcileDuplicateRoot(existing: TaskFileRoot, candidate: TaskFileRoot, sharedPath: string): void {
  if (existing.writable === candidate.writable && existing.layout === candidate.layout) return;
  throw new ConfigError(
    `Bundles "${existing.bundleId}" and "${candidate.bundleId}" both resolve to the same directory ` +
      `(${sharedPath}) but disagree on writable/adapter settings. Two bundle ids configured for one ` +
      "directory must have matching settings, or one of them removed — run `akm bundle list` to see both.",
    "INVALID_CONFIG_FILE",
  );
}

function taskRoots(config: AkmConfig, resolutionBase = process.cwd()): TaskFileRoot[] {
  const sources = new Map((bundlesToSourceEntries(config) ?? []).map((source) => [source.name, source]));
  const rootsByPath = new Map<string, TaskFileRoot>();
  for (const [bundleId, bundle] of Object.entries(config.bundles ?? {})) {
    if (bundle.enabled === false) continue;
    const source = sources.get(bundleId);
    if (!source) continue;
    const configuredRoot =
      source.type === "filesystem" && source.path
        ? path.resolve(resolutionBase, expandTilde(source.path))
        : lockContentRootFor(bundleId, source.type);
    if (!configuredRoot || !existingDirectory(configuredRoot)) continue;

    const bundleRoot = path.resolve(configuredRoot);
    const component = bundleComponentConfig(bundle);
    const componentRoot = path.resolve(bundleRoot, component?.root ?? ".");
    const relative = path.relative(bundleRoot, componentRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ConfigError(
        `Task migration component root ${componentRoot} escapes bundle ${bundleId} at ${bundleRoot}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    if (!existingDirectory(componentRoot)) continue;

    const adapter = component?.adapter ?? detectAdapterId(componentRoot, "");
    if (!component?.adapter && adapter === "") {
      const flatTasks = fs
        .readdirSync(componentRoot, { withFileTypes: true })
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
    if (adapter !== "akm" && adapter !== "akm-task") continue;
    const candidate: TaskFileRoot = {
      bundleId,
      root: componentRoot,
      bundleRoot,
      writable: component?.writable ?? resolveWritable(source),
      layout: adapter === "akm-task" ? "akm-task" : "akm-stash",
    };
    const existing = rootsByPath.get(componentRoot);
    if (existing) {
      reconcileDuplicateRoot(existing, candidate, componentRoot);
      continue;
    }
    rootsByPath.set(componentRoot, candidate);
  }
  return [...rootsByPath.values()];
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
    return { ...inspectCurrent().result, backupPath, applied: applied.changed.length };
  });
}
