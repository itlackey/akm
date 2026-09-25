// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Thin importer: lift native scheduler state into the host-local scheduler
 * activation list. The grant carry-forward logic itself
 * (`pendingGrantsFromInstalled`/`carryForwardSchedulerGrants`) lives in
 * `src/tasks/scheduler-grant-carry-forward.ts`, shared with `akm task sync`.
 */

import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { selectBackend } from "../../../src/tasks/backends";
import {
  carryForwardSchedulerGrants,
  pendingGrantsFromInstalled,
  type SchedulerGrantCarryForwardResult,
  staleGrantsFromInstalled,
} from "../../../src/tasks/scheduler-grant-carry-forward";
import type { SchedulerActivation } from "../../../src/tasks/activation-config";
import type { SchedulerBackend, SchedulerBackendInspection } from "../../../src/tasks/scheduler-binding";

function staleGrantWarning(ref: string, grantedSourceId: string, currentSourceId: string): string {
  return (
    `Scheduler activation ${JSON.stringify(ref)} is granted to source ${JSON.stringify(grantedSourceId)} ` +
    `but currently resolves to ${JSON.stringify(currentSourceId)}; not carried forward. ` +
    `Run \`akm migrate apply\` (its configSchedulerSourceIds step) to rebind it explicitly.`
  );
}

export interface SchedulerActivationMigrationPlan {
  readonly pending: readonly SchedulerActivation[];
  readonly warnings: readonly string[];
}

export type SchedulerActivationMigrationResult = SchedulerGrantCarryForwardResult;

/**
 * Select the native scheduler backend and inspect its installed bindings,
 * shared by both `inspectSchedulerActivationMigration` and
 * `applySchedulerActivationMigration` so the select/inspect/error-handling
 * logic exists in exactly one place.
 */
async function inspectNativeBindings(
  backend: SchedulerBackend | undefined,
): Promise<{ inspection: SchedulerBackendInspection } | { warning: string }> {
  let selected: SchedulerBackend;
  try {
    selected = backend ?? selectBackend();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { warning: `Native scheduler activation could not be inspected: ${message}` };
  }
  if (!selected.inspectBindings) {
    return { warning: `Scheduler backend ${JSON.stringify(selected.name)} cannot inspect native bindings.` };
  }
  try {
    return { inspection: await selected.inspectBindings({}) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { warning: `Native scheduler activation could not be inspected: ${message}` };
  }
}

export async function inspectSchedulerActivationMigration(
  backend?: SchedulerBackend,
): Promise<SchedulerActivationMigrationPlan> {
  resetConfigCache();
  const config = loadConfig();
  const result = await inspectNativeBindings(backend);
  if ("warning" in result) return Object.freeze({ pending: Object.freeze([]), warnings: Object.freeze([result.warning]) });
  const stale = staleGrantsFromInstalled(result.inspection.installed, config);
  return Object.freeze({
    pending: pendingGrantsFromInstalled(result.inspection.installed, config),
    warnings: Object.freeze(
      stale.map((grant) => staleGrantWarning(grant.ref, grant.grantedSourceId, grant.currentSourceId)),
    ),
  });
}

export async function applySchedulerActivationMigration(
  backend?: SchedulerBackend,
): Promise<SchedulerActivationMigrationResult> {
  const result = await inspectNativeBindings(backend);
  if ("warning" in result) return { applied: Object.freeze([]), warnings: Object.freeze([result.warning]), staleGrants: Object.freeze([]) };
  const migrationResult = await carryForwardSchedulerGrants(result.inspection);
  return {
    ...migrationResult,
    warnings: Object.freeze([
      ...migrationResult.warnings,
      ...migrationResult.staleGrants.map((grant) =>
        staleGrantWarning(grant.ref, grant.grantedSourceId, grant.currentSourceId),
      ),
    ]),
  };
}
