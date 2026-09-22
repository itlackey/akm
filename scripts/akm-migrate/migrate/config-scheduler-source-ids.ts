// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Persist source-bound scheduler grants before the runtime reads config. */

import { bundleRefToString, parseBundleRef } from "../../../src/core/asset/asset-ref";
import { deriveBundleId } from "../../../src/core/bundle-id";
import {
  acquireConfigLock,
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  writeConfigAtomic,
} from "../../../src/core/config/config-io";
import { bundleSourceId, filesystemBundleSourceId } from "../../../src/core/config/config-sources";
import type { AkmConfig } from "../../../src/core/config/config-types";

export interface SchedulerSourceIdChange {
  readonly kind: "bind" | "drop";
  readonly ref: string;
  readonly sourceId?: string;
  readonly reason?: string;
}

export interface ConfigSchedulerSourceIdPlan {
  readonly changes: readonly SchedulerSourceIdChange[];
}

export interface ConfigSchedulerSourceIdResult extends ConfigSchedulerSourceIdPlan {
  readonly applied: boolean;
}

function readRawConfig(configPath: string): Record<string, unknown> | undefined {
  const text = readConfigText(configPath);
  return text === undefined ? undefined : parseConfigText(text, configPath);
}

function activationArray(raw: Record<string, unknown>): unknown[] | undefined {
  const scheduler = raw.scheduler;
  if (!scheduler || typeof scheduler !== "object" || Array.isArray(scheduler)) return undefined;
  const enabled = (scheduler as Record<string, unknown>).enabled;
  return Array.isArray(enabled) ? enabled : undefined;
}

function migrationChanges(raw: Record<string, unknown>): SchedulerSourceIdChange[] {
  const changes: SchedulerSourceIdChange[] = [];
  for (const value of activationArray(raw) ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const activation = value as Record<string, unknown>;
    if (typeof activation.sourceId === "string") continue;
    const ref = typeof activation.ref === "string" ? activation.ref : "(invalid activation)";
    try {
      const parsed = parseBundleRef(ref);
      if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) {
        throw new Error("not a canonical fully-qualified ref");
      }
      const bundles = raw.bundles;
      if (bundles && typeof bundles === "object" && !Array.isArray(bundles) && parsed.bundle in bundles) {
        changes.push({ kind: "bind", ref, sourceId: bundleSourceId(raw as AkmConfig, parsed.bundle) });
        continue;
      }
      const implicitSourceId = implicitBundleSourceId(raw, parsed.bundle);
      if (!implicitSourceId) {
        changes.push({ kind: "drop", ref, reason: `bundle ${JSON.stringify(parsed.bundle)} is not configured` });
        continue;
      }
      changes.push({ kind: "bind", ref, sourceId: implicitSourceId });
    } catch (cause) {
      changes.push({
        kind: "drop",
        ref,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return changes;
}

function implicitBundleSourceId(raw: Record<string, unknown>, bundleId: string): string | undefined {
  const root = process.env.AKM_BUNDLE_DIR?.trim();
  if (!root) return undefined;
  const configuredIds =
    raw.bundles && typeof raw.bundles === "object" && !Array.isArray(raw.bundles)
      ? Object.keys(raw.bundles)
      : [];
  const implicitId = deriveBundleId(undefined, root, new Set(configuredIds));
  return implicitId === bundleId ? filesystemBundleSourceId(root) : undefined;
}

export function findConfigSchedulerSourceIdMigration(configPath: string): ConfigSchedulerSourceIdPlan {
  const raw = readRawConfig(configPath);
  return Object.freeze({ changes: Object.freeze(raw ? migrationChanges(raw) : []) });
}

export function applyConfigSchedulerSourceIdMigration(configPath: string): ConfigSchedulerSourceIdResult {
  const release = acquireConfigLock();
  try {
    // Read and derive under the same lock as publication. Otherwise a config
    // writer could land between the initial read and this write, and the
    // migrator would restore its stale snapshot over the newer generation.
    const raw = readRawConfig(configPath);
    if (!raw) return Object.freeze({ applied: false, changes: Object.freeze([]) });
    const changes = migrationChanges(raw);
    if (changes.length === 0) return Object.freeze({ applied: false, changes: Object.freeze([]) });

    const scheduler = raw.scheduler as Record<string, unknown>;
    const enabled = activationArray(raw) ?? [];
    const byRef = new Map(changes.map((change) => [change.ref, change]));
    const migrated = enabled.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
      const activation = value as Record<string, unknown>;
      if (typeof activation.sourceId === "string" || typeof activation.ref !== "string") return [activation];
      const change = byRef.get(activation.ref);
      if (!change || change.kind === "drop") return [];
      return [{ ...activation, sourceId: change.sourceId }];
    });
    const next = { ...raw, scheduler: { ...scheduler, enabled: migrated } };
    backupExistingConfig(configPath);
    writeConfigAtomic(configPath, next);
    return Object.freeze({ applied: true, changes: Object.freeze(changes) });
  } finally {
    release();
  }
}
