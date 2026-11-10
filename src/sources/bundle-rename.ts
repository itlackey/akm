// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle rename <old> <new>` (D6) — the one command allowed to change a
 * bundle's key. A bundle id is a mass identity prefix: every durable ref this
 * tool minted (`entries.item_ref`/`bundle_id`, `proposals.ref`, a pending
 * proposal's `proposedTarget.source`, a workflow task_history row's
 * `target_ref`, a `workflow_runs.workflow_ref`, a `usage_events.entry_ref`, an
 * `events.ref`, an `asset_salience`/`asset_outcome` `asset_ref`, an
 * `improve_ledger.ref`, `scheduler.enabled[].ref`) carries it, and a hand-edited
 * `bundles` key strands all of it (see `src/indexer/bundle-identity-guard.ts`
 * §11.5). This module is the rekey transaction that guard's docstring points
 * to.
 *
 * Rewritten: the config `bundles` key, `defaultBundle`
 * and `projects.*.write.bundle`/`projects.*.from` when they name the old id, every `scheduler.enabled[].ref` with the old
 * `//` prefix, the lockfile entry id, and the index/state rows above.
 *
 * Reported, never rewritten: refs inside bundle CONTENT (xrefs,
 * `supersededBy`, task `uses:`) — rewriting a bundle's own files is
 * `akm mv`/editing territory, not a config-identity rename. `--dry-run`
 * (and every real run) lists the indexed files that still spell the old
 * `<old>//` prefix so the operator can follow up.
 */

import fs from "node:fs";
import type { TasksSyncResult } from "../commands/tasks/tasks";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { validateExplicitBundleName } from "../core/bundle-id";
import type { AkmConfig, BundleConfigEntry } from "../core/config/config";
import { loadConfig, mutateConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { getStateDbPath, withStateDb } from "../core/state-db";
import { renameUsageEventRefs } from "../indexer/usage/usage-events";
import { readLockfile, renameLockEntry } from "../integrations/lockfile";
import { renameEventRefs } from "../storage/repositories/events-repository";
import { renameImproveLedgerRefs } from "../storage/repositories/improve-ledger-repository";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import { getFilePathsByBundle, renameEntriesBundleId } from "../storage/repositories/index-entries-repository";
import { renameAssetOutcomeRefs } from "../storage/repositories/outcome-repository";
import { countProposalsForBundleRename, renameProposalsBundleRef } from "../storage/repositories/proposals-repository";
import { renameAssetSalienceRefs } from "../storage/repositories/salience-repository";
import {
  countTaskHistoryTargetRefs,
  renameTaskHistoryTargetRefs,
} from "../storage/repositories/task-history-repository";
import { countWorkflowRunRefsForRename, renameWorkflowRunRefs } from "../storage/repositories/workflow-runs-repository";
import type { SchedulerBackend } from "../tasks/backends/types";

export interface BundleRenamePlan {
  oldId: string;
  newId: string;
  config: {
    defaultBundleChanges: boolean;
    /** `scheduler.enabled` refs that carry the old `<old>//` prefix. */
    schedulerRefs: string[];
  };
  lock: { present: boolean };
  index: { entries: number };
  state: { proposalRefs: number; proposalTargets: number; taskHistoryRefs: number; workflowRunRefs: number };
  /**
   * Active and blocked workflow runs of the renamed bundle. Their `workflow_ref` is
   * rewritten, but each run's frozen plan keeps the old qualified refs, so the
   * operator finishes or abandons them.
   */
  activeWorkflowRuns: Array<{ id: string; workflowRef: string; status: string }>;
  /** Indexed files under the bundle whose content still spells `<old>//` — reported, not rewritten. */
  contentRefs: string[];
  /**
   * Always empty: the OS scheduler holds one entry that runs `akm task dispatch`, which names no bundle, so a rename
   * leaves nothing in it to replace. Kept so the plan's shape does not change before its consumers drop it.
   */
  nativeSchedulerRows: string[];
}

export interface BundleRenameResult extends BundleRenamePlan {
  /** `false` for `--dry-run`: nothing below was written. */
  applied: boolean;
  /**
   * Outcome of `akm task sync` run after the state rewrite below (the entry in the OS scheduler is the same for any
   * bundle name, so this only repairs it). Absent on `--dry-run`. `ok` is `false` when the sync threw (`error` carries
   * the message); reported here, never thrown — config, index, and state are already renamed by the time this runs.
   */
  taskSync?: { ok: boolean; result: TasksSyncResult } | { ok: false; error: string };
}

/** Throws if `newId` cannot become `oldId`'s new key. Re-run under the config lock at apply time. */
function validateRename(config: AkmConfig, oldId: string, newId: string): void {
  if (!config.bundles?.[oldId]) {
    throw new NotFoundError(`No configured bundle named "${oldId}".`, "SOURCE_NOT_FOUND");
  }
  if (oldId === newId) {
    throw new UsageError(`"${oldId}" and "${newId}" are the same bundle name.`, "INVALID_FLAG_VALUE");
  }
  const withoutOld = { ...(config.bundles ?? {}) };
  delete withoutOld[oldId];
  validateExplicitBundleName(withoutOld, newId);
}

function bundleOfRef(ref: string): string | undefined {
  try {
    return parseBundleRef(ref).bundle;
  } catch {
    return undefined;
  }
}

function schedulerRefsToRewrite(config: AkmConfig, oldId: string): string[] {
  return (config.scheduler?.enabled ?? []).filter((ref) => bundleOfRef(ref) === oldId);
}

function renameBundleInConfig(config: AkmConfig, oldId: string, newId: string): AkmConfig {
  validateRename(config, oldId, newId);
  const bundles: Record<string, BundleConfigEntry> = {};
  for (const [key, entry] of Object.entries(config.bundles ?? {})) {
    bundles[key === oldId ? newId : key] = entry;
  }
  const enabled = config.scheduler?.enabled;
  const scheduler =
    enabled === undefined
      ? config.scheduler
      : {
          ...config.scheduler,
          enabled: enabled.map((ref) =>
            bundleOfRef(ref) === oldId ? bundleRefToString({ ...parseBundleRef(ref), bundle: newId }) : ref,
          ),
        };
  const rename = (name: string) => (name === oldId ? newId : name);
  const projects = config.projects
    ? Object.fromEntries(
        Object.entries(config.projects).map(([name, project]) => [
          name,
          {
            ...project,
            ...(project.from === undefined
              ? {}
              : { from: Array.isArray(project.from) ? project.from.map(rename) : rename(project.from) }),
            ...(project.write?.bundle === undefined
              ? {}
              : { write: { ...project.write, bundle: rename(project.write.bundle) } }),
          },
        ]),
      )
    : undefined;
  return {
    ...config,
    bundles,
    ...(projects ? { projects } : {}),
    ...(config.defaultBundle === oldId ? { defaultBundle: newId } : {}),
    ...(scheduler ? { scheduler } : {}),
  };
}

/** Indexed files (already read into `filePaths`) whose content still spells `<oldId>//`, best-effort. */
function filesStillMentioning(filePaths: string[], oldId: string): string[] {
  const needle = `${oldId}//`;
  const hits: string[] = [];
  for (const filePath of filePaths) {
    try {
      if (fs.readFileSync(filePath, "utf8").includes(needle)) hits.push(filePath);
    } catch {
      // Best-effort: a since-removed or unreadable file is skipped, not fatal —
      // this scan is a report, not a correctness requirement.
    }
  }
  return hits;
}

/**
 * Build the rename plan — every count and ref this rename would touch — by
 * reading, never writing. Shared by `--dry-run` and a real run so the two
 * can never disagree about what was reported vs. what happened.
 */
async function buildPlan(config: AkmConfig, oldId: string, newId: string): Promise<BundleRenamePlan> {
  const schedulerRefs = schedulerRefsToRewrite(config, oldId);
  const lockPresent = readLockfile().some((entry) => entry.id === oldId);

  let indexEntries = 0;
  let contentRefs: string[] = [];
  const readIndexDb = openReadonlyExistingDatabase(getDbPath());
  if (readIndexDb) {
    try {
      const filePaths = getFilePathsByBundle(readIndexDb, oldId);
      indexEntries = filePaths.length;
      contentRefs = filesStillMentioning(filePaths, oldId);
    } finally {
      closeDatabase(readIndexDb);
    }
  }

  let proposalRefs = 0;
  let proposalTargets = 0;
  let taskHistoryRefs = 0;
  let workflowRunRefs = 0;
  let activeWorkflowRuns: BundleRenamePlan["activeWorkflowRuns"] = [];
  if (fs.existsSync(getStateDbPath())) {
    withStateDb((db) => {
      const counts = countProposalsForBundleRename(db, oldId);
      proposalRefs = counts.refs;
      proposalTargets = counts.targets;
      taskHistoryRefs = countTaskHistoryTargetRefs(db, oldId);
      const runs = countWorkflowRunRefsForRename(db, oldId);
      workflowRunRefs = runs.refs;
      activeWorkflowRuns = runs.active;
    });
  }

  return {
    oldId,
    newId,
    config: {
      defaultBundleChanges: config.defaultBundle === oldId,
      schedulerRefs,
    },
    lock: { present: lockPresent },
    index: { entries: indexEntries },
    state: { proposalRefs, proposalTargets, taskHistoryRefs, workflowRunRefs },
    activeWorkflowRuns,
    contentRefs,
    nativeSchedulerRows: [],
  };
}

function taskSyncErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Rename a configured bundle's key everywhere akm itself persists it. With
 * `dryRun: true`, only {@link buildPlan} runs — nothing is written, matching
 * a `applied: false` result the caller renders as the plan. `deps.backend`
 * lets a caller (tests) inject a fake scheduler backend instead of the real
 * `deps.syncTasks` is how the
 * caller runs the post-rename `akmTasksSync` — `src/core` sits below
 * `src/commands` (see `src/core/improve-types.ts`'s note on the same
 * direction), so this module never imports `akmTasksSync` itself; the real
 * caller (`akm bundle rename`'s command handler) always supplies it, and is
 * required so a missing wire-up is a type error, not a silently skipped sync.
 */
export async function renameBundle(
  oldId: string,
  newId: string,
  options: { dryRun?: boolean } = {},
  deps: {
    backend?: SchedulerBackend;
    syncTasks: (sched?: SchedulerBackend) => Promise<TasksSyncResult>;
  },
): Promise<BundleRenameResult> {
  const config = loadConfig();
  validateRename(config, oldId, newId);
  const plan = await buildPlan(config, oldId, newId);
  if (options.dryRun) return { ...plan, applied: false };

  // Config: the bundles key, defaultBundle, the projects'
  // write.bundle and from entries, and every
  // scheduler.enabled[].ref with the old `//` prefix — all under one write
  // (validated again inside the config lock).
  mutateConfig((current) => renameBundleInConfig(current, oldId, newId));

  // Lockfile: the resolved-install entry id (no-op for a bundle with none,
  // e.g. a plain filesystem bundle).
  await renameLockEntry(oldId, newId);

  // Index: bundle_id/item_ref on every entry row (see index-entries-repository's
  // renameEntriesBundleId docstring for why no FTS/vector rebuild is needed).
  const readIndexDb = openReadonlyExistingDatabase(getDbPath());
  if (readIndexDb) {
    closeDatabase(readIndexDb);
    const writeIndexDb = openIndexDatabase(getDbPath());
    try {
      renameEntriesBundleId(writeIndexDb, oldId, newId);
    } finally {
      closeDatabase(writeIndexDb);
    }
  }

  // State: proposals.ref, a pending proposal's proposedTarget.source,
  // workflow task_history.target_ref, workflow_runs.workflow_ref, and the
  // learned history keyed by item ref: usage_events.entry_ref (search ranking
  // counts feedback by it), events.ref and improve_ledger.ref (improve reads
  // feedback and its own attempts by them), and asset_salience/asset_outcome.asset_ref.
  if (fs.existsSync(getStateDbPath())) {
    withStateDb((db) => {
      renameProposalsBundleRef(db, oldId, newId);
      renameTaskHistoryTargetRefs(db, oldId, newId);
      renameWorkflowRunRefs(db, oldId, newId);
      renameUsageEventRefs(db, oldId, newId);
      renameEventRefs(db, oldId, newId);
      renameImproveLedgerRefs(db, oldId, newId);
      renameAssetSalienceRefs(db, oldId, newId);
      renameAssetOutcomeRefs(db, oldId, newId);
    });
  }

  // Scheduler: re-sync so the OS entry is repaired right after the rename instead of waiting on `akm task sync`.
  // Reported, never thrown: config/index/state above are already renamed by this point.
  let taskSync: BundleRenameResult["taskSync"];
  try {
    taskSync = { ok: true, result: await deps.syncTasks(deps.backend) };
  } catch (cause) {
    taskSync = { ok: false, error: taskSyncErrorMessage(cause) };
  }

  return { ...plan, applied: true, taskSync };
}
