// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `assetEngineKeys` step: `engine:` on command and agent frontmatter,
 * workflow files and task sources becomes `connection:` or `harness:`, by the
 * kind of thing the name is now. The names an engine had before the `engines`
 * form was converted come from that step's result (`engineTargets`: `lab` may now
 * be `default`), and are kept in the data directory (`src/core/config/retired-engines.ts`)
 * until a re-read of the files finds no `engine:` key that still names an old engine
 * (a skipped file, or a block of a rewritten file that is spelled in a style the
 * splice does not write), so a read-only bundle's asset that becomes writable, or a
 * retry after the config has been rewritten, is written under the same names; a name
 * it does not know is looked up in the configuration as it stands; a name that is
 * neither a connection nor a harness is written as a harness, with a note.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { type AkmConfig, loadConfig, resetConfigCache, retiredEngineTargets } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { type EngineTargets, forgetEngineTargets } from "../../src/core/config/retired-engines";
import { getDataDir } from "../../src/core/paths";
import {
  type EngineKeyOutcome,
  type EngineKeyResolution,
  type EngineKeyRewrite,
  pendingEngineKeys,
  planEngineKeys,
  type ResolveEngineKey,
} from "./migrate/engine-key-planner";
import { applyEngineKeysPlan, inspectEngineKeyFiles } from "./migrate/engine-key-files";
import { taskRoots } from "./task-migrate";

export interface EngineKeyFileSummary {
  filePath: string;
  status: "changed" | "skipped";
  beforeHash: string;
  afterHash?: string;
  rewrites?: readonly EngineKeyRewrite[];
  notes?: readonly string[];
  reason?: string;
}

export interface EngineKeysSummary {
  schemaVersion: 1;
  changed: number;
  skipped: number;
  files: EngineKeyFileSummary[];
  /** Present after a real apply that rewrote at least one file: the run's backup directory. */
  backupPath?: string;
  /** Present with `backupPath`: how many files were rewritten. */
  applied?: number;
}

export interface EngineKeysMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready";
  assetEngineKeys: EngineKeysSummary;
}

/** What each old engine name now is: what the conversion made of it, else what the configuration holds. */
function resolverFor(config: AkmConfig, targets: EngineTargets = {}): ResolveEngineKey {
  return (engine): EngineKeyResolution => {
    const converted = targets[engine];
    if (converted) {
      return "connection" in converted
        ? { key: "connection", name: converted.connection }
        : { key: "harness", name: converted.harness };
    }
    if (Object.hasOwn(config.connections ?? {}, engine)) return { key: "connection", name: engine };
    if (Object.hasOwn(config.harnesses ?? {}, engine)) return { key: "harness", name: engine };
    return {
      key: "harness",
      name: engine,
      note: `engine "${engine}" is neither a configured connection nor a harness, so it is written as a harness; check it.`,
    };
  };
}

function summarize(files: readonly EngineKeyOutcome[]): EngineKeysSummary {
  const rows: EngineKeyFileSummary[] = files.flatMap((file): EngineKeyFileSummary[] => {
    if (file.status === "changed") {
      return [
        {
          filePath: file.filePath,
          status: "changed",
          beforeHash: file.beforeHash,
          afterHash: file.afterHash,
          rewrites: file.rewrites,
          ...(file.notes.length > 0 ? { notes: file.notes } : {}),
        },
      ];
    }
    return file.status === "skipped"
      ? [{ filePath: file.filePath, status: "skipped", beforeHash: file.beforeHash, reason: file.reason }]
      : [];
  });
  return {
    schemaVersion: 1,
    changed: rows.filter((row) => row.status === "changed").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    files: rows,
  };
}

function plan(targets?: EngineTargets) {
  resetConfigCache();
  const config = loadConfig();
  const known = targets && Object.keys(targets).length > 0 ? targets : retiredEngineTargets();
  return planEngineKeys(inspectEngineKeyFiles(taskRoots(config)), resolverFor(config, known));
}

function statusOf(summary: EngineKeysSummary): EngineKeysMigrationStatus {
  return { schemaVersion: 1, status: summary.changed > 0 ? "ready" : "current", assetEngineKeys: summary };
}

/** Read-only: what `apply` would rewrite. */
export function inspectEngineKeysMigration(targets?: EngineTargets): EngineKeysMigrationStatus {
  return statusOf(summarize(plan(targets).files));
}

/** Rewrite every `engine:` key found, under one backup directory for the run. */
export function applyEngineKeysMigration(targets?: EngineTargets): EngineKeysMigrationStatus {
  return withConfigLock(() => {
    const before = plan(targets);
    const summary = summarize(before.files);
    if (summary.changed === 0) {
      if (pendingEngineKeys(before) === 0) forgetEngineTargets();
      return statusOf(summary);
    }
    const backupPath = path.join(getDataDir(), "backups", "asset-engine-keys", `${Date.now()}-${randomUUID()}`);
    const { rewritten, conflicts } = applyEngineKeysPlan(before, { backupRoot: backupPath });
    // A file that changed since it was planned was left as it is; the report says so, and a run again plans it afresh.
    const files = summary.files.map((file): EngineKeyFileSummary =>
      conflicts.includes(file.filePath)
        ? {
            filePath: file.filePath,
            status: "skipped",
            beforeHash: file.beforeHash,
            reason: "it changed after it was planned, so it was left as it is; run again to plan it afresh",
          }
        : file,
    );
    const left = files.filter((file) => file.status === "skipped").length;
    // The old names go only when the files, read again, no longer have an `engine:` key that names one: a file
    // rewritten in part (a block scalar the splice cannot write) or changed since it was planned still does.
    if (pendingEngineKeys(plan(targets)) === 0) forgetEngineTargets();
    // The report keeps what was rewritten, notes included.
    return {
      schemaVersion: 1,
      status: conflicts.length > 0 ? "ready" : "current",
      assetEngineKeys: {
        ...summary,
        files,
        changed: summary.changed - conflicts.length,
        skipped: left,
        backupPath,
        applied: rewritten.length,
      },
    };
  });
}
