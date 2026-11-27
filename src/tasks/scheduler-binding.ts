// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret-free input to every native scheduler backend, and the backend
 * contract itself.
 *
 * A binding carries only stable source identity, trigger identity, and the
 * public CLI tail; its install options add the launcher and the AKM
 * directory environment the row sets inline. Source content, action inputs,
 * task environment values, and credentials never cross this boundary or
 * reach an OS scheduler.
 */

import { createHash } from "node:crypto";
import { stashDirFor } from "../core/asset/asset-placement";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import { canonicalInputJson, type InputFlag } from "../execution/input-contract";
import type { ScheduleBackend } from "./schedule";
import { type ScheduledRowEnvironment, scheduledTaskSubject } from "./scheduler-invocation";
import { normaliseTaskConceptId } from "./task-id";

export type SchedulerLogicalSource = Readonly<{
  kind: "task" | "workflow";
  ref: string;
}>;

export interface SchedulerBinding {
  /** Stable logical binding identity. Ordinal zero keeps the flat task ABI. */
  readonly id: string;
  /** Exact portable OS artifact spelling; defaults to {@link schedulerNativeBindingId}. */
  readonly nativeId?: string;
  readonly logicalSource: SchedulerLogicalSource;
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
  readonly enabled: boolean;
  /** Public CLI tail, excluding the resolved launcher and the row's inline environment. */
  readonly invocation: readonly string[];
}

export interface SchedulerSourceSchedule {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
  /** A v4 `schedule[i].inputs` literal override, compiled into a `--<name> <value>` tail after `--scheduled`. */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** A v5 entry's `env:` refs, `secret:` specs and `timeout:`, compiled into `--env`, `--secret` and `--timeout` after the inputs. */
  readonly start?: SchedulerStartFlags;
}

/** The start flags a schedule entry carries in its tail. Values only an env asset's ref, a secret spec or a duration: nothing secret. */
export interface SchedulerStartFlags {
  readonly env?: readonly string[];
  readonly secret?: readonly string[];
  readonly timeout?: string | number;
}

export interface CompileTaskSchedulerBindingsInput {
  readonly id: string;
  readonly qualifiedRef: string;
  readonly schedules: readonly SchedulerSourceSchedule[];
}

/** One akm-owned row as a backend reads it back from the native scheduler. */
export interface InstalledSchedulerBinding {
  readonly id: string;
  /** Native artifact spelling; defaults to {@link schedulerNativeBindingId}. */
  readonly nativeId?: string;
  /** Whether the native scheduler will fire it; absent when the backend cannot tell. */
  readonly enabled?: boolean;
  /** Launcher argv installed in the row (everything before the public tail). */
  readonly binding: readonly string[];
  /** The environment the row sets inline. Absent when it sets none. */
  readonly environment?: ScheduledRowEnvironment;
  /** A row written by 0.9.0 – 0.9.17-alpha.6: the `--scheduler-context` descriptor it names. */
  readonly contextPath?: string;
  /** Normalized rendering of the installed row, compared against `expectedSignature` to detect drift. */
  readonly signature?: string;
  /** Bundle named by the row's own invocation (`--bundle <x>`, or a workflow ref's bundle). */
  readonly target?: string;
  /** Parsed public CLI tail. */
  readonly invocation?: readonly string[];
  /**
   * The `AKM_BUNDLE_DIR` the row names (#846): its inline one, or the one
   * in the descriptor an older row references. Filled in by the command
   * layer; absent when the row names none, or its descriptor cannot be read.
   */
  readonly ownerBundlePath?: string;
}

export interface SchedulerInstallOptions {
  /** Launcher argv to install; the backend's own resolved launcher when absent. */
  readonly binding?: readonly string[];
  /** The environment the row sets inline; none when absent. */
  readonly environment?: ScheduledRowEnvironment;
}

/**
 * The native scheduler contract: idempotent per-row upsert and removal plus
 * one read of every akm-owned row. Rows a person added by hand are never
 * listed and never touched.
 */
export interface SchedulerBackend {
  readonly name: ScheduleBackend;
  /** Install or replace the row for `binding`. */
  install(binding: SchedulerBinding, opts?: SchedulerInstallOptions): Promise<void> | void;
  /** Remove the row; a row that is already gone is not an error. */
  uninstall(nativeId: string): Promise<void> | void;
  setEnabled(nativeId: string, enabled: boolean): Promise<void> | void;
  list(): Promise<InstalledSchedulerBinding[]> | InstalledSchedulerBinding[];
  /** What `install` would render for `binding`, so sync can diff without writing. */
  expectedSignature?(binding: SchedulerBinding, opts?: SchedulerInstallOptions): string;
}

/**
 * The one row of a host in dispatch mode (`akm doctor scheduler sync --dispatch`): `akm task dispatch` every minute,
 * which starts each enabled task that is due. A task whose id is `dispatch` has the same native id: switching mode
 * removes the one row before it writes the other.
 */
export const DISPATCH_BINDING: SchedulerBinding = freezeBinding({
  id: "dispatch",
  nativeId: "dispatch",
  logicalSource: { kind: "task", ref: "dispatch" },
  cron: "*/1 * * * *",
  source: "akm task dispatch",
  ordinal: 0,
  enabled: true,
  invocation: ["task", "dispatch"],
});

/** Whether an installed row is the dispatch row. */
export function isDispatchRow(row: InstalledSchedulerBinding): boolean {
  return row.invocation?.length === 2 && row.invocation[0] === "task" && row.invocation[1] === "dispatch";
}

export function compileTaskSchedulerBindings(input: CompileTaskSchedulerBindingsInput): readonly SchedulerBinding[] {
  const id = normaliseTaskConceptId(input.id);
  const ref = assertQualifiedRef(input.qualifiedRef, "task");
  return Object.freeze(
    input.schedules.map((schedule) => {
      const bindingId = schedule.ordinal === 0 ? id : digestBindingId("task", ref, schedule.ordinal);
      return freezeBinding({
        id: bindingId,
        nativeId: schedulerNativeBindingId(bindingId),
        logicalSource: { kind: "task", ref },
        cron: schedule.cron,
        source: schedule.source,
        ordinal: schedule.ordinal,
        enabled: true,
        invocation: [
          "run",
          ref,
          "--scheduled",
          ...schedulerInputFlagTail(schedule.inputs),
          ...schedulerStartFlagTail(schedule.start),
        ],
      });
    }),
  );
}

/**
 * The canonically-sorted input flags of one schedule entry's `inputs`, each value as the text the tail carries. The
 * check of a schedule entry reads these same flags, so it checks what the scheduled start is given.
 */
export function schedulerInputFlags(inputs: Readonly<Record<string, unknown>> | undefined): InputFlag[] {
  if (!inputs) return [];
  return Object.keys(inputs)
    .sort()
    .map((name) => ({ name, value: schedulerInputFlagValueText(inputs[name]) }));
}

/**
 * The `--<name> <value>` flag tail for one schedule entry's `inputs`. A value whose text starts with `-` uses the
 * inline `--<name>=<value>` form, the only spelling `parseTaskInputFlags` cannot mistake for a flag.
 */
function schedulerInputFlagTail(inputs: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const tail: string[] = [];
  for (const { name, value } of schedulerInputFlags(inputs)) {
    const text = value as string;
    if (text.startsWith("-")) tail.push(`--${name}=${text}`);
    else tail.push(`--${name}`, text);
  }
  return tail;
}

/** `--env`, `--secret` and `--timeout`, in the order the entry wrote them: a later env ref wins over an earlier one. */
function schedulerStartFlagTail(start: SchedulerStartFlags | undefined): readonly string[] {
  if (!start) return [];
  return [
    ...(start.env ?? []).flatMap((ref) => ["--env", ref]),
    ...(start.secret ?? []).flatMap((spec) => ["--secret", spec]),
    ...(start.timeout !== undefined ? ["--timeout", String(start.timeout)] : []),
  ];
}

function schedulerInputFlagValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalInputJson(value);
}

/**
 * Map a logical binding id to the flat portable token persisted by native
 * schedulers. Flat ids are byte-for-byte stable; only nested standalone
 * component ids need an encoded native spelling.
 */
export function schedulerNativeBindingId(id: string): string {
  if (!id.includes("/")) return id;
  const digest = createHash("sha256")
    .update(JSON.stringify(["nested-task", id]))
    .digest("hex")
    .slice(0, 32);
  return `task-${digest}`;
}

export function schedulerBindingNativeId(binding: SchedulerBinding): string {
  return binding.nativeId ?? schedulerNativeBindingId(binding.id);
}

/**
 * Recover the logical id of an installed row from its native spelling and
 * public invocation: an ordinal-zero task row is its task id (possibly a
 * nested one behind a digest spelling); every other row is its native id.
 */
export function schedulerLogicalBindingId(nativeId: string, invocation: readonly string[]): string {
  const subject = scheduledTaskSubject(invocation)?.subject;
  if (subject === undefined) return nativeId;
  // A row names its task by ref (`<bundle>//<concept id>`); a row written before 0.11 by its id.
  const conceptId = subject.includes("//") ? parseBundleRef(subject).conceptId : subject;
  const folder = stashDirFor("task");
  const candidates =
    folder !== undefined && conceptId.startsWith(`${folder}/`)
      ? [conceptId, conceptId.slice(folder.length + 1)]
      : [conceptId];
  return candidates.find((candidate) => schedulerNativeBindingId(candidate) === nativeId) ?? nativeId;
}

function digestBindingId(kind: "task" | "workflow", ref: string, ordinal: number): string {
  const prefix = kind === "workflow" ? "wf" : "task";
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, ref, ordinal]))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function assertQualifiedRef(value: string, kind: "task" | "workflow"): string {
  const parsed = parseBundleRef(value);
  if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== value) {
    throw new UsageError(`${kind} scheduler bindings require one canonical fully-qualified ref.`, "INVALID_FLAG_VALUE");
  }
  return value;
}

function freezeBinding(binding: SchedulerBinding): SchedulerBinding {
  return Object.freeze({
    ...binding,
    logicalSource: Object.freeze({ ...binding.logicalSource }),
    invocation: Object.freeze([...binding.invocation]),
  });
}
