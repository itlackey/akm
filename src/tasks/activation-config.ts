// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { deriveBundleId } from "../core/bundle-id";
import { resolveStashDir } from "../core/common";
import { type AkmConfig, mutateConfig } from "../core/config/config";
import { bundleSourceId, filesystemBundleSourceId, isBundleEnabled } from "../core/config/config-sources";
import { UsageError } from "../core/errors";

export type SchedulerActivationKind = "task" | "workflow";
export interface SchedulerActivation {
  readonly kind: SchedulerActivationKind;
  readonly ref: string;
  readonly sourceId: string;
  readonly [key: string]: unknown;
}

export function canonicalSchedulerActivationRef(ref: string): string {
  const parsed = parseBundleRef(ref);
  if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) {
    throw new UsageError(
      `Scheduler activation requires a canonical fully-qualified ref, got ${JSON.stringify(ref)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return ref;
}

export function schedulerActivations(config: AkmConfig): readonly SchedulerActivation[] {
  return Object.freeze(
    (config.scheduler?.enabled ?? []).map((activation) =>
      Object.freeze({
        kind: activation.kind,
        ref: canonicalSchedulerActivationRef(activation.ref),
        sourceId: activation.sourceId,
      }),
    ),
  );
}

export function isSchedulerRefEnabled(config: AkmConfig, kind: SchedulerActivationKind, ref: string): boolean {
  const canonicalRef = canonicalSchedulerActivationRef(ref);
  const bundle = parseBundleRef(canonicalRef).bundle!;
  const currentSourceId = schedulerActivationSourceId(config, bundle);
  if (!currentSourceId) return false;
  return schedulerActivations(config).some(
    (activation) =>
      activation.kind === kind && activation.ref === canonicalRef && activation.sourceId === currentSourceId,
  );
}

/** Grants that still name the same active source installation they approved. */
export function activeSchedulerActivations(config: AkmConfig): readonly SchedulerActivation[] {
  return schedulerActivations(config).filter((activation) => {
    const bundle = parseBundleRef(activation.ref).bundle!;
    return activation.sourceId === schedulerActivationSourceId(config, bundle);
  });
}

/** Pure lifecycle helper used when a bundle is removed or replaced. */
export function revokeSchedulerActivationsForBundle(config: AkmConfig, bundleId: string): AkmConfig {
  const enabled = schedulerActivations(config).filter(
    (activation) => parseBundleRef(activation.ref).bundle !== bundleId,
  );
  if (enabled.length === (config.scheduler?.enabled ?? []).length) return config;
  return { ...config, scheduler: { ...config.scheduler, enabled } };
}

export function setSchedulerRefEnabled(
  kind: SchedulerActivationKind,
  ref: string,
  enabled: boolean,
): { config: AkmConfig; changed: boolean; ref: string } {
  let canonicalRef = ref;
  const result = mutateConfig((current) => {
    canonicalRef = canonicalSchedulerActivationRef(ref);
    const existing = schedulerActivations(current);
    const bundle = parseBundleRef(canonicalRef).bundle!;
    const sourceId = enabled ? schedulerActivationSourceId(current, bundle) : undefined;
    if (enabled && !sourceId) {
      throw new UsageError(
        `Cannot enable scheduled execution from inactive or unconfigured bundle ${JSON.stringify(bundle)}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const present = existing.some(
      (activation) =>
        activation.kind === kind && activation.ref === canonicalRef && (!enabled || activation.sourceId === sourceId),
    );
    if (present === enabled) return current;
    const next = enabled
      ? [
          ...existing.filter((activation) => activation.kind !== kind || activation.ref !== canonicalRef),
          { kind, ref: canonicalRef, sourceId: sourceId! },
        ]
      : existing.filter((activation) => activation.kind !== kind || activation.ref !== canonicalRef);
    next.sort((left, right) => left.ref.localeCompare(right.ref) || left.kind.localeCompare(right.kind));
    return {
      ...current,
      scheduler: {
        ...current.scheduler,
        enabled: next,
      },
    };
  });
  return { config: result.config, changed: result.written, ref: canonicalRef };
}

/** Current active source identity for a configured or environment-only bundle. */
export function schedulerActivationSourceId(config: AkmConfig, bundleId: string): string | undefined {
  if (isBundleEnabled(config, bundleId)) return bundleSourceId(config, bundleId);
  if (config.bundles?.[bundleId] !== undefined || !process.env.AKM_BUNDLE_DIR?.trim()) return undefined;
  try {
    const root = resolveStashDir();
    const implicitId = deriveBundleId(undefined, root, new Set(Object.keys(config.bundles ?? {})));
    return implicitId === bundleId ? filesystemBundleSourceId(root) : undefined;
  } catch {
    return undefined;
  }
}
