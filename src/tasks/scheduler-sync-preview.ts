// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared, non-mutating rendering of a scheduler reconcile plan into a
 * preview shape suitable for `--dry-run` output (id / kind / native
 * artifact / owning-bundle-of-removal). Deliberately factored out of
 * `akm task sync`'s CLI leaf (#849) so `akm task prune` (#851) — whose
 * whole point is previewing removals of scheduler entries `sync` itself
 * can't attribute — can reuse the exact same table shape and zero-write
 * guarantee instead of re-deriving it.
 *
 * This module only ever reads a {@link SchedulerSyncOperation} array and
 * returns a frozen plain object; it never touches a scheduler backend.
 */
import type { SchedulerSourceFailure, SchedulerSyncOperation, SchedulerSyncPlan } from "./scheduler-sync";

export interface SchedulerPlanPreviewOperation {
  readonly id: string;
  readonly kind: "install" | "update" | "remove";
  /** Native scheduler artifact id (crontab line/marker, plist label, schtasks task name). Removals only. */
  readonly nativeId?: string;
  /** Resolved bundle path the installed binding was attributed to (#846). Removals only, when known. */
  readonly ownerBundlePath?: string;
  /** Why `akm task prune` (#851) selected this entry. Absent for `sync`'s own removals. */
  readonly reason?: "invalid-context" | "dead-bundle-path";
  /** Exact native definition currently installed. Updates only. */
  readonly installedFingerprint?: string;
  /** Exact native definition the update would install. Updates only. */
  readonly expectedFingerprint?: string;
}

export interface SchedulerPlanPreview {
  readonly backend: string;
  readonly dryRun: true;
  readonly adds: readonly SchedulerPlanPreviewOperation[];
  readonly updates: readonly SchedulerPlanPreviewOperation[];
  readonly removes: readonly SchedulerPlanPreviewOperation[];
  readonly unchanged: readonly string[];
  /** Drives dry-run's non-zero exit: true whenever the plan would remove any scheduler binding. */
  readonly hasRemovals: boolean;
  /** Sources that failed to parse/prepare (#867) — excluded from the plan, reported here instead of poisoning it. */
  readonly failures: readonly SchedulerSourceFailure[];
  /** Refs a real sync would grant from an installed, ungranted native scheduler binding. Present only when non-empty. */
  readonly carriedForward?: readonly string[];
}

/**
 * Project a set of scheduler sync operations into a preview report. Pure:
 * no I/O, no backend calls. Accepts a bare operation array (not the whole
 * `SchedulerSyncPlan`) so a future `task prune` can build a preview from
 * its own remove-only operation set without needing a full sync plan.
 */
export function renderSchedulerPlanPreview(
  backend: string,
  operations: readonly SchedulerSyncOperation[],
  unchanged: readonly string[] = [],
  failures: readonly SchedulerSourceFailure[] = [],
  carriedForward: readonly string[] = [],
): SchedulerPlanPreview {
  const adds: SchedulerPlanPreviewOperation[] = [];
  const updates: SchedulerPlanPreviewOperation[] = [];
  const removes: SchedulerPlanPreviewOperation[] = [];
  for (const operation of operations) {
    if (operation.kind === "remove") {
      removes.push({
        id: operation.id,
        kind: "remove",
        nativeId: operation.nativeId,
        ...(operation.ownerBundlePath !== undefined ? { ownerBundlePath: operation.ownerBundlePath } : {}),
        ...(operation.reason !== undefined ? { reason: operation.reason } : {}),
      });
    } else if (operation.kind === "install") {
      adds.push({ id: operation.binding.id, kind: "install" });
    } else {
      updates.push({
        id: operation.binding.id,
        kind: "update",
        ...(operation.expected.fingerprint !== undefined
          ? { installedFingerprint: operation.expected.fingerprint }
          : {}),
        ...(operation.resultFingerprint !== undefined ? { expectedFingerprint: operation.resultFingerprint } : {}),
      });
    }
  }
  return Object.freeze({
    backend,
    dryRun: true,
    adds: Object.freeze(adds),
    updates: Object.freeze(updates),
    removes: Object.freeze(removes),
    unchanged: Object.freeze([...unchanged]),
    hasRemovals: removes.length > 0,
    failures: Object.freeze([...failures]),
    ...(carriedForward.length > 0 ? { carriedForward: Object.freeze([...carriedForward]) } : {}),
  });
}

/** Convenience wrapper for the common case: previewing a whole {@link SchedulerSyncPlan}. */
export function renderSchedulerSyncPlanPreview(backend: string, plan: SchedulerSyncPlan): SchedulerPlanPreview {
  return renderSchedulerPlanPreview(backend, plan.operations, plan.unchanged, plan.failures, plan.carriedForward);
}
