// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle rename <old> <new>` (D6) — the one command allowed to change a
 * bundle's key. A bundle id is a mass identity prefix: every durable ref this
 * tool minted (`entries.item_ref`/`bundle_id`, `proposals.ref`, a pending
 * proposal's `proposedTarget.source`, a workflow task_history row's
 * `target_ref`, `scheduler.enabled[].ref`) carries it, and a hand-edited
 * `bundles` key strands all of it (see `src/indexer/bundle-identity-guard.ts`
 * §11.5). This module is the rekey transaction that guard's docstring points
 * to.
 *
 * Rewritten: the config `bundles` key, `defaultBundle`/`defaultWriteTarget`
 * when they name the old id, every `scheduler.enabled[].ref` with the old
 * `//` prefix, the lockfile entry id, and the index/state rows above.
 *
 * Reported, never rewritten: refs inside bundle CONTENT (xrefs,
 * `supersededBy`, task `uses:`) — rewriting a bundle's own files is
 * `akm mv`/editing territory, not a config-identity rename. `--dry-run`
 * (and every real run) lists the indexed files that still spell the old
 * `<old>//` prefix so the operator can follow up.
 *
 * Left behind on purpose: `usage_events`/`asset_salience`/`asset_outcome`
 * keyed by the old bundle prefix (learned utility/outcome history) — outside
 * this item's scope; `warnOnBundleRenameDrift` already documents this class
 * of gap and `akm index --full` re-mints under the new id.
 */

import fs from "node:fs";
import type { TasksSyncResult } from "../commands/tasks/tasks";
import { readLockfile, renameLockEntry } from "../integrations/lockfile";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import { getFilePathsByBundle, renameEntriesBundleId } from "../storage/repositories/index-entries-repository";
import { renameLlmCacheAssetRefs } from "../storage/repositories/index-llm-cache-repository";
import { countProposalsForBundleRename, renameProposalsBundleRef } from "../storage/repositories/proposals-repository";
import {
  countTaskHistoryTargetRefs,
  renameTaskHistoryTargetRefs,
} from "../storage/repositories/task-history-repository";
import { selectBackend } from "../tasks/backends";
import type { SchedulerBackend } from "../tasks/backends/types";
import type { SchedulerBackendInspection } from "../tasks/scheduler-binding";
import { bundleRefToString, parseBundleRef } from "./asset/asset-ref";
import { validateExplicitBundleName } from "./bundle-id";
import type { AkmConfig, BundleConfigEntry } from "./config/config";
import { loadConfig, mutateConfig } from "./config/config";
import { NotFoundError, UsageError } from "./errors";
import { getDbPath } from "./paths";
import { getStateDbPath, withStateDb } from "./state-db";

export interface BundleRenamePlan {
  oldId: string;
  newId: string;
  config: {
    defaultBundleChanges: boolean;
    defaultWriteTargetChanges: boolean;
    /** `scheduler.enabled[].ref` values that carry the old `<old>//` prefix. */
    schedulerRefs: string[];
  };
  lock: { present: boolean };
  index: { entries: number };
  state: { proposalRefs: number; proposalTargets: number; taskHistoryRefs: number };
  /** Indexed files under the bundle whose content still spells `<old>//` — reported, not rewritten. */
  contentRefs: string[];
  /**
   * Installed native scheduler rows (cron line, launchd plist, scheduled
   * task) whose invocation still names the old bundle — best-effort, empty
   * when the active backend can't provide one coherent inspection. A real
   * run's post-rename `akm task sync` replaces these; `--dry-run` lists them
   * so the plan shows what that sync will touch.
   */
  nativeSchedulerRows: string[];
}

export interface BundleRenameResult extends BundleRenamePlan {
  /** `false` for `--dry-run`: nothing below was written. */
  applied: boolean;
  /**
   * Outcome of re-syncing native scheduler rows under the new bundle id,
   * run immediately after the state rewrite below. Absent on `--dry-run`
   * (nothing was renamed yet to sync against). `ok` is `false` both when
   * the sync call itself threw (`error` carries the message, no `result`)
   * and when it returned with one or more `result.failures` — a binding
   * that failed to prepare has already lost its old native row (see
   * `removeStaleNativeSchedulerRows`) and is not scheduled until
   * `akm task sync` is re-run. Reported here, never thrown either way —
   * config, index, and state are already renamed by the time this runs.
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

function schedulerRefsToRewrite(config: AkmConfig, oldId: string): string[] {
  return (config.scheduler?.enabled ?? [])
    .map((activation) => activation.ref)
    .filter((ref) => parseBundleRef(ref).bundle === oldId);
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
          enabled: enabled.map((activation) => {
            const parsed = parseBundleRef(activation.ref);
            if (parsed.bundle !== oldId) return activation;
            return { ...activation, ref: bundleRefToString({ ...parsed, bundle: newId }) };
          }),
        };
  return {
    ...config,
    bundles,
    ...(config.defaultBundle === oldId ? { defaultBundle: newId } : {}),
    ...(config.defaultWriteTarget === oldId ? { defaultWriteTarget: newId } : {}),
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

/** True when an installed binding's invocation names `bundleId` — either as a `task run` entry's `--bundle <id>` argument, or as a `workflow run <id>//…` ref. */
function invocationNamesBundle(invocation: readonly string[] | undefined, bundleId: string): boolean {
  if (!invocation) return false;
  for (let i = 0; i < invocation.length; i++) {
    const token = invocation[i];
    if (token === bundleId && invocation[i - 1] === "--bundle") return true;
    if (token?.startsWith(`${bundleId}//`)) return true;
  }
  return false;
}

/**
 * Installed native scheduler rows whose invocation names `oldId`, best-effort
 * (a backend that can't provide `inspectBindings`, or whose inspection
 * throws, reports none — this is a preview, not a correctness requirement).
 */
async function nativeSchedulerRowsNamingBundle(sched: SchedulerBackend, oldId: string): Promise<string[]> {
  if (!sched.inspectBindings) return [];
  try {
    const inspection = await sched.inspectBindings({});
    return inspection.installed
      .filter((entry) => invocationNamesBundle(entry.invocation, oldId))
      .map((entry) => entry.invocation?.join(" ") ?? entry.id);
  } catch {
    return [];
  }
}

/**
 * Build the rename plan — every count and ref this rename would touch — by
 * reading, never writing. Shared by `--dry-run` and a real run so the two
 * can never disagree about what was reported vs. what happened.
 */
async function buildPlan(
  config: AkmConfig,
  oldId: string,
  newId: string,
  sched: SchedulerBackend,
): Promise<BundleRenamePlan> {
  const schedulerRefs = schedulerRefsToRewrite(config, oldId);
  const lockPresent = readLockfile().some((entry) => entry.id === oldId);
  const nativeSchedulerRows = await nativeSchedulerRowsNamingBundle(sched, oldId);

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
  if (fs.existsSync(getStateDbPath())) {
    withStateDb((db) => {
      const counts = countProposalsForBundleRename(db, oldId);
      proposalRefs = counts.refs;
      proposalTargets = counts.targets;
      taskHistoryRefs = countTaskHistoryTargetRefs(db, oldId);
    });
  }

  return {
    oldId,
    newId,
    config: {
      defaultBundleChanges: config.defaultBundle === oldId,
      defaultWriteTargetChanges: config.defaultWriteTarget === oldId,
      schedulerRefs,
    },
    lock: { present: lockPresent },
    index: { entries: indexEntries },
    state: { proposalRefs, proposalTargets, taskHistoryRefs },
    contentRefs,
    nativeSchedulerRows,
  };
}

function taskSyncErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Remove every installed native row still naming `oldId`, best-effort,
 * before the sync below installs the new-named ones. Without this, a plain
 * `akmTasksSync(deps, newId)` alone cannot clean the old rows up: a task
 * binding's native id depends only on the task id, so the OLD row and the
 * new one it should become collide on that id, and `belongsToBundle`
 * (scheduler-sync.ts) gates ownership on the bundle NAME the row was
 * installed under — the physical-path check only confirms a name match, it
 * never substitutes for one — so the sync's own `foreignIdCollisions` logic
 * treats the old row as belonging to neither bundle and silently drops the
 * new binding instead of replacing it. A workflow binding's native id
 * depends on its fully-qualified ref instead, so old and new never collide
 * at all and the old row would otherwise be left installed forever. Both
 * fail the same way this function fixes: uninstall the exact native rows
 * `nativeSchedulerRowsNamingBundle` already found, by their native id, so
 * the sync that follows starts from a clean slate.
 */
async function removeStaleNativeSchedulerRows(sched: SchedulerBackend, oldId: string): Promise<void> {
  if (!sched.inspectBindings) return;
  let installed: SchedulerBackendInspection["installed"];
  try {
    installed = (await sched.inspectBindings({})).installed;
  } catch {
    return;
  }
  for (const entry of installed) {
    if (!invocationNamesBundle(entry.invocation, oldId)) continue;
    try {
      await sched.uninstall(entry.nativeId ?? entry.id);
    } catch {
      // Best-effort: a row this process can't remove is left for the
      // operator's own `akm task sync` to reconcile, same as every other
      // per-item failure the sync itself reports rather than throws.
    }
  }
}

/**
 * Rename a configured bundle's key everywhere akm itself persists it. With
 * `dryRun: true`, only {@link buildPlan} runs — nothing is written, matching
 * a `applied: false` result the caller renders as the plan. `deps.backend`
 * lets a caller (tests) inject a fake scheduler backend instead of the real
 * OS one `selectBackend()` would otherwise pick. `deps.syncTasks` is how the
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
    syncTasks: (newId: string, sched: SchedulerBackend) => Promise<TasksSyncResult>;
  },
): Promise<BundleRenameResult> {
  const config = loadConfig();
  validateRename(config, oldId, newId);
  const sched = deps.backend ?? selectBackend();
  const plan = await buildPlan(config, oldId, newId, sched);
  if (options.dryRun) return { ...plan, applied: false };

  // Config: the bundles key, defaultBundle/defaultWriteTarget, and every
  // scheduler.enabled[].ref with the old `//` prefix — all under one write
  // (validated again inside the config lock).
  mutateConfig((current) => renameBundleInConfig(current, oldId, newId));

  // Lockfile: the resolved-install entry id (no-op for a bundle with none,
  // e.g. a plain filesystem bundle).
  await renameLockEntry(oldId, newId);

  // Index: bundle_id/item_ref on every entry row (see index-entries-repository's
  // renameEntriesBundleId docstring for why no FTS/vector rebuild is needed),
  // and the metadata-enrichment LLM cache keyed by the same canonical
  // item_ref — in the SAME write, so a rename can never land between the two
  // and leave the cache stranded under the old prefix (the next `akm index`'s
  // clearStaleCacheEntries would then delete it, forcing a full re-enrich).
  const readIndexDb = openReadonlyExistingDatabase(getDbPath());
  if (readIndexDb) {
    closeDatabase(readIndexDb);
    const writeIndexDb = openIndexDatabase(getDbPath());
    try {
      renameEntriesBundleId(writeIndexDb, oldId, newId);
      renameLlmCacheAssetRefs(writeIndexDb, oldId, newId);
    } finally {
      closeDatabase(writeIndexDb);
    }
  }

  // State: proposals.ref, a pending proposal's proposedTarget.source, and
  // workflow task_history.target_ref.
  if (fs.existsSync(getStateDbPath())) {
    withStateDb((db) => {
      renameProposalsBundleRef(db, oldId, newId);
      renameTaskHistoryTargetRefs(db, oldId, newId);
    });
  }

  // Scheduler: remove native rows still naming `<old>//` (see
  // removeStaleNativeSchedulerRows for why a plain sync alone can't do
  // this), then re-sync so a scheduled run's invocation stops naming the
  // old bundle the moment the rename applies, instead of waiting on the
  // operator to run `akm task sync` by hand. Reported, never thrown:
  // config/index/state above are already renamed by this point, so a sync
  // problem must not make the rename itself look like it failed. `ok` is
  // false both when the sync call throws and when it comes back with
  // `result.failures` — a binding that failed to prepare has already lost
  // its old native row above and is not scheduled until a retry.
  let taskSync: BundleRenameResult["taskSync"];
  try {
    await removeStaleNativeSchedulerRows(sched, oldId);
    const result = await deps.syncTasks(newId, sched);
    taskSync = { ok: result.failures.length === 0, result };
  } catch (cause) {
    taskSync = { ok: false, error: taskSyncErrorMessage(cause) };
  }

  return { ...plan, applied: true, taskSync };
}
