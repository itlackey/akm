// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * schtasks.exe backend for `akm task` (Windows default).
 *
 * Each task is registered under the `\akm\` Task Scheduler folder so the
 * backend never touches user-managed tasks. The full task definition is
 * sent through `schtasks /Create /TN \akm\<id> /XML <path>` so we can
 * express triggers/principals/actions without quoting hell.
 *
 * Platform notes:
 *   • `LogonType=InteractiveToken` means the task runs in the context of
 *     the registering user only when they are logged in — there is no
 *     stored password and the task will not fire at the lock screen.
 *   • `<Principal>` records the current user SID so sync can detect identity
 *     drift instead of silently accepting a task registered to another user.
 *   • `<DisallowStartIfOnBatteries>false</…>` and `<StopIfGoingOnBatteries>
 *     false</…>` allow the task to run on battery — utility tasks would
 *     otherwise be silently skipped on laptops.
 *   • `MultipleInstancesPolicy=IgnoreNew` makes overlapping triggers safe:
 *     while a task is still running, a new fire is dropped rather than
 *     queued or run in parallel.
 *   • `/Query /FO CSV /NH` (without `/V`) outputs three columns:
 *     `TaskName,Next Run Time,Status` — so the regex anchors on the task
 *     name as the leading quoted field. Adding `/V` would shift HostName
 *     into column 0; we deliberately don't.
 *
 * Tests inject a fake exec + filesystem.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import schtasksTemplate from "../../assets/backends/schtasks-template.xml" with { type: "text" };
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { parseSchedule, type SchtasksTrigger, translateToSchtasks } from "../schedule";
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
  schedulerNativeBindingId,
} from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import {
  type BackendExec,
  escapeXml,
  type NodeFs,
  nodeExec,
  nodeFs,
  normalizeXmlForUtf16File,
  runOrThrow,
} from "./exec-utils";
import type { InstalledSchedulerBinding, SchedulerBackend, SchedulerInstallOptions } from "./types";

export type SchtasksExec = BackendExec;

export type SchtasksFs = NodeFs & {
  removeFile(file: string): void;
  tmpdir(): string;
};

export interface SchtasksBackendOptions {
  exec?: SchtasksExec;
  fs?: SchtasksFs;
  /** Override the akm invocation argv. */
  akmArgv?: string[];
  /** Override the absolute log directory. */
  logDir?: string;
  /** Folder prefix for task names. Default `\akm\`. */
  folderPrefix?: string;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
  /** Override the current Windows user SID (tests). */
  userSid?: string;
}

export const DEFAULT_FOLDER_PREFIX = "\\akm\\";
const SIGNATURE_PREFIX = "akm:v1:";
const SCHTASKS_SNAPSHOT = Symbol("akm-schtasks-binding-snapshot");

interface SchtasksBindingSnapshot {
  readonly kind: typeof SCHTASKS_SNAPSHOT;
  readonly nativeIds: readonly string[];
  readonly artifacts: readonly SchedulerNativeArtifact[];
  readonly entries: readonly Readonly<{ id: string; xml?: string; enabled?: boolean }>[];
}

export function SCHTASKS_BACKEND(options: SchtasksBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultSchtasksExec();
  const fsLike = options.fs ?? defaultSchtasksFs();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const logDir = options.logDir ?? getTaskLogDir();
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext, process.env.PATH ?? ""));
  const userSid = options.userSid ?? resolveCurrentUserSid(exec);
  const taskName = (nativeId: string) => `${folder}${nativeId}`;

  return {
    name: "schtasks",
    install(task: SchedulerBinding, opts?: SchedulerInstallOptions, expected?: SchedulerMutationExpectation) {
      if (expected) assertSchedulerExpectationIdentity(expected, task);
      const nativeId = schedulerBindingNativeId(task);
      const xml = normalizeXmlForUtf16File(
        buildSchtasksXml(task, akmArgv, logDir, {
          folderPrefix: folder,
          contextPath: opts?.contextPath ?? defaultContextPath,
          userSid,
          binding: [...(opts?.binding ?? akmArgv)],
          ...(opts?.target !== undefined ? { target: opts.target } : {}),
        }),
      );
      const initialArtifact = expected
        ? assertSchedulerNativeArtifactCardinality(
            inspectSchtasksState(exec, folder, taskName).artifacts,
            nativeId,
            expected.state === "absent" ? 0 : 1,
          )
        : undefined;
      const existingNativeId = expected ? initialArtifact?.nativeId : nativeId;
      const query = existingNativeId
        ? runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(existingNativeId), "/XML"], {
            isOk: (r) => r.status === 0 || isMissingTaskResult(r),
            message: (r) => `schtasks /Query failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
          })
        : { status: 1, stdout: "", stderr: "missing" };
      if (expected) {
        assertSchedulerMutationArtifact(
          query.status === 0 && existingNativeId ? schtasksArtifact(existingNativeId, query.stdout) : undefined,
          expected,
        );
      }
      let previous: { xml: string; enabled: boolean } | undefined;
      if (query.status === 0) {
        if (!expected) {
          assertSchedulerNativeArtifactOwner(nativeId, task, extractSchtasksInvocation(query.stdout)?.invocation);
        }
        const enabled = taskXmlEnabled(query.stdout);
        if (enabled === undefined) {
          throw new ConfigError(
            `schtasks /Query returned an unreadable definition for "${taskName(nativeId)}"; refusing to replace it.`,
            "INVALID_CONFIG_FILE",
          );
        }
        previous = { xml: normalizeXmlForUtf16File(query.stdout), enabled };
      }
      fsLike.ensureDir(logDir);
      const tmpFile = path.join(fsLike.tmpdir(), `akm-task-${nativeId}-${Date.now()}.xml`);
      fsLike.writeFile(tmpFile, xml);
      try {
        if (expected) {
          const finalArtifact = assertSchedulerNativeArtifactCardinality(
            inspectSchtasksState(exec, folder, taskName).artifacts,
            nativeId,
            expected.state === "absent" ? 0 : 1,
          );
          const finalNativeId = finalArtifact?.nativeId;
          const current = finalNativeId
            ? runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(finalNativeId), "/XML"], {
                isOk: (result) => result.status === 0 || isMissingTaskResult(result),
                message: (result) =>
                  `schtasks /Query failed during final install CAS (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
              })
            : undefined;
          assertSchedulerMutationArtifact(
            current?.status === 0 && finalNativeId ? schtasksArtifact(finalNativeId, current.stdout) : undefined,
            expected,
          );
        } else {
          assertSchtasksArtifactUnchanged(exec, taskName(nativeId), nativeId, task);
        }
        try {
          // /F forces overwrite if a task with the same name exists.
          runOrThrow(exec, ["schtasks", "/Create", "/TN", taskName(nativeId), "/XML", tmpFile, "/F"], {
            message: (r) => `schtasks /Create failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
          });
          if (!task.enabled) {
            runOrThrow(exec, ["schtasks", "/Change", "/TN", taskName(nativeId), "/DISABLE"], {
              message: (r) => `schtasks /Change /DISABLE failed: ${r.stderr || r.stdout || "no output"}.`,
            });
          }
        } catch (err) {
          const rollbackErrors: unknown[] = [];
          if (previous === undefined) {
            try {
              const remove = exec.run(["schtasks", "/Delete", "/TN", taskName(nativeId), "/F"]);
              if (remove.status !== 0 && !isMissingTaskResult(remove)) {
                rollbackErrors.push(
                  new ConfigError(
                    `schtasks /Delete during rollback failed: ${remove.stderr || remove.stdout || "no output"}.`,
                    "INVALID_CONFIG_FILE",
                  ),
                );
              }
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          } else {
            try {
              fsLike.writeFile(tmpFile, previous.xml);
              runOrThrow(exec, ["schtasks", "/Create", "/TN", taskName(nativeId), "/XML", tmpFile, "/F"], {
                message: (r) => `schtasks /Create during rollback failed: ${r.stderr || r.stdout || "no output"}.`,
              });
              const stateFlag = previous.enabled ? "/ENABLE" : "/DISABLE";
              runOrThrow(exec, ["schtasks", "/Change", "/TN", taskName(nativeId), stateFlag], {
                message: (r) =>
                  `schtasks /Change ${stateFlag} during rollback failed: ${r.stderr || r.stdout || "no output"}.`,
              });
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length > 0) {
            const message = err instanceof Error ? err.message : String(err);
            throw new AggregateError(
              [err, ...rollbackErrors],
              `${message}; rollback for Task Scheduler task "${task.id}" was incomplete.`,
            );
          }
          throw err;
        }
      } finally {
        fsLike.removeFile(tmpFile);
      }
    },
    uninstall(nativeId: string, expected?: SchedulerRemovalExpectation) {
      if (expected) {
        assertSchedulerExpectationIdentity({ ...expected, state: "present" });
        const artifact = assertSchedulerNativeArtifactCardinality(
          inspectSchtasksState(exec, folder, taskName).artifacts,
          nativeId,
          1,
        );
        const currentNativeId = artifact?.nativeId ?? nativeId;
        const current = runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(currentNativeId), "/XML"], {
          isOk: (result) => result.status === 0 || isMissingTaskResult(result),
          message: (result) =>
            `schtasks /Query failed during final removal ownership check (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
        });
        if (current.status !== 0) {
          throw new ConfigError(
            `Task Scheduler artifact ${JSON.stringify(nativeId)} disappeared after coherent inspection.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRemovalArtifact(
          currentNativeId,
          expected,
          extractSchtasksInvocation(current.stdout)?.invocation,
          installedSignature(current.stdout),
        );
      }
      runOrThrow(exec, ["schtasks", "/Delete", "/TN", taskName(nativeId), "/F"], {
        isOk: (r) => r.status === 0 || /cannot find/i.test(r.stderr ?? ""),
        message: (r) => `schtasks /Delete failed: ${r.stderr || r.stdout || "no output"}.`,
      });
    },
    setEnabled(nativeId: string, enabled: boolean) {
      const flag = enabled ? "/ENABLE" : "/DISABLE";
      runOrThrow(exec, ["schtasks", "/Change", "/TN", taskName(nativeId), flag], {
        message: (r) => `schtasks /Change ${flag} failed: ${r.stderr || r.stdout || "no output"}.`,
      });
    },
    list(): InstalledSchedulerBinding[] {
      return [...inspectSchtasksState(exec, folder, taskName).installed] as InstalledSchedulerBinding[];
    },
    listForRebind() {
      return listSchtasksForRebind(exec, folder, taskName);
    },
    listNativeArtifacts() {
      return [...inspectSchtasksState(exec, folder, taskName).artifacts];
    },
    inspectBindings() {
      return inspectSchtasksState(exec, folder, taskName);
    },
    snapshotBindings(ids: readonly string[]): SchtasksBindingSnapshot {
      return snapshotSchtasksBindings(ids, exec, folder, taskName);
    },
    restoreBindings(snapshot: unknown, expectedCurrent?: readonly SchedulerRollbackExpectation[]) {
      restoreSchtasksBindings(snapshot, { exec, fsLike, folder, taskName }, expectedCurrent);
    },
    expectedSignature(task: SchedulerBinding, opts?: SchedulerInstallOptions): string {
      const signature = taskXmlSignature(
        buildSchtasksXml(task, akmArgv, logDir, {
          folderPrefix: folder,
          contextPath: opts?.contextPath ?? defaultContextPath,
          userSid,
          binding: [...(opts?.binding ?? akmArgv)],
          ...(opts?.target !== undefined ? { target: opts.target } : {}),
        }),
      );
      if (signature === undefined) throw new Error("Failed to fingerprint generated Task Scheduler XML.");
      return signature;
    },
  };
}

function listSchtasksForRebind(
  exec: SchtasksExec,
  folder: string,
  taskName: (id: string) => string,
): Array<{ id: string; signature?: string; target?: string }> {
  const result = runOrThrow(exec, ["schtasks", "/Query", "/FO", "CSV", "/NH"], {
    message: (query) =>
      `schtasks /Query failed (exit ${query.status}): ${query.stderr || query.stdout || "no output"}.`,
  });
  const refs: Array<{ id: string; signature?: string; target?: string }> = [];
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const name = line.match(/^"([^"]+)",/)?.[1];
    if (!name?.startsWith(folder)) continue;
    const id = name.slice(folder.length);
    const query = runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(id), "/XML"], {
      message: (current) =>
        `schtasks /Query /XML for "${taskName(id)}" failed (exit ${current.status}): ${current.stderr || current.stdout || "no output"}.`,
    });
    const signature = installedSignature(query.stdout);
    const installed = extractSchtasksInvocation(query.stdout);
    const ref = {
      id: installed ? schedulerLogicalBindingId(id, installed.invocation) : id,
      ...(signature !== undefined ? { signature } : {}),
      ...(installed?.target !== undefined ? { target: installed.target } : {}),
    };
    Object.defineProperty(ref, "nativeId", { value: id });
    if (installed) Object.defineProperty(ref, "invocation", { value: Object.freeze([...installed.invocation]) });
    refs.push(ref);
  }
  return refs;
}

function inspectSchtasksState(
  exec: SchtasksExec,
  folder: string,
  taskName: (id: string) => string,
): SchedulerBackendInspection {
  const listing = runOrThrow(exec, ["schtasks", "/Query", "/FO", "CSV", "/NH"], {
    message: (result) =>
      `schtasks /Query failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
  });
  const installed: InstalledSchedulerBinding[] = [];
  const artifacts: SchedulerNativeArtifact[] = [];
  for (const nativeId of schtasksNativeIds(listing.stdout, folder)) {
    const query = runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(nativeId), "/XML"], {
      message: (result) =>
        `schtasks /Query /XML for "${taskName(nativeId)}" failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    });
    const artifact = schtasksArtifact(nativeId, query.stdout);
    artifacts.push(artifact);
    const parsed = extractSchtasksInvocation(query.stdout);
    if (!parsed) continue;
    const enabled = taskXmlEnabled(query.stdout);
    const ref: InstalledSchedulerBinding = {
      id: schedulerLogicalBindingId(nativeId, parsed.invocation),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(artifact.fingerprint !== undefined ? { signature: artifact.fingerprint } : {}),
      ...(parsed.target !== undefined ? { target: parsed.target } : {}),
      binding: parsed.binding,
      contextPath: parsed.contextPath,
    };
    Object.defineProperty(ref, "nativeId", { value: nativeId });
    Object.defineProperty(ref, "invocation", { value: Object.freeze([...parsed.invocation]) });
    installed.push(ref);
  }
  return Object.freeze({ installed: Object.freeze(installed), artifacts: Object.freeze(artifacts) });
}

function schtasksNativeIds(stdout: string | undefined, folder: string): readonly string[] {
  const ids: string[] = [];
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)",/);
    const name = match?.[1];
    if (name?.startsWith(folder)) ids.push(name.slice(folder.length));
  }
  return ids;
}

function schtasksArtifact(nativeId: string, xml: string): SchedulerNativeArtifact {
  const parsed = extractSchtasksInvocation(xml);
  const owner = parsed ? schedulerLogicalBindingOwner(nativeId, parsed.invocation) : undefined;
  const artifact: SchedulerNativeArtifact = parsed
    ? {
        nativeId,
        ...(owner !== undefined ? { bindingId: owner } : {}),
        invocation: Object.freeze([...parsed.invocation]),
      }
    : { nativeId };
  const fingerprint = installedSignature(xml);
  if (fingerprint !== undefined) Object.defineProperty(artifact, "fingerprint", { value: fingerprint });
  return artifact;
}

function snapshotSchtasksBindings(
  ids: readonly string[],
  exec: SchtasksExec,
  folder: string,
  taskName: (id: string) => string,
): SchtasksBindingSnapshot {
  const listing = runOrThrow(exec, ["schtasks", "/Query", "/FO", "CSV", "/NH"], {
    message: (result) =>
      `schtasks /Query failed while snapshotting bindings (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
  });
  const requestedKeys = new Set(ids.map(schedulerNativeArtifactKey));
  const enumeratedIds = new Set(ids);
  for (const nativeId of schtasksNativeIds(listing.stdout, folder)) {
    if (requestedKeys.has(schedulerNativeArtifactKey(nativeId))) enumeratedIds.add(nativeId);
  }
  const entries: SchtasksBindingSnapshot["entries"] = [...enumeratedIds].map((id) => {
    const query = runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(id), "/XML"], {
      isOk: (result) => result.status === 0 || isMissingTaskResult(result),
      message: (result) =>
        `schtasks /Query failed while snapshotting "${taskName(id)}": ${result.stderr || result.stdout || "no output"}.`,
    });
    if (query.status !== 0) return Object.freeze({ id });
    const enabled = taskXmlEnabled(query.stdout);
    if (enabled === undefined) {
      throw new ConfigError(
        `schtasks /Query returned an unreadable definition while snapshotting "${taskName(id)}".`,
        "INVALID_CONFIG_FILE",
      );
    }
    return Object.freeze({ id, xml: normalizeXmlForUtf16File(query.stdout), enabled });
  });
  const artifacts = entries.flatMap((entry) =>
    entry.xml === undefined ? [] : [schtasksArtifact(entry.id, entry.xml)],
  );
  return Object.freeze({
    kind: SCHTASKS_SNAPSHOT,
    nativeIds: Object.freeze([...ids]),
    artifacts: Object.freeze(artifacts),
    entries: Object.freeze(entries),
  });
}

function restoreSchtasksBindings(
  snapshot: unknown,
  context: { exec: SchtasksExec; fsLike: SchtasksFs; folder: string; taskName: (id: string) => string },
  expectedCurrent?: readonly SchedulerRollbackExpectation[],
): void {
  if (!isSchtasksBindingSnapshot(snapshot)) {
    throw new ConfigError("Invalid Task Scheduler snapshot.", "INVALID_CONFIG_FILE");
  }
  const errors: unknown[] = [];
  let rollbackInventory: SchedulerBackendInspection | undefined;
  if (expectedCurrent) {
    try {
      rollbackInventory = inspectSchtasksState(context.exec, context.folder, context.taskName);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const entry of snapshot.entries) {
    try {
      if (expectedCurrent) {
        if (!rollbackInventory) continue;
        const expected = expectedCurrent.find((candidate) => candidate.nativeId === entry.id);
        if (!expected) {
          throw new ConfigError(
            `Missing Task Scheduler rollback expectation for ${JSON.stringify(entry.id)}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertSchedulerRollbackArtifactCardinality(rollbackInventory.artifacts, expected);
      }
      restoreSchtasksEntry(entry, context);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to completely restore ${errors.length} Task Scheduler operation(s).`);
  }
}

function restoreSchtasksEntry(
  entry: SchtasksBindingSnapshot["entries"][number],
  context: { exec: SchtasksExec; fsLike: SchtasksFs; taskName: (id: string) => string },
): void {
  if (entry.xml === undefined) {
    runOrThrow(context.exec, ["schtasks", "/Delete", "/TN", context.taskName(entry.id), "/F"], {
      isOk: (result) => result.status === 0 || isMissingTaskResult(result),
      message: (result) =>
        `schtasks /Delete failed while restoring "${context.taskName(entry.id)}": ${result.stderr || result.stdout || "no output"}.`,
    });
    return;
  }
  const tmpFile = path.join(
    context.fsLike.tmpdir(),
    `akm-task-restore-${schedulerNativeBindingId(entry.id)}-${Date.now()}.xml`,
  );
  context.fsLike.writeFile(tmpFile, entry.xml);
  try {
    runOrThrow(context.exec, ["schtasks", "/Create", "/TN", context.taskName(entry.id), "/XML", tmpFile, "/F"], {
      message: (result) =>
        `schtasks /Create failed while restoring "${context.taskName(entry.id)}": ${result.stderr || result.stdout || "no output"}.`,
    });
    const stateFlag = entry.enabled === false ? "/DISABLE" : "/ENABLE";
    runOrThrow(context.exec, ["schtasks", "/Change", "/TN", context.taskName(entry.id), stateFlag], {
      message: (result) =>
        `schtasks /Change ${stateFlag} failed while restoring "${context.taskName(entry.id)}": ${result.stderr || result.stdout || "no output"}.`,
    });
  } finally {
    context.fsLike.removeFile(tmpFile);
  }
}

function isSchtasksBindingSnapshot(value: unknown): value is SchtasksBindingSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === SCHTASKS_SNAPSHOT &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

/**
 * Recover the bundle name embedded as a `--bundle <bundle>` pair in the
 * PowerShell `<Arguments>` of an installed Task Scheduler definition. Returns
 * undefined for the primary/default form.
 */
export function extractSchtasksTarget(xml: string): string | undefined {
  return extractSchtasksInvocation(xml)?.target;
}

export function extractSchtasksInvocation(xml: string): ReturnType<typeof parseScheduledBindingArgv> {
  const argsElement = xml.match(/<(?:[\w.-]+:)?Arguments>([\s\S]*?)<\/(?:[\w.-]+:)?Arguments>/i);
  if (!argsElement) return undefined;
  const commandLine = decodeXml(argsElement[1]!);
  const invocationStart = findPowerShellInvocationOperator(commandLine);
  if (invocationStart === undefined) return undefined;
  return parseScheduledBindingArgv(parsePowerShellSingleQuotedArgs(commandLine, invocationStart + 1));
}

function findPowerShellInvocationOperator(script: string): number | undefined {
  let inSingleQuote = false;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (char === "'") {
      if (inSingleQuote && script[index + 1] === "'") {
        index += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }
    if (!inSingleQuote && char === "&" && /\s/.test(script[index + 1] ?? "")) return index;
  }
  return undefined;
}

function parsePowerShellSingleQuotedArgs(script: string, start: number): string[] {
  const argv: string[] = [];
  let index = start;
  while (index < script.length) {
    while (/\s/.test(script[index] ?? "")) index += 1;
    if (script[index] === ";" || script[index] === '"' || index >= script.length) break;
    if (script[index] !== "'") return [];
    index += 1;
    let value = "";
    let closed = false;
    while (index < script.length) {
      const char = script[index];
      if (char !== "'") {
        value += char;
        index += 1;
        continue;
      }
      if (script[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      index += 1;
      closed = true;
      break;
    }
    if (!closed) return [];
    argv.push(value);
  }
  return argv;
}

/**
 * Re-verify ownership of the native artifact immediately before `/Create /F`
 * overwrites it (the read/prepare-to-/Create ownership race at the native
 * boundary).
 *
 * This used to also compare the fresh query against the first read taken
 * earlier in `install` and refuse the whole operation if anything about the
 * XML had changed in between -- a freshness re-check on top of the identity
 * re-check right below it. That extra comparison never caught anything the
 * owner check didn't already cover (a foreign/changed owner still fails
 * `assertSchedulerNativeArtifactOwner`), and `task sync` is idempotent, so a
 * spurious refusal here only cost the user a rerun of a command they'd
 * already asked for. Dropped; the owner re-check (the actual corruption/
 * clobber guard -- no fallback exists if a foreign task got silently
 * overwritten) stays.
 */
function assertSchtasksArtifactUnchanged(
  exec: SchtasksExec,
  nativeTaskName: string,
  nativeId: string,
  task: SchedulerBinding,
): void {
  // This runs outside install's rollback region: no scheduler mutation has
  // occurred, so a raced owner must remain untouched rather than be restored
  // from the stale first read.
  const current = runOrThrow(exec, ["schtasks", "/Query", "/TN", nativeTaskName, "/XML"], {
    isOk: (result) => result.status === 0 || isMissingTaskResult(result),
    message: (result) =>
      `schtasks /Query failed during final ownership check (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
  });
  if (current.status === 0) {
    assertSchedulerNativeArtifactOwner(nativeId, task, extractSchtasksInvocation(current.stdout)?.invocation);
  }
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export interface BuildSchtasksXmlOptions {
  /** Task folder prefix (e.g. `\\akm\\`). Used to build the <URI>. */
  folderPrefix?: string;
  /** Override the clock used to find the next StartBoundary (tests). */
  now?: () => Date;
  /** Immutable runtime context descriptor loaded by the launcher. */
  contextPath: string;
  /** Bootstrap argv. Defaults to the positional akmArgv. */
  binding?: string[];
  /** Current Windows user SID embedded in the principal. */
  userSid: string;
  /** Non-default bundle embedded as a `--bundle <bundle>` token. */
  target?: string;
}

interface SchtasksDefinition {
  trigger: SchtasksTrigger;
  command: string;
  args: string;
  logPath: string;
  signature: string;
}

export function buildSchtasksXml(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  options: BuildSchtasksXmlOptions,
): string {
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const now = options.now ? options.now() : new Date();
  const definition = buildSchtasksDefinition(
    task,
    options.binding ?? akmArgv,
    logDir,
    folder,
    options.contextPath,
    options.userSid,
    options.target,
  );
  const triggerXml = renderSchtasksTrigger(definition.trigger, now);
  const nativeId = schedulerBindingNativeId(task);

  return schtasksTemplate
    .replaceAll("{{TASK_ID}}", escapeXml(nativeId))
    .replaceAll("{{FOLDER}}", escapeXml(folder))
    .replace("{{SIGNATURE}}", definition.signature)
    .replace("{{TRIGGER_XML}}", triggerXml)
    .replace('<Principal id="Author">', `<Principal id="Author">\n      <UserId>${escapeXml(options.userSid)}</UserId>`)
    .replace("{{ENABLED}}", task.enabled ? "true" : "false")
    .replace("{{COMMAND}}", escapeXml(definition.command))
    .replace("{{ARGS}}", escapeXml(definition.args))
    .replace("{{LOG_PATH}}", escapeXml(definition.logPath));
}

function buildSchtasksDefinition(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  folder: string,
  contextPath: string,
  userSid: string,
  _target?: string,
): SchtasksDefinition {
  const spec = parseSchedule(task.cron, "schtasks");
  const trigger = translateToSchtasks(spec);
  const invocation = buildScheduledBindingInvocation(akmArgv, contextPath, task.invocation);
  const invoke = `& ${invocation.argv.map((arg) => quotePowerShell(arg)).join(" ")}`;
  const executionEvidence =
    task.executionEvidenceDigest === undefined
      ? ""
      : `$null=${quotePowerShell(`akm-workflow-evidence:${assertSchedulerExecutionEvidenceDigest(task.executionEvidenceDigest)}`)}; `;
  const script = `${executionEvidence}${invoke}; exit $LASTEXITCODE`;
  const command = "powershell.exe";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script].map(quoteArg).join(" ");
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  // The boundary changes on reinstall, and enabled state can change via /Change.
  // Keep both outside the stored definition fingerprint so no-op sync stays stable.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ folder, id: nativeId, trigger, command, args, logPath, userSid }))
    .digest("hex");
  return { trigger, command, args, logPath, signature: `${SIGNATURE_PREFIX}${fingerprint}` };
}

interface NativeDailyTrigger {
  kind: "daily";
  atHour: number;
  atMinute: number;
  repeatEveryMinutes?: number;
}

interface NativeWeeklyTrigger {
  kind: "weekly";
  atHour: number;
  atMinute: number;
  daysOfWeek: number[];
}

interface NativeMonthlyTrigger {
  kind: "monthly";
  atHour: number;
  atMinute: number;
  daysOfMonth: number[];
  months: number[];
}

type NativeSchtasksTrigger = NativeDailyTrigger | NativeWeeklyTrigger | NativeMonthlyTrigger;

function renderSchtasksTrigger(trigger: SchtasksTrigger, now: Date): string {
  return expandNativeTriggers(trigger)
    .map((native) => renderNativeTrigger(native, formatStartBoundary(nextStartBoundary(native, now))))
    .join("\n");
}

function expandNativeTriggers(trigger: SchtasksTrigger): NativeSchtasksTrigger[] {
  switch (trigger.kind) {
    case "minute":
      return [{ kind: "daily", atHour: 0, atMinute: 0, repeatEveryMinutes: trigger.everyMinutes }];
    case "minuteValues":
      return trigger.minutes.map((atMinute) => ({ kind: "daily", atHour: 0, atMinute, repeatEveryMinutes: 60 }));
    case "hour":
      return [
        {
          kind: "daily",
          atHour: 0,
          atMinute: trigger.atMinute,
          repeatEveryMinutes: trigger.everyHours * 60,
        },
      ];
    case "hourValues":
      return trigger.hours.map((atHour) => ({ kind: "daily", atHour, atMinute: trigger.atMinute }));
    case "daily":
      return [{ kind: "daily", atHour: trigger.atHour, atMinute: trigger.atMinute }];
    case "weekly":
      return [trigger];
    case "monthly":
      return [trigger];
  }
}

function renderNativeTrigger(trigger: NativeSchtasksTrigger, startBoundary: string): string {
  if (trigger.kind === "daily") {
    const repetition =
      trigger.repeatEveryMinutes === undefined
        ? ""
        : `      <Repetition>
        <Interval>${formatRepetitionInterval(trigger.repeatEveryMinutes)}</Interval>
        <Duration>${formatRepetitionDuration(trigger.repeatEveryMinutes)}</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
`;
    return `    <CalendarTrigger>
${repetition}      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`;
  }

  if (trigger.kind === "weekly") {
    const dayMap = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const days = trigger.daysOfWeek.map((d) => `        <${dayMap[d]} />`).join("\n");
    return `    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek>
${days}
        </DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>`;
  }

  const monthMap = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const days = trigger.daysOfMonth.map((d) => `          <Day>${d}</Day>`).join("\n");
  const months = trigger.months.map((m) => `        <${monthMap[m - 1]} />`).join("\n");
  return `    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth>
${days}
        </DaysOfMonth>
        <Months>
${months}
        </Months>
      </ScheduleByMonth>
    </CalendarTrigger>`;
}

function formatRepetitionInterval(minutes: number): string {
  return formatMinuteDuration(minutes);
}

function formatRepetitionDuration(intervalMinutes: number): string {
  return formatMinuteDuration(24 * 60 - intervalMinutes);
}

function formatMinuteDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const hourPart = hours > 0 ? `${hours}H` : "";
  const minutePart = remainingMinutes > 0 ? `${remainingMinutes}M` : "";
  return `PT${hourPart}${minutePart}`;
}

function nextStartBoundary(trigger: NativeSchtasksTrigger, now: Date): Date {
  const boundary = new Date(now.getTime());
  switch (trigger.kind) {
    case "daily":
      boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      if (trigger.repeatEveryMinutes !== undefined) {
        while (boundary.getTime() <= now.getTime()) {
          boundary.setMinutes(boundary.getMinutes() + trigger.repeatEveryMinutes);
        }
      } else if (boundary.getTime() <= now.getTime()) {
        boundary.setDate(boundary.getDate() + 1);
      }
      return boundary;
    case "weekly":
      boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      while (!trigger.daysOfWeek.includes(boundary.getDay()) || boundary.getTime() <= now.getTime()) {
        boundary.setDate(boundary.getDate() + 1);
        boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      }
      return boundary;
    case "monthly": {
      boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      const daysOfMonth = new Set(trigger.daysOfMonth);
      const months = new Set(trigger.months);
      for (let guard = 0; guard < 4000; guard++) {
        if (
          daysOfMonth.has(boundary.getDate()) &&
          months.has(boundary.getMonth() + 1) &&
          boundary.getTime() > now.getTime()
        ) {
          break;
        }
        boundary.setDate(boundary.getDate() + 1);
        boundary.setHours(trigger.atHour, trigger.atMinute, 0, 0);
      }
      return boundary;
    }
  }
}

function formatStartBoundary(d: Date): string {
  // Local-time ISO-8601 (no zone suffix) — Task Scheduler interprets a
  // bare boundary in the registering user's timezone, which matches what
  // a user typing "0 9 * * *" intuitively means ("9am local").
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_\-./@:%=+,\\]+$/.test(s)) return s;
  // CommandLineToArgvW requires backslashes before quotes (including the
  // closing quote) to be doubled so they survive as literal backslashes.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function installedSignature(xml: string): string | undefined {
  return taskXmlSignature(xml);
}

function isMissingTaskResult(result: { stdout: string; stderr: string }): boolean {
  return /cannot find|not found/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: Array<XmlElement | string>;
}

function taskXmlSignature(xml: string): string | undefined {
  try {
    const document = parseXml(xml);
    const task = findChild(document, "Task");
    const triggers = findChild(task, "Triggers");
    const principals = findChild(task, "Principals");
    const settings = findChild(task, "Settings");
    const actions = findChild(task, "Actions");
    if (!triggers || !principals || !settings || !actions) return undefined;

    normalizeTriggerBoundaries(triggers);
    normalizeNativeDefaults(triggers, principals, settings);
    const enabledElement = findChild(settings, "Enabled");
    const enabledValue = enabledElement ? elementText(enabledElement).toLowerCase() : undefined;
    const enabled = enabledValue === undefined || enabledValue === "true" || enabledValue === "1";
    // Enabled is represented explicitly in the signature suffix. Removing it
    // here also treats an omitted Enabled element as its schema default, true.
    settings.children = settings.children.filter(
      (child) => typeof child === "string" || child.name.toLowerCase() !== "enabled",
    );

    const canonical = [triggers, principals, settings, actions].map(canonicalXmlElement).join("\n");
    const fingerprint = createHash("sha256").update(canonical).digest("hex");
    return signatureWithEnabled(`${SIGNATURE_PREFIX}${fingerprint}`, enabled);
  } catch {
    return undefined;
  }
}

function taskXmlEnabled(xml: string): boolean | undefined {
  try {
    const document = parseXml(xml);
    const settings = findChild(findChild(document, "Task"), "Settings");
    if (!settings) return undefined;
    const enabledElement = findChild(settings, "Enabled");
    if (!enabledElement) return true;
    const enabled = elementText(enabledElement).toLowerCase();
    if (enabled === "true" || enabled === "1") return true;
    if (enabled === "false" || enabled === "0") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function parseXml(xml: string): XmlElement {
  const document: XmlElement = { name: "#document", attributes: {}, children: [] };
  const stack = [document];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      if (stack.length === 1) throw new Error("Unexpected XML closing tag.");
      const closingName = localXmlName(token.slice(2, -1).trim());
      const current = stack.pop();
      if (current?.name !== closingName) throw new Error("Mismatched XML closing tag.");
      continue;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/\s*>$/.test(token);
      const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/);
      if (!match) throw new Error("Invalid XML opening tag.");
      const element: XmlElement = {
        name: localXmlName(match[1]!),
        attributes: parseXmlAttributes(match[2]!),
        children: [],
      };
      stack[stack.length - 1]!.children.push(element);
      if (!selfClosing) stack.push(element);
      continue;
    }

    const text = decodeXml(token.trim());
    if (text.length > 0) stack[stack.length - 1]!.children.push(text);
  }

  if (stack.length !== 1) throw new Error("Unclosed XML tag.");
  return document;
}

function parseXmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of raw.matchAll(pattern)) {
    const name = localXmlName(match[1]!);
    if (match[1] === "xmlns" || match[1]!.startsWith("xmlns:")) continue;
    attributes[name] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function localXmlName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function decodeXml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (entity.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return entity;
    }
  });
}

function findChild(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  return parent?.children.find(
    (child): child is XmlElement => typeof child !== "string" && child.name.toLowerCase() === name.toLowerCase(),
  );
}

function elementText(element: XmlElement): string {
  return element.children.filter((child): child is string => typeof child === "string").join("");
}

function normalizeTriggerBoundaries(triggers: XmlElement): void {
  for (const trigger of triggers.children) {
    if (typeof trigger === "string") continue;
    const boundary = findChild(trigger, "StartBoundary");
    if (!boundary) continue;
    const time = elementText(boundary).match(/T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?/);
    if (!time) continue;

    const secondsSinceMidnight = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
    const interval = findChild(findChild(trigger, "Repetition"), "Interval");
    const intervalSeconds = interval ? parseIsoDurationSeconds(elementText(interval)) : undefined;
    boundary.children = [
      intervalSeconds === undefined
        ? `dynamic-date;time=${time[1]}:${time[2]}:${time[3]}`
        : `dynamic-cycle;phase-seconds=${secondsSinceMidnight % intervalSeconds}`,
    ];
  }
}

const MATERIALIZED_SETTING_DEFAULTS: Record<string, string> = {
  allowstartondemand: "true",
  allowhardterminate: "true",
  startwhenavailable: "false",
  runonlyifnetworkavailable: "false",
  hidden: "false",
  runonlyifidle: "false",
  waketorun: "false",
  executiontimelimit: "PT72H",
  priority: "7",
  compatibility: "Vista",
  useunifiedschedulingengine: "true",
  disallowstartonremoteappsession: "false",
  volatile: "false",
};

const MATERIALIZED_IDLE_DEFAULTS: Record<string, string> = {
  duration: "PT10M",
  waittimeout: "PT1H",
  stoponidleend: "true",
  restartonidle: "false",
};

function normalizeNativeDefaults(triggers: XmlElement, principals: XmlElement, settings: XmlElement): void {
  for (const principal of elementChildren(principals)) {
    principal.children = principal.children.filter((child) => {
      if (typeof child === "string") return true;
      return child.name.toLowerCase() !== "runlevel" || elementText(child).toLowerCase() !== "leastprivilege";
    });
  }

  settings.children = settings.children.filter((child) => {
    if (typeof child === "string") return true;
    const name = child.name.toLowerCase();
    if (name === "idlesettings") return !containsOnlyDefaults(child, MATERIALIZED_IDLE_DEFAULTS);
    const defaultValue = MATERIALIZED_SETTING_DEFAULTS[name];
    return defaultValue === undefined || elementText(child) !== defaultValue;
  });

  for (const trigger of elementChildren(triggers)) {
    trigger.children = trigger.children.filter((child) => {
      if (typeof child === "string") return true;
      const name = child.name.toLowerCase();
      if (name === "enabled") return elementText(child).toLowerCase() !== "true";
      return name !== "executiontimelimit" || elementText(child) !== "PT72H";
    });
  }
}

function resolveCurrentUserSid(exec: SchtasksExec): string {
  const result = runOrThrow(exec, ["whoami", "/user", "/fo", "csv", "/nh"], {
    message: (r) => `whoami /user failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
  });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\bS-\d+(?:-\d+){2,}\b/i);
  if (!match) {
    throw new ConfigError("whoami /user returned no Windows user SID.", "INVALID_CONFIG_FILE");
  }
  return `S${match[0].slice(1)}`;
}

function elementChildren(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== "string");
}

function containsOnlyDefaults(element: XmlElement, defaults: Record<string, string>): boolean {
  const children = elementChildren(element);
  return (
    children.length > 0 &&
    children.length === element.children.length &&
    children.every((child) => defaults[child.name.toLowerCase()] === elementText(child))
  );
}

function parseIsoDurationSeconds(value: string): number | undefined {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : undefined;
}

function canonicalXmlElement(element: XmlElement): string {
  const attributes = Object.entries(element.attributes).sort(([a], [b]) => a.localeCompare(b));
  const children = element.children.map((child) =>
    typeof child === "string" ? ["text", child] : ["element", canonicalXmlElement(child)],
  );
  children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([element.name, attributes, children]);
}

function signatureWithEnabled(signature: string, enabled: boolean): string {
  return `${signature}|enabled=${enabled ? "true" : "false"}`;
}

function defaultSchtasksExec(): SchtasksExec {
  return nodeExec();
}

function defaultSchtasksFs(): SchtasksFs {
  return {
    ...nodeFs(),
    writeFile(file, content) {
      fs.writeFileSync(file, `\uFEFF${content}`, { encoding: "utf16le" });
    },
    removeFile(file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
    tmpdir() {
      return os.tmpdir();
    },
  };
}
