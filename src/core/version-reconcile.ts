// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Startup reconciliation: after any install, by any method (a prerelease
 * `akm upgrade` cannot install, `npm i -g`/`bun add -g`, an image rebuild),
 * the next akm invocation brings host-local state up to date by itself, once
 * per version change, with backups, and never turns a command into a hard
 * failure. Runs `akm-migrate apply --host-local`
 * (`scripts/akm-migrate/`) through the injected `runTool` — `src/` must not
 * import `scripts/`, so this module only ever spawns the standalone tool and
 * reads its JSON plan back, exactly like `src/commands/migrate-cli.ts` does
 * for `akm migrate`. Host-local mode never rewrites bundle content (task
 * v2/v3/v4 sources, dead `.akm` residue, writer relocation); those stay
 * reachable only through an explicit, full `akm migrate apply`.
 *
 * Wired into `src/cli.ts`'s `runCli()`, guarded by `shouldReconcileOnStartup`.
 */

import fs from "node:fs";
import path from "node:path";
import { sleep } from "../runtime";
import { writeFileAtomic } from "./common";
import { createLockPayload, releaseLock, tryAcquireLockSync } from "./file-lock";
import { warnOnce } from "./warn";

/** `$STATE/version-reconcile.json` — the last version this host successfully reconciled, plus the most recent attempt. */
export interface VersionReconcileStamp {
  readonly version?: string;
  readonly reconciledAt?: string;
  readonly lastAttemptAt?: string;
  readonly lastStatus?: string;
  /** The running version that made `lastAttemptAt`'s attempt — the backoff below only applies while it still matches. */
  readonly lastAttemptVersion?: string;
}

/**
 * Minimal shape read out of `akm-migrate apply --host-local`'s JSON plan.
 * `src/` cannot import `scripts/akm-migrate/run-migrate.ts`'s own
 * `CombinedMigrationPlan` type (the dist build's tsc has `rootDir: src`), so
 * this is a loose structural subset — just enough to decide what happened
 * and describe it, never to validate the plan's full shape.
 */
export interface HostLocalMigrationPlan {
  readonly status: "current" | "ready" | "blocked";
  readonly blockers?: readonly string[];
  readonly [key: string]: unknown;
}

export interface VersionReconcileToolResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VersionReconcileDeps {
  /** The running akm's version — `pkgVersion` in production. */
  readonly version: string;
  /** Spawns `akm-migrate` — `runMigrationTool` (`src/commands/migration-tool.ts`) in production. */
  readonly runTool: (args: readonly string[]) => Promise<VersionReconcileToolResult>;
  readonly stateDir: string;
  readonly now: () => Date;
  /** Test-only: shrinks the lock-wait poll so a test doesn't block for real seconds. Defaults to 250ms/30s in production. */
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

export type VersionReconcileResult =
  | { readonly outcome: "up-to-date" }
  | { readonly outcome: "lock-unavailable" }
  | { readonly outcome: "reconciled"; readonly plan: HostLocalMigrationPlan }
  | { readonly outcome: "blocked"; readonly blocker?: string }
  | { readonly outcome: "spawn-failed"; readonly message: string };

const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** A blocked or failed reconcile attempt is retried no more than once per 10 minutes. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

function stampPath(stateDir: string): string {
  return path.join(stateDir, "version-reconcile.json");
}

function lockFilePath(stateDir: string): string {
  return path.join(stateDir, "locks", "version-reconcile.lock");
}

function readStamp(stateDir: string): VersionReconcileStamp | undefined {
  const read = readVersionReconcileStamp(stateDir);
  return read.outcome === "found" ? read.stamp : undefined;
}

/** Outcome of {@link readVersionReconcileStamp}, distinguishing "never reconciled" from "cannot tell". */
export type VersionReconcileStampRead =
  | { readonly outcome: "missing" }
  | { readonly outcome: "unreadable"; readonly message: string }
  | { readonly outcome: "found"; readonly stamp: VersionReconcileStamp };

/**
 * Pure reader for `$STATE/version-reconcile.json`, for callers (the
 * `version-reconcile` health advisory) that must tell an absent stamp — this
 * host has never reconciled — apart from one that exists but could not be
 * parsed, which {@link readStamp}'s single `undefined` return collapses.
 * Read-only: never runs `akm-migrate`.
 */
export function readVersionReconcileStamp(stateDir: string): VersionReconcileStampRead {
  let text: string;
  try {
    text = fs.readFileSync(stampPath(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { outcome: "missing" };
    return { outcome: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(text) as VersionReconcileStamp;
    if (typeof parsed !== "object" || parsed === null) {
      return { outcome: "unreadable", message: "stamp is not a JSON object" };
    }
    return { outcome: "found", stamp: parsed };
  } catch (error) {
    return { outcome: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
}

function writeStamp(stateDir: string, stamp: VersionReconcileStamp): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(stampPath(stateDir), `${JSON.stringify(stamp, null, 2)}\n`, 0o600);
  } catch {
    // Best-effort bookkeeping only — a failure here never blocks the command
    // the reconcile ran ahead of (policy 3: reconciliation that cannot
    // finish warns and lets the command run).
  }
}

function parsePlan(stdout: string): HostLocalMigrationPlan | undefined {
  const line = stdout.trim();
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as Partial<HostLocalMigrationPlan>;
    if (parsed.status === "current" || parsed.status === "ready" || parsed.status === "blocked") {
      return parsed as HostLocalMigrationPlan;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring host-local state (config.json, state.db, scheduler grants,
 * `$DATA/txn`) up to date with `deps.version`, once per version change.
 * Never throws — a migration that cannot finish warns once and lets the
 * calling command run; the only way this process ever sees a hard failure
 * for a genuinely unreadable config is `loadConfig()`, called right after
 * this returns, which already fails closed today regardless of this
 * function's own behavior.
 */
export async function reconcileOnVersionChange(deps: VersionReconcileDeps): Promise<VersionReconcileResult> {
  try {
    return await reconcileOnVersionChangeInner(deps);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warnOnce("version-reconcile:unexpected", `Host-local reconciliation failed unexpectedly: ${message}`);
    return { outcome: "spawn-failed", message };
  }
}

async function reconcileOnVersionChangeInner(deps: VersionReconcileDeps): Promise<VersionReconcileResult> {
  const initialStamp = readStamp(deps.stateDir);
  if (initialStamp?.version === deps.version) return { outcome: "up-to-date" };

  const lock = lockFilePath(deps.stateDir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const ownership = tryAcquireLockSync(lock, createLockPayload({ component: "version-reconcile" }));
  if (!ownership) {
    const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = deps.now().getTime() + maxWaitMs;
    while (deps.now().getTime() < deadline) {
      await sleep(pollIntervalMs);
      if (readStamp(deps.stateDir)?.version === deps.version) return { outcome: "up-to-date" };
    }
    warnOnce(
      "version-reconcile:lock-held",
      "akm is reconciling host-local state in another process; run `akm migrate status` if this persists.",
    );
    return { outcome: "lock-unavailable" };
  }

  try {
    // Re-check under the lock: another process may have just finished.
    const current = readStamp(deps.stateDir);
    if (current?.version === deps.version) return { outcome: "up-to-date" };

    if (
      current?.lastAttemptAt &&
      current.lastAttemptVersion === deps.version &&
      deps.now().getTime() - Date.parse(current.lastAttemptAt) < RETRY_AFTER_FAILURE_MS
    ) {
      warnOnce(
        "version-reconcile:blocked",
        `Host-local reconciliation is still blocked (last attempt ${current.lastAttemptAt}): ${current.lastStatus ?? "unknown reason"}. Run \`akm migrate status\` for detail.`,
      );
      return { outcome: "blocked", blocker: current.lastStatus };
    }

    const lastAttemptAt = deps.now().toISOString();
    let toolResult: VersionReconcileToolResult;
    try {
      toolResult = await deps.runTool(["apply", "--host-local"]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      writeStamp(deps.stateDir, {
        version: current?.version,
        reconciledAt: current?.reconciledAt,
        lastAttemptAt,
        lastAttemptVersion: deps.version,
        lastStatus: `spawn failed: ${message}`,
      });
      warnOnce(
        "version-reconcile:spawn-failed",
        `Host-local reconciliation could not run: ${message}. Run \`akm migrate status\` for detail.`,
      );
      return { outcome: "spawn-failed", message };
    }

    const plan = parsePlan(toolResult.stdout);
    if (plan && (plan.status === "current" || plan.status === "ready")) {
      writeStamp(deps.stateDir, { version: deps.version, reconciledAt: deps.now().toISOString() });
      return { outcome: "reconciled", plan };
    }

    const blocker = plan?.blockers?.[0] ?? (toolResult.stderr.trim() || `akm-migrate exited ${toolResult.status}`);
    writeStamp(deps.stateDir, {
      version: current?.version,
      reconciledAt: current?.reconciledAt,
      lastAttemptAt,
      lastAttemptVersion: deps.version,
      lastStatus: `blocked: ${blocker}`,
    });
    warnOnce(
      "version-reconcile:blocked",
      `Host-local reconciliation is blocked: ${blocker}. Run \`akm migrate status\` for detail.`,
    );
    return { outcome: "blocked", blocker };
  } finally {
    releaseLock(ownership);
  }
}

/**
 * One-line, human-readable summary of what an applied host-local plan
 * actually changed — the caller (`src/cli.ts`) logs a single stderr line
 * naming this, and only when it is non-empty (`status: "current"` with
 * nothing pending logs nothing).
 */
export function describeHostLocalReconciliation(plan: HostLocalMigrationPlan): string[] {
  const notes: string[] = [];
  const push = (label: string, count: number | undefined): void => {
    if (typeof count === "number" && count > 0) notes.push(`${count} ${label}`);
  };
  const arrayLength = (value: unknown): number | undefined => (Array.isArray(value) ? value.length : undefined);
  const section = (key: string): Record<string, unknown> | undefined => {
    const value = plan[key];
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  };

  const legacySourceShape = section("configLegacySourceShape");
  if (legacySourceShape?.applied === true)
    push("legacy source config key(s) converted", arrayLength(legacySourceShape.converted));
  const extraParams = section("configExtraParams");
  if (extraParams?.applied === true) push("extraParams key(s) lifted", arrayLength(extraParams.lifted));
  const retiredKeys = section("configRetiredKeys");
  if (retiredKeys?.applied === true) push("retired config key(s) removed", arrayLength(retiredKeys.removed));
  const schedulerSourceIds = section("configSchedulerSourceIds");
  if (schedulerSourceIds?.applied === true)
    push("scheduler source-id binding(s) updated", arrayLength(schedulerSourceIds.changes));
  const stateMigrations = section("stateMigrations");
  push("state.db migration(s) applied", arrayLength(stateMigrations?.applied));
  const schedulerActivation = section("schedulerActivation");
  push("scheduler grant(s) carried forward", arrayLength(schedulerActivation?.applied));
  const schedulerWarnings = Array.isArray(schedulerActivation?.warnings)
    ? (schedulerActivation.warnings as ReadonlyArray<unknown>).filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  if (schedulerWarnings && schedulerWarnings.length > 0) {
    notes.push(`${schedulerWarnings.length} scheduler grant warning(s): ${schedulerWarnings.join("; ")}`);
  }
  const staleTxns = section("staleTxns");
  push("stale transaction(s) recovered", arrayLength(staleTxns?.recovered));
  const quarantined = Array.isArray(staleTxns?.quarantined)
    ? (staleTxns.quarantined as ReadonlyArray<{ journalPath?: unknown }>)
    : undefined;
  if (quarantined && quarantined.length > 0) {
    const paths = quarantined
      .map((entry) => entry.journalPath)
      .filter((value): value is string => typeof value === "string");
    notes.push(`${quarantined.length} stale transaction(s) quarantined (see ${paths.join(", ")})`);
  }
  const deferred = Array.isArray(staleTxns?.deferred)
    ? (staleTxns.deferred as ReadonlyArray<{ transactionId?: unknown; reason?: unknown }>)
    : undefined;
  const deferredItems = (deferred ?? [])
    .filter(
      (entry): entry is { transactionId: string; reason: string } =>
        typeof entry.transactionId === "string" && typeof entry.reason === "string",
    )
    .map((entry) => `${entry.transactionId}: ${entry.reason}`);
  if (deferredItems.length > 0) {
    notes.push(`${deferredItems.length} stale transaction(s) left for retry: ${deferredItems.join("; ")}`);
  }

  return notes;
}
