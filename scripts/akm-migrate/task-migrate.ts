// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The complete migration surface: explicit task-v2 files to task-v3 files. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { bundleComponentConfig, bundlesToSourceEntries } from "../../src/core/config/config-sources";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { pruneToNewest, withConfigLock } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { getDataDir } from "../../src/core/paths";
import { resolveWritable } from "../../src/core/write-source";
import { lockContentRootFor } from "../../src/integrations/lockfile";
import { applyTaskToV3MigrationPlan, inspectTaskToV3Files, type TaskToV3Root } from "./migrate/task-files-to-v3";
import { planTaskToV3Migration, type TaskToV3MigrationPlan } from "../../src/tasks/source/task-to-v3";
import { applyTaskToV4MigrationPlan, inspectTaskToV4Files } from "./migrate/task-files-to-v4";
import { planTaskToV4Migration, type TaskToV4MigrationPlan } from "../../src/tasks/source/task-to-v4";

export interface TaskV3MigrationFileSummary {
  filePath: string;
  status: "changed" | "skipped" | "blocked";
  reason: string;
  beforeHash: string;
  afterHash?: string;
  detail?: string;
}

export interface TaskV3MigrationSummary {
  schemaVersion: 1;
  generation: string;
  changed: number;
  skipped: number;
  blocked: number;
  files: TaskV3MigrationFileSummary[];
}

export interface MigrationPlan {
  schemaVersion: 1;
  status: "current" | "ready" | "blocked";
  blockers: string[];
  taskV3Migration: TaskV3MigrationSummary;
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
function reconcileDuplicateRoot(existing: TaskToV3Root, candidate: TaskToV3Root, sharedPath: string): void {
  if (existing.writable === candidate.writable && existing.layout === candidate.layout) return;
  throw new ConfigError(
    `Bundles "${existing.bundleId}" and "${candidate.bundleId}" both resolve to the same directory ` +
      `(${sharedPath}) but disagree on writable/adapter settings. Two bundle ids configured for one ` +
      "directory must have matching settings, or one of them removed — run `akm bundle list` to see both.",
    "INVALID_CONFIG_FILE",
  );
}

function taskRoots(config: AkmConfig, resolutionBase = process.cwd()): TaskToV3Root[] {
  const sources = new Map((bundlesToSourceEntries(config) ?? []).map((source) => [source.name, source]));
  const rootsByPath = new Map<string, TaskToV3Root>();
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
    const candidate: TaskToV3Root = {
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

function summarize(plan: TaskToV3MigrationPlan): TaskV3MigrationSummary {
  const files = plan.files.map((file) => ({
    filePath: file.filePath,
    status: file.status,
    reason: file.reason,
    beforeHash: file.beforeHash,
    ...(file.status === "changed" ? { afterHash: file.afterHash } : {}),
    ...(file.detail ? { detail: file.detail } : {}),
  }));
  return {
    schemaVersion: 1,
    generation: plan.generation,
    changed: files.filter((file) => file.status === "changed").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    blocked: files.filter((file) => file.status === "blocked").length,
    files,
  };
}

function blockerText(plan: TaskToV3MigrationPlan): string[] {
  return plan.files.flatMap((file) =>
    file.status === "blocked"
      ? [`${file.filePath}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`]
      : [],
  );
}

function inspectCurrentTaskPlan(): { result: MigrationPlan; plan: TaskToV3MigrationPlan } {
  resetConfigCache();
  const config = loadConfig();
  const plan = planTaskToV3Migration(inspectTaskToV3Files(taskRoots(config)));
  const blockers = blockerText(plan);
  const summary = summarize(plan);
  return {
    plan,
    result: {
      schemaVersion: 1,
      status: blockers.length > 0 ? "blocked" : summary.changed > 0 ? "ready" : "current",
      blockers,
      taskV3Migration: summary,
    },
  };
}

export function inspectMigrationPlan(): MigrationPlan {
  return inspectCurrentTaskPlan().result;
}

/**
 * Snapshot dirs kept per generation under `<dataDir>/backups/task-v3|task-v4`
 * (#897): one apply run writes one timestamped-UUID dir and nothing pruned
 * them. Same cap as config backups; the legacy `backups/{migrations,manual,
 * releases,operations}` dirs are not written by current code and are left alone.
 */
const MAX_TASK_MIGRATION_BACKUPS = 5;

export function pruneTaskMigrationBackups(generationBackupDir: string): void {
  pruneToNewest(generationBackupDir, MAX_TASK_MIGRATION_BACKUPS, (entry) => entry.isDirectory());
}

/** Convert eligible task-v2 files to task v3 and return the resulting plan. */
export function applyTaskV3Migration(): MigrationPlan {
  return withConfigLock(() => {
      const before = inspectCurrentTaskPlan();
      // Blocked files are skipped, not fatal: migrate whatever in the batch
      // can be migrated and report the rest as blocked (the entrypoint exits
      // non-zero whenever any file is still blocked afterward).
      if (before.result.taskV3Migration.changed === 0) return before.result;
      const backupRoot = path.join(getDataDir(), "backups", "task-v3");
      const backupPath = path.join(backupRoot, `${Date.now()}-${randomUUID()}`);
      const applied = applyTaskToV3MigrationPlan(before.plan, { backupRoot: backupPath });
      const after = inspectCurrentTaskPlan().result;
      if (after.taskV3Migration.changed > 0) {
        throw new ConfigError("Task migration did not converge to task v3.", "INVALID_CONFIG_FILE");
      }
      pruneTaskMigrationBackups(backupRoot);
      return { ...after, backupPath, applied: applied.changed.length };
  });
}

// ─── Second generation: task v3 -> task source v4 (spec docs/plans/specs/p2b-input-bindings.md §5) ───
// Wired the SAME way as the v2 -> v3 generation above: same withConfigLock +
// timestamped-UUID backup root + --dry-run plan
// + summary shape. `taskRoots` is version-agnostic (it only locates each
// bundle's task directory; it never reads file contents) so it is reused
// as-is — `TaskToV3Root`'s fields are structurally identical to `TaskToV4Root`.

export interface TaskV4MigrationFileSummary {
  filePath: string;
  status: "changed" | "skipped" | "blocked";
  reason: string;
  beforeHash: string;
  afterHash?: string;
  detail?: string;
  notice?: string;
}

export interface TaskV4MigrationSummary {
  schemaVersion: 1;
  generation: string;
  changed: number;
  skipped: number;
  blocked: number;
  files: TaskV4MigrationFileSummary[];
}

export interface TaskV4MigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready" | "blocked";
  blockers: string[];
  taskV4Migration: TaskV4MigrationSummary;
  backupPath?: string;
  applied?: number;
}

function summarizeV4(plan: TaskToV4MigrationPlan): TaskV4MigrationSummary {
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
    generation: plan.generation,
    changed: files.filter((file) => file.status === "changed").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    blocked: files.filter((file) => file.status === "blocked").length,
    files,
  };
}

function blockerTextV4(plan: TaskToV4MigrationPlan): string[] {
  return plan.files.flatMap((file) =>
    file.status === "blocked"
      ? [`${file.filePath}: ${file.reason}${file.detail ? ` (${file.detail})` : ""}`]
      : [],
  );
}

function inspectCurrentTaskV4Plan(): { result: TaskV4MigrationStatus; plan: TaskToV4MigrationPlan } {
  resetConfigCache();
  const config = loadConfig();
  const plan = planTaskToV4Migration(inspectTaskToV4Files(taskRoots(config)));
  const blockers = blockerTextV4(plan);
  const summary = summarizeV4(plan);
  return {
    plan,
    result: {
      schemaVersion: 1,
      status: blockers.length > 0 ? "blocked" : summary.changed > 0 ? "ready" : "current",
      blockers,
      taskV4Migration: summary,
    },
  };
}

export function inspectTaskV4MigrationStatus(): TaskV4MigrationStatus {
  return inspectCurrentTaskV4Plan().result;
}

/** Convert eligible task-v3 files to task source v4 and return the resulting plan. */
export function applyTaskV4Migration(): TaskV4MigrationStatus {
  return withConfigLock(() => {
      const before = inspectCurrentTaskV4Plan();
      // Blocked files are skipped, not fatal: migrate whatever in the batch
      // can be migrated and report the rest as blocked (the entrypoint exits
      // non-zero whenever any file is still blocked afterward).
      if (before.result.taskV4Migration.changed === 0) return before.result;
      const backupRoot = path.join(getDataDir(), "backups", "task-v4");
      const backupPath = path.join(backupRoot, `${Date.now()}-${randomUUID()}`);
      const applied = applyTaskToV4MigrationPlan(before.plan, { backupRoot: backupPath });
      const after = inspectCurrentTaskV4Plan().result;
      if (after.taskV4Migration.changed > 0) {
        throw new ConfigError("Task migration did not converge to task source v4.", "INVALID_CONFIG_FILE");
      }
      pruneTaskMigrationBackups(backupRoot);
      return { ...after, backupPath, applied: applied.changed.length };
  });
}
