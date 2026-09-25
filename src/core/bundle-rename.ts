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
import { readLockfile, renameLockEntry } from "../integrations/lockfile";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import { getFilePathsByBundle, renameEntriesBundleId } from "../storage/repositories/index-entries-repository";
import { countProposalsForBundleRename, renameProposalsBundleRef } from "../storage/repositories/proposals-repository";
import {
  countTaskHistoryTargetRefs,
  renameTaskHistoryTargetRefs,
} from "../storage/repositories/task-history-repository";
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
}

export interface BundleRenameResult extends BundleRenamePlan {
  /** `false` for `--dry-run`: nothing below was written. */
  applied: boolean;
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

/**
 * Build the rename plan — every count and ref this rename would touch — by
 * reading, never writing. Shared by `--dry-run` and a real run so the two
 * can never disagree about what was reported vs. what happened.
 */
function buildPlan(config: AkmConfig, oldId: string, newId: string): BundleRenamePlan {
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
  };
}

/**
 * Rename a configured bundle's key everywhere akm itself persists it. With
 * `dryRun: true`, only {@link buildPlan} runs — nothing is written, matching
 * a `applied: false` result the caller renders as the plan.
 */
export async function renameBundle(
  oldId: string,
  newId: string,
  options: { dryRun?: boolean } = {},
): Promise<BundleRenameResult> {
  const config = loadConfig();
  validateRename(config, oldId, newId);
  const plan = buildPlan(config, oldId, newId);
  if (options.dryRun) return { ...plan, applied: false };

  // Config: the bundles key, defaultBundle/defaultWriteTarget, and every
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

  // State: proposals.ref, a pending proposal's proposedTarget.source, and
  // workflow task_history.target_ref.
  if (fs.existsSync(getStateDbPath())) {
    withStateDb((db) => {
      renameProposalsBundleRef(db, oldId, newId);
      renameTaskHistoryTargetRefs(db, oldId, newId);
    });
  }

  return { ...plan, applied: true };
}
