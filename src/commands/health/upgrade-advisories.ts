// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Upgrade-break advisories for `akm health` (batch upgrade-D, item D2).
 *
 * `state-db-migrations`, `scheduler-binary` and `task-fail-rate` each catch
 * one *symptom* of a host that upgraded akm without fully reconciling —
 * but none of them says "this host has not reconciled to the installed
 * version", "installed scheduler rows have no host-local grant", or
 * "scheduled runs are dying before their body starts", which is what the
 * July 2026 13.5-hour outage actually needed. Three advisories, always
 * best-effort and never a false `pass`:
 *
 *   1. `version-reconcile` — reads the host-local reconciliation stamp Batch
 *      B's `akm-migrate apply --host-local` writes
 *      (`src/core/version-reconcile.ts`). Read-only: no spawn, no migrator
 *      run.
 *   2. `scheduler-grants` — installed native scheduler rows that have a
 *      backing asset file but no host-local grant yet
 *      (`pendingGrantsFromInstalled`, `src/tasks/scheduler-grant-carry-forward.ts`).
 *      `--probe`-gated like `scheduler-binary.ts`: inspecting the native
 *      scheduler means a real crontab/launchd/schtasks read, so `--no-probe`
 *      suppresses it too.
 *   3. `scheduled-startup-failures` — `task_history` rows in the health
 *      window that failed with a startup-class exit code (2 usage, 70
 *      internal, 78 config) — a task that died before its body ran, the
 *      signature of a stale scheduled binary or a broken config/migration
 *      rather than an ordinary task-body failure.
 */

import fs from "node:fs";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { readVersionReconcileStamp } from "../../core/version-reconcile";
import type { Database } from "../../storage/database";
import { decodeTaskHistoryMetadata, queryTaskHistory } from "../../storage/repositories/task-history-repository";
import { selectBackend } from "../../tasks/backends";
import type { SchedulerBackend } from "../../tasks/backends/types";
import { pendingGrantsFromInstalled } from "../../tasks/scheduler-grant-carry-forward";
import type { HealthCheckResult } from "./types";

/** exit(2) usage, exit(70) internal, exit(78) config — see `EXIT_CODES` in `src/cli/shared.ts`. */
const STARTUP_CLASS_EXIT_CODES: ReadonlySet<number> = new Set([2, 70, 78]);

/** How many bytes of a failing run's log file {@link firstLogLineNaming} reads, from the start. */
const LOG_SNIFF_BYTES = 8_192;

/** How many task ids a `scheduled-startup-failures` warn names before summarizing the rest as a count. */
const MAX_NAMED_TASK_IDS = 5;

export interface UpgradeAdvisoriesDependencies {
  readonly db: Database;
  /** Health window lower bound (ISO), same window every other advisory in this report uses. */
  readonly since: string;
  /** `$STATE` — where `version-reconcile.json` lives. */
  readonly stateDir: string;
  /** The running akm's version. */
  readonly cliVersion: string;
  /** `--probe`/`--no-probe` — gates `scheduler-grants`' native scheduler read, same flag `scheduler-binary` uses. */
  readonly probe: boolean;
  /** Injectable scheduler backend; defaults to the real platform backend. */
  readonly backend?: SchedulerBackend;
  /** Injectable config; defaults to `loadConfig()`. */
  readonly config?: AkmConfig;
}

function passResult(name: string, message: string, evidence?: Record<string, unknown>): HealthCheckResult {
  return {
    name,
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message,
    ...(evidence ? { evidence } : {}),
  };
}

function warnResult(name: string, message: string, evidence?: Record<string, unknown>): HealthCheckResult {
  return {
    name,
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message,
    ...(evidence ? { evidence } : {}),
  };
}

function unknownResult(name: string, message: string, evidence?: Record<string, unknown>): HealthCheckResult {
  return {
    name,
    kind: "deterministic",
    status: "unknown",
    confidence: "high",
    message,
    ...(evidence ? { evidence } : {}),
  };
}

/**
 * `version-reconcile`: has this host's host-local state actually been
 * reconciled to the version that's running right now? `pass` only when the
 * stamp's `version` matches; `warn` when the stamp is missing, names an
 * older version, or its last attempt was blocked (the blocker text is
 * already embedded in `lastStatus` by `reconcileOnVersionChange`); `unknown`
 * when the stamp exists but cannot be read.
 */
function buildVersionReconcileAdvisory(deps: UpgradeAdvisoriesDependencies): HealthCheckResult {
  const read = readVersionReconcileStamp(deps.stateDir);
  if (read.outcome === "unreadable") {
    return unknownResult(
      "version-reconcile",
      `The host-local reconciliation stamp could not be read: ${read.message}.`,
      { stateDir: deps.stateDir },
    );
  }
  const stamp = read.outcome === "found" ? read.stamp : undefined;
  if (stamp?.version === deps.cliVersion && !stamp.lastStatus) {
    return passResult("version-reconcile", `Host-local state is reconciled to the running v${deps.cliVersion}.`, {
      stampVersion: stamp.version,
      cliVersion: deps.cliVersion,
    });
  }
  const detail =
    read.outcome === "missing"
      ? "no reconciliation has run on this host yet"
      : stamp?.lastStatus
        ? stamp.lastStatus
        : `stamp names v${stamp?.version ?? "unknown"}`;
  return warnResult(
    "version-reconcile",
    `Host-local state has not reconciled to the running v${deps.cliVersion} (${detail}). Run \`akm migrate status\` for detail.`,
    {
      stampVersion: stamp?.version ?? null,
      cliVersion: deps.cliVersion,
      lastStatus: stamp?.lastStatus ?? null,
      lastAttemptAt: stamp?.lastAttemptAt ?? null,
    },
  );
}

/**
 * `scheduler-grants`: installed native scheduler rows (the operator's own
 * prior `akm task sync`) that have no host-local grant yet — the same
 * evidence `akm task sync --carry-forward` acts on, read here without
 * mutating anything. `--probe`-gated (see the module doc): `unknown` "not
 * probed" with `--no-probe`, mirroring `scheduler-binary`. `unknown` when the
 * backend can't be selected or can't inspect its own bindings; `pass` when
 * every installed row is granted.
 */
async function buildSchedulerGrantsAdvisory(deps: UpgradeAdvisoriesDependencies): Promise<HealthCheckResult> {
  if (!deps.probe) {
    return unknownResult("scheduler-grants", "Scheduler grant reconciliation was not probed.");
  }
  let backend: SchedulerBackend;
  try {
    backend = deps.backend ?? selectBackend();
  } catch (error) {
    return unknownResult(
      "scheduler-grants",
      `The native scheduler backend could not be selected: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!backend.inspectBindings) {
    return unknownResult("scheduler-grants", `Scheduler backend "${backend.name}" cannot inspect its native bindings.`);
  }
  let installed: Awaited<ReturnType<NonNullable<SchedulerBackend["inspectBindings"]>>>["installed"];
  try {
    installed = (await backend.inspectBindings({})).installed;
  } catch (error) {
    return unknownResult(
      "scheduler-grants",
      `Installed scheduled tasks could not be inspected: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const config = deps.config ?? loadConfig();
  const pending = pendingGrantsFromInstalled(installed, config);
  if (pending.length === 0) {
    return passResult("scheduler-grants", "Every installed scheduler row has a host-local grant.");
  }
  const refs = pending.map((activation) => activation.ref);
  return warnResult(
    "scheduler-grants",
    `${pending.length} installed scheduler row(s) have no host-local grant: ${refs.join(", ")}. Run \`akm task sync\` to carry them forward.`,
    { refs, count: pending.length },
  );
}

/**
 * The first log line naming the error in a failing run's log file, read
 * bounded from the start ({@link LOG_SNIFF_BYTES}) so a huge log can never
 * be pulled into memory. `undefined` on any read failure or an empty file —
 * best-effort labelling only, never load-bearing for the advisory's status.
 */
function firstLogLineNaming(logPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(logPath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const size = Math.min(stat.size, LOG_SNIFF_BYTES);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    const lines = buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.find((line) => /error/i.test(line)) ?? lines[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort: a close failure after a successful read changes nothing.
      }
    }
  }
}

/**
 * `scheduled-startup-failures`: `task_history` rows in the health window
 * that failed with a startup-class exit code (2 usage, 70 internal, 78
 * config) — a run that died before its body executed, the signature of a
 * stale scheduled binary or a broken config/migration rather than an
 * ordinary task failure. `unknown` when `task_history` cannot be queried;
 * `pass` when nothing in the window matches.
 */
function buildScheduledStartupFailuresAdvisory(deps: UpgradeAdvisoriesDependencies): HealthCheckResult {
  let rows: ReturnType<typeof queryTaskHistory>;
  try {
    rows = queryTaskHistory(deps.db, { since: deps.since, status: "failed" });
  } catch (error) {
    return unknownResult(
      "scheduled-startup-failures",
      `task_history could not be queried: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const matches: Array<{ taskId: string; exitCode: number; logPath: string | null }> = [];
  for (const row of rows) {
    let exitCode: number | null | undefined;
    try {
      exitCode = decodeTaskHistoryMetadata(row.metadata_json).detail?.exitCode;
    } catch {
      continue;
    }
    if (typeof exitCode === "number" && STARTUP_CLASS_EXIT_CODES.has(exitCode)) {
      matches.push({ taskId: row.task_id, exitCode, logPath: row.log_path });
    }
  }
  if (matches.length === 0) {
    return passResult(
      "scheduled-startup-failures",
      "No scheduled run failed with a startup-class exit code in the window.",
    );
  }
  const taskIds = [...new Set(matches.map((match) => match.taskId))];
  const namedTaskIds = taskIds.slice(0, MAX_NAMED_TASK_IDS);
  const remainder = taskIds.length - namedTaskIds.length;
  const taskIdList = remainder > 0 ? `${namedTaskIds.join(", ")}, and ${remainder} more` : namedTaskIds.join(", ");
  const firstLogged = matches.find((match) => match.logPath);
  const firstLine = firstLogged?.logPath ? firstLogLineNaming(firstLogged.logPath) : undefined;
  return warnResult(
    "scheduled-startup-failures",
    `${matches.length} scheduled run(s) failed before their body ran (exit 2/70/78): ${taskIdList}${firstLine ? ` — ${firstLine}` : ""}. This is the signature of an upgrade break — check \`akm migrate status\` and the scheduled binary.`,
    { count: matches.length, taskIds, sample: matches.slice(0, MAX_NAMED_TASK_IDS) },
  );
}

/**
 * Build all three upgrade-break advisories. Never throws — each advisory
 * degrades to `unknown` on its own failure; the caller (`src/commands/health.ts`)
 * still wraps this call in its own try/catch, matching every other
 * best-effort advisory group.
 */
export async function collectUpgradeAdvisories(deps: UpgradeAdvisoriesDependencies): Promise<HealthCheckResult[]> {
  return [
    buildVersionReconcileAdvisory(deps),
    await buildSchedulerGrantsAdvisory(deps),
    buildScheduledStartupFailuresAdvisory(deps),
  ];
}
