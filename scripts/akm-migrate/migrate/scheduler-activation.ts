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
} from "../../../src/tasks/scheduler-grant-carry-forward";
import type { SchedulerActivation } from "../../../src/tasks/activation-config";
import type { SchedulerBackend } from "../../../src/tasks/scheduler-binding";

export interface SchedulerActivationMigrationPlan {
  readonly pending: readonly SchedulerActivation[];
  readonly warnings: readonly string[];
}

export type SchedulerActivationMigrationResult = SchedulerGrantCarryForwardResult;

function unavailablePlan(selected: string | undefined, message?: string): SchedulerActivationMigrationPlan {
  return Object.freeze({
    pending: Object.freeze([]),
    warnings: Object.freeze([
      message ?? `Scheduler backend ${JSON.stringify(selected)} cannot inspect native bindings.`,
    ]),
  });
}

export async function inspectSchedulerActivationMigration(
  backend?: SchedulerBackend,
): Promise<SchedulerActivationMigrationPlan> {
  resetConfigCache();
  const config = loadConfig();
  let selected: SchedulerBackend;
  try {
    selected = backend ?? selectBackend();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unavailablePlan(undefined, `Native scheduler activation could not be inspected: ${message}`);
  }
  if (!selected.inspectBindings) return unavailablePlan(selected.name);
  try {
    const inspection = await selected.inspectBindings({});
    return Object.freeze({
      pending: pendingGrantsFromInstalled(inspection.installed, config),
      warnings: Object.freeze([]),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unavailablePlan(undefined, `Native scheduler activation could not be inspected: ${message}`);
  }
}

export async function applySchedulerActivationMigration(
  backend?: SchedulerBackend,
): Promise<SchedulerActivationMigrationResult> {
  let selected: SchedulerBackend;
  try {
    selected = backend ?? selectBackend();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { applied: Object.freeze([]), warnings: Object.freeze([`Native scheduler activation could not be inspected: ${message}`]) };
  }
  if (!selected.inspectBindings) {
    return {
      applied: Object.freeze([]),
      warnings: Object.freeze([`Scheduler backend ${JSON.stringify(selected.name)} cannot inspect native bindings.`]),
    };
  }
  try {
    const inspection = await selected.inspectBindings({});
    return await carryForwardSchedulerGrants(inspection);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { applied: Object.freeze([]), warnings: Object.freeze([`Native scheduler activation could not be inspected: ${message}`]) };
  }
}
