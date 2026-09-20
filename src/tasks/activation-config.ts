// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { type AkmConfig, mutateConfig } from "../core/config/config";
import { UsageError } from "../core/errors";

export type SchedulerActivationKind = "task" | "workflow";
export interface SchedulerActivation {
  readonly kind: SchedulerActivationKind;
  readonly ref: string;
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
      Object.freeze({ kind: activation.kind, ref: canonicalSchedulerActivationRef(activation.ref) }),
    ),
  );
}

export function isSchedulerRefEnabled(config: AkmConfig, kind: SchedulerActivationKind, ref: string): boolean {
  return schedulerActivations(config).some((activation) => activation.kind === kind && activation.ref === ref);
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
    const present = existing.some((activation) => activation.kind === kind && activation.ref === canonicalRef);
    if (present === enabled) return current;
    const next = enabled
      ? [...existing, { kind, ref: canonicalRef }]
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
