// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Lift native scheduler state into the host-local scheduler activation list. */

import { makeBundleRef } from "../../../src/core/asset/asset-ref";
import { type AkmConfig, loadConfig, mutateConfig, resetConfigCache } from "../../../src/core/config/config";
import { bundleComponentConfig, bundleSourceId, isBundleEnabled } from "../../../src/core/config/config-sources";
import { selectBackend } from "../../../src/tasks/backends";
import type { InstalledSchedulerBinding, SchedulerBackend } from "../../../src/tasks/scheduler-binding";
import {
  canonicalSchedulerActivationRef,
  schedulerActivations,
  type SchedulerActivation,
} from "../../../src/tasks/activation-config";

export interface SchedulerActivationMigrationPlan {
  readonly pending: readonly SchedulerActivation[];
  readonly warnings: readonly string[];
}

export interface SchedulerActivationMigrationResult {
  readonly applied: readonly SchedulerActivation[];
  readonly warnings: readonly string[];
}

function activationFromInstalled(
  entry: InstalledSchedulerBinding,
  config: AkmConfig,
): SchedulerActivation | undefined {
  if (entry.enabled !== true || !entry.invocation) return undefined;
  const invocation = entry.invocation;
  if (invocation[0] === "workflow" && invocation[1] === "run" && invocation.length === 3) {
    const ref = invocation[2];
    if (!ref) return undefined;
    try {
      const canonicalRef = canonicalSchedulerActivationRef(ref);
      const bundle = canonicalRef.slice(0, canonicalRef.indexOf("//"));
      if (!isBundleEnabled(config, bundle)) return undefined;
      return Object.freeze({
        kind: "workflow" as const,
        ref: canonicalRef,
        sourceId: bundleSourceId(config, bundle),
      });
    } catch {
      return undefined;
    }
  }
  if (invocation[0] !== "task" || invocation[1] !== "run" || !invocation[2]) return undefined;
  const bundleIndex = invocation.indexOf("--bundle", 3);
  const bundle = bundleIndex === -1 ? config.defaultBundle : invocation[bundleIndex + 1];
  if (!bundle) return undefined;
  if (!isBundleEnabled(config, bundle)) return undefined;
  const adapter = config.bundles?.[bundle] ? (bundleComponentConfig(config.bundles[bundle])?.adapter ?? "akm") : "akm";
  const conceptId = adapter === "akm-task" ? invocation[2] : `tasks/${invocation[2]}`;
  try {
    return Object.freeze({
      kind: "task" as const,
      ref: canonicalSchedulerActivationRef(makeBundleRef(bundle, conceptId)),
      sourceId: bundleSourceId(config, bundle),
    });
  } catch {
    return undefined;
  }
}

function activationKey(activation: SchedulerActivation): string {
  return `${activation.kind}\0${activation.ref}\0${activation.sourceId}`;
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
    return Object.freeze({
      pending: Object.freeze([]),
      warnings: Object.freeze([`Native scheduler activation could not be inspected: ${message}`]),
    });
  }
  if (!selected.inspectBindings) {
    return Object.freeze({
      pending: Object.freeze([]),
      warnings: Object.freeze([`Scheduler backend ${JSON.stringify(selected.name)} cannot inspect native bindings.`]),
    });
  }
  try {
    const inspection = await selected.inspectBindings({});
    const existing = new Set(schedulerActivations(config).map(activationKey));
    const pending = new Map<string, SchedulerActivation>();
    for (const entry of inspection.installed) {
      const activation = activationFromInstalled(entry, config);
      if (!activation) continue;
      const key = activationKey(activation);
      if (!existing.has(key)) pending.set(key, activation);
    }
    return Object.freeze({
      pending: Object.freeze(
        [...pending.values()].sort((left, right) => left.ref.localeCompare(right.ref) || left.kind.localeCompare(right.kind)),
      ),
      warnings: Object.freeze([]),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return Object.freeze({
      pending: Object.freeze([]),
      warnings: Object.freeze([`Native scheduler activation could not be inspected: ${message}`]),
    });
  }
}

export async function applySchedulerActivationMigration(
  backend?: SchedulerBackend,
): Promise<SchedulerActivationMigrationResult> {
  const plan = await inspectSchedulerActivationMigration(backend);
  if (plan.pending.length === 0) return Object.freeze({ applied: Object.freeze([]), warnings: plan.warnings });
  const additions = new Map(plan.pending.map((activation) => [activationKey(activation), activation]));
  mutateConfig((current) => {
    const combined = new Map(schedulerActivations(current).map((activation) => [activationKey(activation), activation]));
    for (const [key, activation] of additions) combined.set(key, activation);
    const enabled = [...combined.values()].sort(
      (left, right) => left.ref.localeCompare(right.ref) || left.kind.localeCompare(right.kind),
    );
    return { ...current, scheduler: { ...current.scheduler, enabled } };
  });
  resetConfigCache();
  return Object.freeze({ applied: plan.pending, warnings: plan.warnings });
}
