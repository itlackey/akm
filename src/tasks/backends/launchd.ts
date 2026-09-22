// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * launchd backend for `akm task` (macOS default).
 *
 * Each task is written as a per-user LaunchAgent plist at
 * `~/Library/LaunchAgents/com.akm.task.<id>.plist` and registered via
 * `launchctl bootstrap gui/<uid> <plist>`. Disabling uses
 * `launchctl disable gui/<uid>/<label>` and re-enabling uses `enable`.
 *
 * Platform notes:
 *   • The `bootstrap` / `bootout` / `enable` / `disable` subcommands require
 *     macOS 10.10 (Yosemite) or newer. On older systems the equivalents
 *     are `launchctl load -w` / `unload -w`. We only target modern macOS.
 *   • `gui/<uid>` is the per-user GUI launchd domain — agents in this
 *     domain only run while the user is logged in (no background runs at
 *     the loginwindow). Tasks that need to run when the user is logged
 *     out should be installed as system Daemons, which is out of scope.
 *
 * Tests inject a fake exec + filesystem so the backend can be unit-tested
 * without touching the host launchctl.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import launchdTemplate from "../../assets/backends/launchd-template.xml" with { type: "text" };
import { hasErrnoCode } from "../../core/common";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { warn } from "../../core/warn";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { type LaunchdTrigger, parseSchedule, translateToLaunchd } from "../schedule";
import {
  assertSchedulerExecutionEvidenceDigest,
  assertSchedulerExpectationIdentity,
  assertSchedulerMutationArtifact,
  assertSchedulerNativeArtifactCardinality,
  assertSchedulerNativeArtifactOwner,
  assertSchedulerRemovalArtifact,
  assertSchedulerRollbackArtifactCardinality,
  type SchedulerBackendInspection,
  type SchedulerBinding,
  type SchedulerMutationExpectation,
  type SchedulerNativeArtifact,
  type SchedulerRemovalExpectation,
  type SchedulerRollbackExpectation,
  schedulerBindingNativeId,
  schedulerLogicalBindingId,
  schedulerLogicalBindingOwner,
  schedulerNativeArtifactKey,
} from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import { type BackendExec, escapeXml, type NodeFs, nodeExec, nodeFs, runOrThrow } from "./exec-utils";
import type { InstalledSchedulerBinding, SchedulerBackend, SchedulerInstallOptions } from "./types";

export type LaunchdExec = BackendExec<{ uid(): number }>;

export type LaunchdFs = NodeFs & {
  readFile(file: string): string;
  removeFile(file: string): void;
  replaceFile(source: string, destination: string): void;
  list(dir: string): string[];
  exists(file: string): boolean;
};

export interface LaunchdBackendOptions {
  exec?: LaunchdExec;
  fs?: LaunchdFs;
  /** Override the LaunchAgents directory. Defaults to `~/Library/LaunchAgents`. */
  agentsDir?: string;
  /** Override the absolute log directory. */
  logDir?: string;
  /** Override the akm invocation argv. */
  akmArgv?: string[];
  /**
   * Override the PATH captured for `EnvironmentVariables` in the plist.
   * Set to `false` to disable PATH capture entirely.
   * When omitted, `process.env.PATH` at install time is used.
   */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

export const LAUNCHD_LABEL_PREFIX = "com.akm.task.";
const MAX_LAUNCHD_DOMAIN_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES = 4096;
const LAUNCHD_AKM_LABEL_RE = /^com\.akm\.task\.[A-Za-z0-9._-]{1,1024}$/u;
const LAUNCHD_SNAPSHOT = Symbol("akm-launchd-binding-snapshot");

interface LaunchdBindingSnapshot {
  readonly kind: typeof LAUNCHD_SNAPSHOT;
  readonly nativeIds: readonly string[];
  readonly artifacts: readonly SchedulerNativeArtifact[];
  readonly entries: readonly Readonly<{
    id: string;
    plist?: string;
    loaded: boolean;
    enabled: boolean;
  }>[];
}

interface LaunchdNamespaceEntry {
  readonly nativeId: string;
  readonly plist?: string;
  readonly loaded: boolean;
  readonly enabled: boolean;
  readonly artifact: SchedulerNativeArtifact;
}

interface StableLaunchdNamespace {
  readonly inspection: SchedulerBackendInspection;
  readonly entries: readonly LaunchdNamespaceEntry[];
}

interface LaunchdRestorePlanEntry {
  readonly entry: LaunchdBindingSnapshot["entries"][number];
  readonly immediateExpectation: SchedulerRollbackExpectation;
  readonly noOp: boolean;
}

export function LAUNCHD_BACKEND(options: LaunchdBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultLaunchdExec();
  const fsLike = options.fs ?? defaultLaunchdFs();
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();

  const plistPath = (nativeId: string) => path.join(agentsDir, `${LAUNCHD_LABEL_PREFIX}${nativeId}.plist`);
  const label = (nativeId: string) => `${LAUNCHD_LABEL_PREFIX}${nativeId}`;
  const target = (nativeId: string) => `gui/${exec.uid()}/${label(nativeId)}`;
  const defaultContextPath = launchdDefaultContextPath(options, scheduledContext);
  const setEnableState = (nativeId: string, enabled: boolean) => setLaunchdEnableState(exec, target(nativeId), enabled);

  return {
    name: "launchd",
    install(task: SchedulerBinding, opts?: SchedulerInstallOptions, expected?: SchedulerMutationExpectation) {
      installLaunchdBinding(task, opts, expected, {
        exec,
        fsLike,
        agentsDir,
        logDir,
        akmArgv,
        defaultContextPath,
        plistPath,
        label,
        target,
        setEnableState,
      });
    },
    uninstall(nativeId: string, expected?: SchedulerRemovalExpectation) {
      const inspectionContext = { exec, fsLike, agentsDir, plistPath, target, label };
      const initialNamespace = inspectStableLaunchdNamespace([nativeId], inspectionContext);
      let initialArtifact: SchedulerNativeArtifact | undefined;
      if (expected) {
        assertSchedulerExpectationIdentity({ ...expected, state: "present" });
        initialArtifact = assertSchedulerNativeArtifactCardinality(initialNamespace.inspection.artifacts, nativeId, 1);
        if (!initialArtifact) {
          throw new ConfigError(
            `launchd artifact ${JSON.stringify(nativeId)} disappeared during inspection.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRemovalArtifact(
          initialArtifact.nativeId,
          expected,
          initialArtifact.invocation,
          initialArtifact.fingerprint,
        );
      } else {
        initialArtifact = assertLaunchdDirectRemovalOwner(initialNamespace.inspection.artifacts, nativeId);
      }
      let resolvedNativeId = initialArtifact?.nativeId ?? nativeId;
      const file = plistPath(resolvedNativeId);
      const snapshot = snapshotLaunchdBindings([resolvedNativeId], {
        exec,
        fsLike,
        agentsDir,
        plistPath,
        target,
        label,
      });
      const finalArtifact = expected
        ? assertSchedulerNativeArtifactCardinality(snapshot.artifacts, nativeId, 1)
        : assertLaunchdDirectRemovalOwner(snapshot.artifacts, nativeId);
      if (expected) {
        if (!finalArtifact) {
          throw new ConfigError(
            `launchd artifact ${JSON.stringify(nativeId)} disappeared during snapshot.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRemovalArtifact(
          finalArtifact.nativeId,
          expected,
          finalArtifact.invocation,
          finalArtifact.fingerprint,
        );
      }
      if (!finalArtifact) return;
      resolvedNativeId = finalArtifact.nativeId;
      try {
        runOrThrow(exec, ["launchctl", "bootout", target(resolvedNativeId)], {
          isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
          message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
        });
        // launchctl disable overrides persist after the plist is removed.
        setEnableState(resolvedNativeId, true);
        if (fsLike.exists(file)) fsLike.removeFile(file);
      } catch (primaryError) {
        try {
          const rollbackExpected = [
            launchdRollbackExpectationForCurrent(resolvedNativeId, inspectionContext, initialArtifact),
          ];
          restoreLaunchdBindings(
            snapshot,
            { exec, fsLike, agentsDir, plistPath, target, label, setEnableState },
            rollbackExpected,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [primaryError, rollbackError],
            `${errorMessage(primaryError)}; rollback for launchd removal ${JSON.stringify(nativeId)} was incomplete.`,
          );
        }
        throw primaryError;
      }
    },
    setEnabled(nativeId: string, enabled: boolean) {
      setEnableState(nativeId, enabled);
    },
    list(): InstalledSchedulerBinding[] {
      return [
        ...inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label }).installed,
      ] as InstalledSchedulerBinding[];
    },
    listForRebind() {
      const namespace = inspectStableLaunchdNamespace([], { exec, fsLike, agentsDir, plistPath, target, label });
      const refs: Array<{ id: string; target?: string }> = [];
      for (const entry of namespace.entries) {
        if (entry.plist === undefined) continue;
        const installed = extractPlistInvocation(entry.plist);
        const id = entry.nativeId;
        const ref = {
          id: installed ? schedulerLogicalBindingId(id, installed.invocation) : id,
          ...(installed?.target !== undefined ? { target: installed.target } : {}),
        };
        Object.defineProperty(ref, "nativeId", { value: id });
        if (installed) Object.defineProperty(ref, "invocation", { value: Object.freeze([...installed.invocation]) });
        refs.push(ref);
      }
      return refs;
    },
    listNativeArtifacts() {
      return [...inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label }).artifacts];
    },
    inspectBindings() {
      return inspectLaunchdState({ exec, fsLike, agentsDir, plistPath, target, label });
    },
    snapshotBindings(ids: readonly string[]): LaunchdBindingSnapshot {
      return snapshotLaunchdBindings(ids, { exec, fsLike, agentsDir, plistPath, target, label });
    },
    restoreBindings(snapshot: unknown, expectedCurrent?: readonly SchedulerRollbackExpectation[]) {
      restoreLaunchdBindings(
        snapshot,
        { exec, fsLike, agentsDir, plistPath, target, label, setEnableState },
        expectedCurrent,
      );
    },
    expectedSignature(task: SchedulerBinding, opts?: SchedulerInstallOptions): string {
      return launchdFingerprint(
        buildPlistXml(
          task,
          [...(opts?.binding ?? akmArgv)],
          logDir,
          opts?.contextPath ?? defaultContextPath,
          opts?.target,
        ),
        task.enabled,
        true,
      );
    },
  };
}

function installLaunchdBinding(
  task: SchedulerBinding,
  opts: SchedulerInstallOptions | undefined,
  expected: SchedulerMutationExpectation | undefined,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    logDir: string;
    akmArgv: readonly string[];
    defaultContextPath: string;
    plistPath: (id: string) => string;
    label: (id: string) => string;
    target: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
): void {
  const { exec, fsLike, agentsDir, logDir, akmArgv, defaultContextPath, plistPath, label, target, setEnableState } =
    context;
  if (expected) assertSchedulerExpectationIdentity(expected, task);
  // Capture PATH at install time so launchd (which strips the environment
  // aggressively) can find the same binaries the user sees interactively.
  const xml = buildPlistXml(
    task,
    [...(opts?.binding ?? akmArgv)],
    logDir,
    opts?.contextPath ?? defaultContextPath,
    opts?.target,
  );
  const nativeId = schedulerBindingNativeId(task);
  const file = plistPath(nativeId);
  fsLike.ensureDir(agentsDir);
  // launchd refuses to start a job when StandardOutPath/StandardErrorPath
  // points at a non-existent directory; create it before reading or mutating
  // launchd state so a local preparation failure has no scheduler side effect.
  fsLike.ensureDir(logDir);
  const inspectionContext = { exec, fsLike, agentsDir, plistPath, target, label };
  const initialNamespace = inspectStableLaunchdNamespace([nativeId], inspectionContext);
  const initialArtifact = expected
    ? assertSchedulerNativeArtifactCardinality(
        initialNamespace.inspection.artifacts,
        nativeId,
        expected.state === "absent" ? 0 : 1,
      )
    : assertLaunchdDirectMutationOwner(initialNamespace.inspection.artifacts, nativeId, task);
  if (expected) assertSchedulerMutationArtifact(initialArtifact, expected);
  const priorEntry = initialArtifact
    ? initialNamespace.entries.find((entry) => entry.nativeId === initialArtifact.nativeId)
    : undefined;
  const previousPlist = priorEntry?.plist;
  const previousEnabled = priorEntry?.enabled ?? true;
  const tempFile = path.join(agentsDir, `.${nativeId}.${Date.now()}.tmp`);
  fsLike.writeFile(tempFile, xml);
  let bootoutCompleted = false;
  let previousWasLoaded = false;
  let fileReplaced = false;
  let enableStateTouched = false;
  try {
    if (expected) {
      const finalInspection = inspectStableLaunchdNamespace([nativeId], inspectionContext).inspection;
      const finalArtifact = assertSchedulerNativeArtifactCardinality(
        finalInspection.artifacts,
        nativeId,
        expected.state === "absent" ? 0 : 1,
      );
      assertSchedulerMutationArtifact(finalArtifact, expected);
    } else {
      const finalArtifact = assertLaunchdDirectMutationOwner(
        inspectStableLaunchdNamespace([nativeId], inspectionContext).inspection.artifacts,
        nativeId,
        task,
      );
      if (
        finalArtifact?.nativeId !== initialArtifact?.nativeId ||
        finalArtifact?.fingerprint !== initialArtifact?.fingerprint
      ) {
        throw new ConfigError(
          `launchd task ${JSON.stringify(nativeId)} changed while it was being prepared; refusing to replace an unverified owner.`,
          "INVALID_CONFIG_FILE",
        );
      }
    }
    const bootout = runOrThrow(exec, ["launchctl", "bootout", target(nativeId)], {
      isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
      message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
    });
    bootoutCompleted = true;
    previousWasLoaded = previousPlist !== undefined && bootout.status === 0;
    fsLike.replaceFile(tempFile, file);
    fileReplaced = true;
    // A disable override survives bootout and plist replacement. Clear it
    // before bootstrap, then apply the desired state after registration.
    enableStateTouched = true;
    setEnableState(nativeId, true);
    runOrThrow(exec, ["launchctl", "bootstrap", `gui/${exec.uid()}`, file], {
      message: (r) => `launchctl bootstrap failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
      hint: "Ensure `launchctl` is available; on macOS it is part of the base system.",
    });
    if (!task.enabled) setEnableState(nativeId, false);
  } catch (err) {
    if (!bootoutCompleted) throw err;
    const rollbackErrors: unknown[] = [];
    let priorFileRestored = !fileReplaced;
    if (fileReplaced) {
      let replacementUnloaded = false;
      try {
        const rollbackBootout = exec.run(["launchctl", "bootout", target(nativeId)]);
        replacementUnloaded = rollbackBootout.status === 0 || isServiceNotFoundResult(rollbackBootout);
        if (!replacementUnloaded) {
          rollbackErrors.push(
            new ConfigError(
              `launchctl bootout during rollback failed: ${rollbackBootout.stderr || rollbackBootout.stdout || "no output"}.`,
              "INVALID_CONFIG_FILE",
            ),
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (replacementUnloaded) {
        try {
          if (previousPlist === undefined) {
            if (fsLike.exists(file)) fsLike.removeFile(file);
          } else {
            fsLike.writeFile(tempFile, previousPlist);
            fsLike.replaceFile(tempFile, file);
          }
          priorFileRestored = true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    restoreLaunchdInstallState({
      exec,
      nativeId,
      file,
      previousPlist,
      previousEnabled,
      previousWasLoaded,
      priorFileRestored,
      enableStateTouched,
      setEnableState,
      rollbackErrors,
    });
    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError(
        [err, ...rollbackErrors],
        `${message}; rollback for launchd task "${task.id}" was incomplete.`,
      );
    }
    throw err;
  } finally {
    if (fsLike.exists(tempFile)) fsLike.removeFile(tempFile);
  }
}

function restoreLaunchdInstallState(input: {
  exec: LaunchdExec;
  nativeId: string;
  file: string;
  previousPlist: string | undefined;
  previousEnabled: boolean;
  previousWasLoaded: boolean;
  priorFileRestored: boolean;
  enableStateTouched: boolean;
  setEnableState: (id: string, enabled: boolean) => void;
  rollbackErrors: unknown[];
}): void {
  const {
    exec,
    nativeId,
    file,
    previousPlist,
    previousEnabled,
    previousWasLoaded,
    priorFileRestored,
    enableStateTouched,
    setEnableState,
    rollbackErrors,
  } = input;
  if (previousPlist !== undefined && previousWasLoaded && priorFileRestored) {
    try {
      setEnableState(nativeId, true);
      const restore = exec.run(["launchctl", "bootstrap", `gui/${exec.uid()}`, file]);
      if (restore.status !== 0) {
        rollbackErrors.push(
          new ConfigError(
            `launchctl bootstrap during rollback failed: ${restore.stderr || restore.stdout || "no output"}.`,
            "INVALID_CONFIG_FILE",
          ),
        );
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (!previousEnabled) {
      try {
        setEnableState(nativeId, false);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
  } else if (enableStateTouched) {
    try {
      setEnableState(nativeId, previousPlist === undefined || previousEnabled);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
}

function snapshotLaunchdBindings(
  ids: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
): LaunchdBindingSnapshot {
  const requestedKeys = new Set(ids.map(schedulerNativeArtifactKey));
  const namespace = inspectStableLaunchdNamespace(ids, context);
  const matchingEntries = namespace.entries.filter((entry) =>
    requestedKeys.has(schedulerNativeArtifactKey(entry.nativeId)),
  );
  const matchedKeys = new Set(matchingEntries.map((entry) => schedulerNativeArtifactKey(entry.nativeId)));
  const entries = [
    ...matchingEntries.map((entry) =>
      Object.freeze({
        id: entry.nativeId,
        ...(entry.plist !== undefined ? { plist: entry.plist } : {}),
        loaded: entry.loaded,
        enabled: entry.enabled,
      }),
    ),
    ...ids
      .filter((id) => !matchedKeys.has(schedulerNativeArtifactKey(id)))
      .map((id) => Object.freeze({ id, loaded: false, enabled: true })),
  ];
  const artifacts = matchingEntries.map((entry) => entry.artifact);
  return Object.freeze({
    kind: LAUNCHD_SNAPSHOT,
    nativeIds: Object.freeze([...ids]),
    artifacts: Object.freeze(artifacts),
    entries: Object.freeze(entries),
  });
}

function restoreLaunchdBindings(
  snapshot: unknown,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
  expectedCurrent?: readonly SchedulerRollbackExpectation[],
): void {
  if (!isLaunchdBindingSnapshot(snapshot)) {
    throw new ConfigError("Invalid launchd scheduler snapshot.", "INVALID_CONFIG_FILE");
  }
  const preflightErrors: unknown[] = [];
  const duplicateSnapshotKeys = new Set<string>();
  const requestedIdsByKey = new Map<string, string>();
  for (const nativeId of snapshot.nativeIds) {
    const key = schedulerNativeArtifactKey(nativeId);
    const priorId = requestedIdsByKey.get(key);
    if (priorId !== undefined) {
      duplicateSnapshotKeys.add(key);
      preflightErrors.push(
        new ConfigError(
          `Launchd scheduler snapshot requests normalized duplicate artifacts ${JSON.stringify(priorId)} and ${JSON.stringify(nativeId)}; refusing restore.`,
          "INVALID_CONFIG_FILE",
        ),
      );
      continue;
    }
    requestedIdsByKey.set(key, nativeId);
  }
  const snapshotEntryIdsByKey = new Map<string, string>();
  for (const entry of snapshot.entries) {
    const key = schedulerNativeArtifactKey(entry.id);
    const priorId = snapshotEntryIdsByKey.get(key);
    if (priorId !== undefined) {
      if (duplicateSnapshotKeys.has(key)) continue;
      duplicateSnapshotKeys.add(key);
      preflightErrors.push(
        new ConfigError(
          `Launchd scheduler snapshot contains normalized duplicate artifacts ${JSON.stringify(priorId)} and ${JSON.stringify(entry.id)}; refusing restore.`,
          "INVALID_CONFIG_FILE",
        ),
      );
      continue;
    }
    snapshotEntryIdsByKey.set(key, entry.id);
  }
  let rollbackInventory: SchedulerBackendInspection | undefined;
  try {
    rollbackInventory = inspectStableLaunchdNamespace(snapshot.nativeIds, context).inspection;
  } catch (error) {
    preflightErrors.push(error);
  }
  if (preflightErrors.length > 0) {
    throw new AggregateError(
      preflightErrors,
      `Failed to preflight ${preflightErrors.length} launchd scheduler restore operation(s).`,
    );
  }

  const expectationsById = new Map<string, SchedulerRollbackExpectation>();
  const expectationIdsByKey = new Map<string, string>();
  if (expectedCurrent) {
    for (const expected of expectedCurrent) {
      const key = schedulerNativeArtifactKey(expected.nativeId);
      const priorExact = expectationsById.get(expected.nativeId);
      const priorKeyId = expectationIdsByKey.get(key);
      if (priorExact !== undefined || priorKeyId !== undefined) {
        preflightErrors.push(
          new ConfigError(
            `Launchd rollback expectations contain duplicate normalized artifact ${JSON.stringify(expected.nativeId)}.`,
            "INVALID_CONFIG_FILE",
          ),
        );
        continue;
      }
      expectationsById.set(expected.nativeId, expected);
      expectationIdsByKey.set(key, expected.nativeId);
    }
  }

  const plannedEntries: LaunchdRestorePlanEntry[] = [];
  const coveredExpectationIds = new Set<string>();
  if (rollbackInventory) {
    for (const entry of snapshot.entries) {
      if (duplicateSnapshotKeys.has(schedulerNativeArtifactKey(entry.id))) continue;
      try {
        let current: SchedulerNativeArtifact | undefined;
        if (expectedCurrent) {
          const expected = expectationsById.get(entry.id);
          if (!expected) {
            throw new ConfigError(
              `Missing launchd rollback expectation for ${JSON.stringify(entry.id)}.`,
              "INVALID_CONFIG_FILE",
            );
          }
          coveredExpectationIds.add(entry.id);
          current = assertSchedulerRollbackArtifactCardinality(rollbackInventory.artifacts, expected);
        } else {
          const currentCount = rollbackInventory.artifacts.filter(
            (artifact) => schedulerNativeArtifactKey(artifact.nativeId) === schedulerNativeArtifactKey(entry.id),
          ).length;
          current = assertSchedulerNativeArtifactCardinality(
            rollbackInventory.artifacts,
            entry.id,
            currentCount === 0 ? 0 : 1,
          );
          if (current !== undefined && current.nativeId !== entry.id) {
            throw new ConfigError(
              `Launchd scheduler artifact ${JSON.stringify(entry.id)} changed to case- or suffix-equivalent spelling ${JSON.stringify(current.nativeId)} before restore.`,
              "INVALID_CONFIG_FILE",
            );
          }
        }
        if (entry.loaded && entry.plist === undefined) {
          assertUnrestorableLaunchdSnapshotUnchanged(entry, rollbackInventory.artifacts);
        }
        plannedEntries.push(
          Object.freeze({
            entry,
            immediateExpectation: launchdRollbackExpectationFromArtifact(entry.id, current),
            noOp: entry.loaded && entry.plist === undefined,
          }),
        );
      } catch (error) {
        preflightErrors.push(error);
      }
    }
  }
  if (expectedCurrent) {
    for (const expected of expectedCurrent) {
      if (!coveredExpectationIds.has(expected.nativeId)) {
        preflightErrors.push(
          new ConfigError(
            `Unexpected launchd rollback expectation for ${JSON.stringify(expected.nativeId)} is not covered by the snapshot.`,
            "INVALID_CONFIG_FILE",
          ),
        );
      }
    }
  }

  if (preflightErrors.length > 0) {
    throw new AggregateError(
      preflightErrors,
      `Failed to preflight ${preflightErrors.length} launchd scheduler restore operation(s).`,
    );
  }

  const errors: unknown[] = [];
  for (const planned of plannedEntries) {
    if (planned.noOp) continue;
    try {
      const immediateInventory = inspectStableLaunchdNamespace(snapshot.nativeIds, context).inspection;
      assertSchedulerRollbackArtifactCardinality(immediateInventory.artifacts, planned.immediateExpectation);
    } catch (error) {
      errors.push(error);
      continue;
    }
    restoreLaunchdBindingEntry(planned.entry, context, errors);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to completely restore ${errors.length} launchd scheduler operation(s).`);
  }
}

function launchdRollbackExpectationFromArtifact(
  nativeId: string,
  current: SchedulerNativeArtifact | undefined,
): SchedulerRollbackExpectation {
  if (current === undefined) {
    return Object.freeze({ nativeId, allowed: Object.freeze([{ state: "absent" as const }]) });
  }
  if (current.nativeId !== nativeId || current.fingerprint === undefined) {
    throw new ConfigError(
      `Launchd scheduler artifact ${JSON.stringify(nativeId)} has no exact restorable fingerprint.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return Object.freeze({
    nativeId,
    allowed: Object.freeze([
      Object.freeze({
        state: "present" as const,
        ...(current.bindingId !== undefined ? { bindingId: current.bindingId } : {}),
        ...(current.invocation !== undefined ? { invocation: current.invocation } : {}),
        fingerprint: current.fingerprint,
      }),
    ]),
  });
}

function assertUnrestorableLaunchdSnapshotUnchanged(
  entry: LaunchdBindingSnapshot["entries"][number],
  currentArtifacts: readonly SchedulerNativeArtifact[],
): void {
  const current = assertSchedulerNativeArtifactCardinality(currentArtifacts, entry.id, 1);
  const expectedFingerprint = launchdMissingPlistArtifact(entry.id, entry.enabled, entry.loaded).fingerprint;
  if (
    current?.nativeId !== entry.id ||
    current.invocation !== undefined ||
    current.bindingId !== undefined ||
    current.fingerprint !== expectedFingerprint
  ) {
    throw new ConfigError(
      `Loaded launchd artifact ${JSON.stringify(entry.id)} has no restorable plist and changed after its snapshot; refusing mutation.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

/**
 * Enumerate the current launchd AKM service namespace (loaded domain members,
 * print-disabled labels, and on-disk plists) in one pass.
 *
 * This used to run the enumeration twice and fail closed if the two passes
 * disagreed, guarding against launchd state mutating between the two
 * `launchctl` shell-outs (milliseconds apart, in-process). The only actor
 * that could cause that is another concurrent akm process or the user
 * running launchctl by hand at that exact instant; a subsequent `task sync`
 * (idempotent by design) reconciles any such drift on its own, so the
 * two-pass fencing added a TOCTOU-shaped guard around a race with a working
 * self-heal already in place, not a way to avoid one.
 */
function inspectStableLaunchdNamespace(
  seedIds: readonly string[],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
): StableLaunchdNamespace {
  const domain = context.exec.run(["launchctl", "print", `gui/${context.exec.uid()}`]);
  if (domain.status !== 0) {
    throw new ConfigError(
      `launchctl failed to enumerate the loaded user domain during scheduler state inspection: ${domain.stderr || domain.stdout || "no output"}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const loadedLabels = parseLaunchdLoadedLabels(domain.stdout);
  const disabledLabels = readDisabledLabels(context.exec);
  const akmDisabledLabels = [...disabledLabels].filter((label) => label.startsWith(LAUNCHD_LABEL_PREFIX)).sort();
  const plistEntries: Array<readonly [nativeId: string, raw: string]> = [];
  if (context.fsLike.exists(context.agentsDir)) {
    for (const file of context.fsLike.list(context.agentsDir).sort()) {
      if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
      const nativeId = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
      plistEntries.push(Object.freeze([nativeId, context.fsLike.readFile(context.plistPath(nativeId))]));
    }
  }
  const ids = new Set(seedIds);
  for (const [nativeId] of plistEntries) ids.add(nativeId);
  for (const serviceLabel of loadedLabels) ids.add(serviceLabel.slice(LAUNCHD_LABEL_PREFIX.length));
  for (const serviceLabel of akmDisabledLabels) ids.add(serviceLabel.slice(LAUNCHD_LABEL_PREFIX.length));
  const plistByNativeId = new Map(plistEntries);
  const entries: LaunchdNamespaceEntry[] = [];
  for (const nativeId of [...ids].sort()) {
    const serviceLabel = context.label(nativeId);
    const plist = plistByNativeId.get(nativeId);
    const enabled = !disabledLabels.has(serviceLabel);
    const loaded = loadedLabels.has(serviceLabel);
    if (plist === undefined && enabled && !loaded) continue;
    const artifact =
      plist === undefined
        ? launchdMissingPlistArtifact(nativeId, enabled, loaded)
        : launchdArtifact(nativeId, plist, enabled, loaded);
    entries.push(Object.freeze({ nativeId, ...(plist !== undefined ? { plist } : {}), enabled, loaded, artifact }));
  }
  const artifacts = entries.map((entry) => entry.artifact);
  const installed: InstalledSchedulerBinding[] = [];
  for (const entry of entries) {
    if (entry.plist === undefined) continue;
    const parsed = extractPlistInvocation(entry.plist);
    if (!parsed) continue;
    installed.push(
      withInstalledInvocation(
        {
          id: schedulerLogicalBindingId(entry.nativeId, parsed.invocation),
          enabled: entry.enabled && entry.loaded,
          ...(entry.loaded ? { signature: entry.artifact.fingerprint } : {}),
          ...(parsed.target !== undefined ? { target: parsed.target } : {}),
          binding: parsed.binding,
          contextPath: parsed.contextPath,
        },
        parsed.invocation,
        entry.nativeId,
      ),
    );
  }
  return Object.freeze({
    inspection: Object.freeze({ installed: Object.freeze(installed), artifacts: Object.freeze(artifacts) }),
    entries: Object.freeze(entries),
  });
}

function restoreLaunchdBindingEntry(
  entry: LaunchdBindingSnapshot["entries"][number],
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
    setEnableState: (id: string, enabled: boolean) => void;
  },
  errors: unknown[],
): void {
  try {
    runOrThrow(context.exec, ["launchctl", "bootout", context.target(entry.id)], {
      isOk: (result) => result.status === 0 || isServiceNotFoundResult(result),
      message: (result) =>
        `launchctl bootout failed while restoring task "${entry.id}": ${result.stderr || result.stdout || "no output"}.`,
    });
  } catch (error) {
    errors.push(error);
    return;
  }

  const file = context.plistPath(entry.id);
  let priorFileRestored = false;
  try {
    if (entry.plist === undefined) {
      if (context.fsLike.exists(file)) context.fsLike.removeFile(file);
    } else {
      context.fsLike.ensureDir(context.agentsDir);
      context.fsLike.writeFile(file, entry.plist);
    }
    priorFileRestored = true;
  } catch (error) {
    errors.push(error);
  }

  if (entry.loaded && entry.plist !== undefined && priorFileRestored) {
    let overrideCleared = false;
    try {
      // A disable override survives bootout. Clear it before bootstrap or
      // launchd can refuse to register the exact prior loaded definition.
      context.setEnableState(entry.id, true);
      overrideCleared = true;
    } catch (error) {
      errors.push(error);
    }
    if (overrideCleared) {
      try {
        runOrThrow(context.exec, ["launchctl", "bootstrap", `gui/${context.exec.uid()}`, file], {
          message: (result) =>
            `launchctl bootstrap failed while restoring task "${entry.id}": ${result.stderr || result.stdout || "no output"}.`,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  }

  try {
    // Apply the prior override last even when an earlier step failed; this is
    // both the exact state ordering and the best available partial recovery.
    context.setEnableState(entry.id, entry.enabled);
  } catch (error) {
    errors.push(error);
  }
}

function isLaunchdBindingSnapshot(value: unknown): value is LaunchdBindingSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === LAUNCHD_SNAPSHOT &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function inspectLaunchdState(context: {
  exec: LaunchdExec;
  fsLike: LaunchdFs;
  agentsDir: string;
  plistPath: (id: string) => string;
  target: (id: string) => string;
  label: (id: string) => string;
}): SchedulerBackendInspection {
  return inspectStableLaunchdNamespace([], context).inspection;
}

function assertLaunchdDirectMutationOwner(
  artifacts: readonly SchedulerNativeArtifact[],
  nativeId: string,
  task: SchedulerBinding,
): SchedulerNativeArtifact | undefined {
  const key = schedulerNativeArtifactKey(nativeId);
  const count = artifacts.filter((artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key).length;
  const artifact = assertSchedulerNativeArtifactCardinality(artifacts, nativeId, count === 0 ? 0 : 1);
  if (artifact) assertSchedulerNativeArtifactOwner(artifact.nativeId, task, artifact.invocation);
  return artifact;
}

function assertLaunchdDirectRemovalOwner(
  artifacts: readonly SchedulerNativeArtifact[],
  nativeId: string,
): SchedulerNativeArtifact | undefined {
  const key = schedulerNativeArtifactKey(nativeId);
  const count = artifacts.filter((artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key).length;
  const artifact = assertSchedulerNativeArtifactCardinality(artifacts, nativeId, count === 0 ? 0 : 1);
  if (!artifact) return undefined;
  if (artifact.nativeId !== nativeId || artifact.invocation === undefined) {
    throw new ConfigError(
      `launchd artifact ${JSON.stringify(artifact.nativeId)} is not the exact proven requested owner ${JSON.stringify(nativeId)}; refusing direct removal.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return artifact;
}

function launchdRollbackExpectationForCurrent(
  nativeId: string,
  context: {
    exec: LaunchdExec;
    fsLike: LaunchdFs;
    agentsDir: string;
    plistPath: (id: string) => string;
    target: (id: string) => string;
    label: (id: string) => string;
  },
  priorArtifact: SchedulerNativeArtifact | undefined,
): SchedulerRollbackExpectation {
  const namespace = inspectStableLaunchdNamespace([nativeId], context);
  const key = schedulerNativeArtifactKey(nativeId);
  const count = namespace.inspection.artifacts.filter(
    (artifact) => schedulerNativeArtifactKey(artifact.nativeId) === key,
  ).length;
  const artifact = assertSchedulerNativeArtifactCardinality(
    namespace.inspection.artifacts,
    nativeId,
    count === 0 ? 0 : 1,
  );
  if (!artifact) {
    return Object.freeze({ nativeId, allowed: Object.freeze([{ state: "absent" as const }]) });
  }
  if (
    artifact.fingerprint === undefined ||
    artifact.invocation === undefined ||
    priorArtifact?.invocation === undefined ||
    !sameStringArray(artifact.invocation, priorArtifact.invocation)
  ) {
    throw new ConfigError(
      `launchd artifact ${JSON.stringify(nativeId)} has no exact transaction-owned rollback fingerprint.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return Object.freeze({
    nativeId,
    allowed: Object.freeze([
      Object.freeze({
        state: "present" as const,
        ...(artifact.bindingId !== undefined ? { bindingId: artifact.bindingId } : {}),
        invocation: Object.freeze([...artifact.invocation]),
        fingerprint: artifact.fingerprint,
      }),
    ]),
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchdMissingPlistArtifact(nativeId: string, enabled: boolean, loaded: boolean): SchedulerNativeArtifact {
  const artifact: SchedulerNativeArtifact = { nativeId };
  Object.defineProperty(artifact, "fingerprint", {
    value: `launchd:missing-plist:enabled=${enabled}:loaded=${loaded}`,
  });
  return artifact;
}

function launchdArtifact(nativeId: string, raw: string, enabled?: boolean, loaded?: boolean): SchedulerNativeArtifact {
  const parsed = extractPlistInvocation(raw);
  const owner = parsed ? schedulerLogicalBindingOwner(nativeId, parsed.invocation) : undefined;
  const artifact: SchedulerNativeArtifact = parsed
    ? {
        nativeId,
        ...(owner !== undefined ? { bindingId: owner } : {}),
        invocation: Object.freeze([...parsed.invocation]),
      }
    : { nativeId };
  if (enabled !== undefined && loaded !== undefined) {
    Object.defineProperty(artifact, "fingerprint", { value: launchdFingerprint(raw, enabled, loaded) });
  }
  return artifact;
}

function launchdFingerprint(raw: string, enabled: boolean, loaded: boolean): string {
  const signed = raw.replace(/<!-- akm-enabled:(?:true|false) -->/, `<!-- akm-enabled:${enabled} -->`);
  return `${normalizeSignature(signed)}:loaded=${loaded}`;
}

function withInstalledInvocation(
  ref: InstalledSchedulerBinding,
  invocation: readonly string[],
  nativeId: string,
): InstalledSchedulerBinding {
  Object.defineProperty(ref, "nativeId", { value: nativeId });
  Object.defineProperty(ref, "invocation", { value: Object.freeze([...invocation]) });
  return ref;
}

function launchdDefaultContextPath(options: LaunchdBackendOptions, scheduledContext: ScheduledTaskContext): string {
  const pathEnv =
    options.envPath === false
      ? undefined
      : typeof options.envPath === "string"
        ? options.envPath
        : (process.env.PATH ?? "");
  return schedulerContextPath(schedulerContextDescriptor(scheduledContext, pathEnv ?? ""));
}

function setLaunchdEnableState(exec: LaunchdExec, nativeTarget: string, enabled: boolean): void {
  const verb = enabled ? "enable" : "disable";
  runOrThrow(exec, ["launchctl", verb, nativeTarget], {
    message: (result) => `launchctl ${verb} failed: ${result.stderr || result.stdout || "no output"}.`,
  });
}

export function extractPlistInvocation(xml: string): ReturnType<typeof parseScheduledBindingArgv> {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return undefined;
  const args = [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXmlEntities(m[1]!));
  return parseScheduledBindingArgv(args);
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export function buildPlistXml(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  contextPath: string,
  _target?: string,
): string {
  const spec = parseSchedule(task.cron, "launchd");
  const trigger = translateToLaunchd(spec);
  const invocation = buildScheduledBindingInvocation(akmArgv, contextPath, task.invocation);
  const argv = invocation.argv;
  const programArgs = argv.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  const triggerXml = renderLaunchdTrigger(trigger);

  const executionEvidence =
    task.executionEvidenceDigest === undefined
      ? ""
      : `  <!-- akm-workflow-evidence:${assertSchedulerExecutionEvidenceDigest(task.executionEvidenceDigest)} -->\n`;
  const xml = launchdTemplate
    .replace("<dict>\n", `<dict>\n  <!-- akm-enabled:${task.enabled} -->\n${executionEvidence}`)
    .replace("{{LABEL}}", LAUNCHD_LABEL_PREFIX + escapeXml(nativeId))
    .replace("{{PROGRAM_ARGS}}", programArgs)
    .replaceAll("{{LOG_PATH}}", escapeXml(logPath))
    .replace("{{ENV_VARS}}", "")
    .replace("{{TRIGGER_XML}}", triggerXml);
  for (const char of xml) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) {
      throw new ConfigError(
        "Launchd plist values must not contain XML-forbidden control characters.",
        "INVALID_CONFIG_FILE",
      );
    }
  }
  return xml;
}

function renderLaunchdTrigger(trigger: LaunchdTrigger): string {
  if (trigger.calendars !== undefined) {
    const lines = ["  <key>StartCalendarInterval</key>", "  <array>"];
    for (const calendar of trigger.calendars) {
      lines.push(...renderCalendar(calendar, "    "));
    }
    lines.push("  </array>");
    return lines.join("\n");
  }
  const cal = trigger.calendar ?? {};
  const lines = ["  <key>StartCalendarInterval</key>", ...renderCalendar(cal, "  ")];
  return lines.join("\n");
}

function renderCalendar(calendar: NonNullable<LaunchdTrigger["calendar"]>, indent: string): string[] {
  const valueIndent = `${indent}  `;
  const lines = [`${indent}<dict>`];
  if (calendar.Minute !== undefined) {
    lines.push(`${valueIndent}<key>Minute</key><integer>${calendar.Minute}</integer>`);
  }
  if (calendar.Hour !== undefined) lines.push(`${valueIndent}<key>Hour</key><integer>${calendar.Hour}</integer>`);
  if (calendar.Day !== undefined) lines.push(`${valueIndent}<key>Day</key><integer>${calendar.Day}</integer>`);
  if (calendar.Month !== undefined) lines.push(`${valueIndent}<key>Month</key><integer>${calendar.Month}</integer>`);
  if (calendar.Weekday !== undefined) {
    lines.push(`${valueIndent}<key>Weekday</key><integer>${calendar.Weekday}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines;
}

function normalizeSignature(xml: string): string {
  return xml.replace(/\r\n/g, "\n").trim();
}

/**
 * Collect the akm-owned service labels present in `launchctl` output.
 *
 * This reads the CURRENT USER'S OWN scheduler inventory — the tasks they asked
 * akm to schedule, on their own machine. It is not an attacker-controlled
 * document, so it is parsed permissively: scan for labels in our own
 * `com.akm.task.` namespace and ignore everything else.
 *
 * It previously enforced a rigid grammar over the whole document and returned
 * `undefined` — surfacing as a hard INVALID_CONFIG_FILE that refused to inspect
 * scheduler state at all — if ANY line failed to match. Real
 * `launchctl print gui/<uid>` output on macOS is far richer than that grammar
 * allowed, so on a real Mac this rejected the user's own inventory and broke
 * every launchd operation. Caught by the gated native-scheduler suite, which
 * had never been dispatched before.
 *
 * The two bounds that remain are real resource bounds, not structural ones: a
 * cap on how much output we will read, and a cap on how many distinct akm
 * labels we will track. Exceeding either still returns `undefined`.
 */
export function parseLaunchdLoadedLabels(output: string): Set<string> {
  const labels = new Set<string>();
  // Our own namespace is the only thing we look for. `[^\s"{}=,()]` stops the
  // token at whatever punctuation the surrounding launchctl syntax uses, so a
  // label works whether it appears as a bare table cell, a quoted string, or a
  // dictionary key.
  const labelPattern = /com\.akm\.task\.[^\s"{}=,()]+/gu;
  for (const match of boundLaunchdOutput(output).matchAll(labelPattern)) {
    const label = match[0];
    if (!LAUNCHD_AKM_LABEL_RE.test(label)) continue;
    labels.add(label);
    if (labels.size >= MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES) break;
  }
  return labels;
}

function boundLaunchdOutput(output: string): string {
  return output.length > MAX_LAUNCHD_DOMAIN_OUTPUT_BYTES ? output.slice(0, MAX_LAUNCHD_DOMAIN_OUTPUT_BYTES) : output;
}

function readDisabledLabels(exec: LaunchdExec): Set<string> {
  try {
    const result = exec.run(["launchctl", "print-disabled", `gui/${exec.uid()}`]);
    if (result.status !== 0) {
      warn("[akm] launchctl print-disabled exited %d; assuming no akm task is disabled.", result.status);
      return new Set();
    }
    return parseDisabledLabels(result.stdout);
  } catch (error) {
    warn(
      "[akm] launchctl print-disabled could not be run; assuming no akm task is disabled: %s",
      error instanceof Error ? error.message : String(error),
    );
    return new Set();
  }
}

function parseDisabledLabels(output: string): Set<string> {
  const disabled = new Set<string>();
  const entryPattern = /"(com\.akm\.task\.[^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)/gu;
  for (const match of boundLaunchdOutput(output).matchAll(entryPattern)) {
    const label = match[1]!;
    if (!LAUNCHD_AKM_LABEL_RE.test(label)) continue;
    if (match[2] === "true" || match[2] === "disabled") disabled.add(label);
    if (disabled.size >= MAX_LAUNCHD_AKM_NAMESPACE_ENTRIES) break;
  }
  return disabled;
}

function isServiceNotFoundResult(result: { stdout: string; stderr: string }): boolean {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /could not find service\b|service\b.*\bnot found\b|\bno such process\b/i.test(output);
}

function defaultAgentsDir(): string {
  // launchd's per-user LaunchAgents live under the user's home directory.
  // If we can't determine HOME, refuse rather than silently producing a
  // relative path that would write somewhere unexpected.
  const home = os.homedir();
  if (!home) {
    throw new ConfigError(
      "Cannot determine user home directory; launchd backend requires HOME to locate ~/Library/LaunchAgents.",
      "INVALID_CONFIG_FILE",
      "Set $HOME (POSIX) or the equivalent before running `akm task` on macOS.",
    );
  }
  return path.join(home, "Library", "LaunchAgents");
}

function defaultLaunchdExec(): LaunchdExec {
  return {
    ...nodeExec(),
    uid() {
      const fn = (process as { getuid?: () => number }).getuid;
      return typeof fn === "function" ? fn.call(process) : 0;
    },
  };
}

function defaultLaunchdFs(): LaunchdFs {
  return {
    ...nodeFs(),
    readFile(file) {
      return fs.readFileSync(file, "utf8");
    },
    removeFile(file) {
      fs.rmSync(file, { force: true });
    },
    replaceFile(source, destination) {
      fs.renameSync(source, destination);
    },
    list(dir) {
      try {
        return fs.readdirSync(dir);
      } catch (error) {
        // Genuinely absent is an empty listing; anything else (e.g. EACCES) is
        // not "no plists" — surfacing it as such could make inspectBindings
        // think there is nothing to reconcile.
        if (hasErrnoCode(error, "ENOENT")) return [];
        throw new ConfigError(`Unable to read LaunchAgents directory at "${dir}".`, "INVALID_CONFIG_FILE");
      }
    },
    exists(file) {
      return fs.existsSync(file);
    },
  };
}
