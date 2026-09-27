// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret-free input to every native scheduler backend, and the backend
 * contract itself.
 *
 * A binding carries only stable source identity, trigger identity, and the
 * public CLI tail. Source content, action inputs, environment values, and
 * credentials never cross this boundary or reach an OS scheduler.
 */

import { createHash } from "node:crypto";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import { canonicalInputJson } from "../execution/input-contract";
import type { ScheduleBackend } from "./schedule";
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
  /** Public CLI tail, excluding the resolved launcher and context descriptor. */
  readonly invocation: readonly string[];
}

export interface SchedulerSourceSchedule {
  readonly cron: string;
  readonly source: string;
  readonly ordinal: number;
  /** A v4 `schedule[i].inputs` literal override, compiled into a `--<name> <value>` tail after `--scheduled`. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export interface CompileTaskSchedulerBindingsInput {
  readonly id: string;
  readonly qualifiedRef: string;
  readonly schedules: readonly SchedulerSourceSchedule[];
}

export interface CompileWorkflowSchedulerBindingsInput {
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
  /** Launcher argv installed in the row (everything before `--scheduler-context`). */
  readonly binding: readonly string[];
  /** Descriptor path the row references; `""` for a row written before descriptors existed. */
  readonly contextPath: string;
  /** Normalized rendering of the installed row, compared against `expectedSignature` to detect drift. */
  readonly signature?: string;
  /** Bundle named by the row's own invocation (`--bundle <x>`, or a workflow ref's bundle). */
  readonly target?: string;
  /** Parsed public CLI tail. */
  readonly invocation?: readonly string[];
  /**
   * Resolved `AKM_BUNDLE_DIR` recovered from the row's scheduler-context
   * descriptor (#846). Filled in by the command layer; absent whenever the
   * descriptor is missing or unreadable, which never means "mine".
   */
  readonly ownerBundlePath?: string;
}

export interface SchedulerInstallOptions {
  /** Launcher argv to install; the backend's own resolved launcher when absent. */
  readonly binding?: readonly string[];
  /** Descriptor path to reference; the backend's own current descriptor when absent. */
  readonly contextPath?: string;
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

export function compileTaskSchedulerBindings(input: CompileTaskSchedulerBindingsInput): readonly SchedulerBinding[] {
  const id = normaliseTaskConceptId(input.id);
  const ref = assertQualifiedRef(input.qualifiedRef, "task");
  const bundle = parseBundleRef(ref).bundle;
  if (!bundle) throw new Error("invariant: qualified scheduler task ref lost its bundle");
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
        invocation: ["task", "run", id, "--bundle", bundle, "--scheduled", ...schedulerInputFlagTail(schedule.inputs)],
      });
    }),
  );
}

/**
 * The canonically-sorted `--<name> <value>` flag tail for one schedule
 * entry's `inputs`. A value whose text starts with `-` uses the inline
 * `--<name>=<value>` form, the only spelling `parseTaskInputFlags` cannot
 * mistake for a flag.
 */
function schedulerInputFlagTail(inputs: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (!inputs) return [];
  const tail: string[] = [];
  for (const name of Object.keys(inputs).sort()) {
    const text = schedulerInputFlagValueText(inputs[name]);
    if (text.startsWith("-")) tail.push(`--${name}=${text}`);
    else tail.push(`--${name}`, text);
  }
  return tail;
}

function schedulerInputFlagValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalInputJson(value);
}

export function compileWorkflowSchedulerBindings(
  input: CompileWorkflowSchedulerBindingsInput,
): readonly SchedulerBinding[] {
  const ref = assertQualifiedRef(input.qualifiedRef, "workflow");
  return Object.freeze(
    input.schedules.map((schedule) => {
      const bindingId = digestBindingId("workflow", ref, schedule.ordinal);
      return freezeBinding({
        id: bindingId,
        nativeId: bindingId,
        logicalSource: { kind: "workflow", ref },
        cron: schedule.cron,
        source: schedule.source,
        ordinal: schedule.ordinal,
        enabled: true,
        invocation: ["workflow", "run", ref],
      });
    }),
  );
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
  const taskId = invocation[0] === "task" && invocation[1] === "run" ? invocation[2] : undefined;
  return taskId !== undefined && schedulerNativeBindingId(taskId) === nativeId ? taskId : nativeId;
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
