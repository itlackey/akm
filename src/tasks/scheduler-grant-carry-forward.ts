// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Carry forward host-local scheduler grants from installed native scheduler
 * bindings. A row `akm task sync` wrote to this host's crontab/launchd/
 * schtasks is the operator's own prior act; recognizing it as a grant
 * invents no new authority. Shared by `akm task sync` (which must carry a
 * row forward before it would otherwise remove it as ungranted) and
 * host-local migration (`akm-migrate apply --host-local`, via
 * `scripts/akm-migrate/migrate/scheduler-activation.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../core/asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { typeNameFromConceptId } from "../core/asset/resolve-ref";
import { type AkmConfig, loadConfig, mutateConfig, resetConfigCache } from "../core/config/config";
import {
  bundleComponentConfig,
  bundleContentRoots,
  bundleSourceId,
  isBundleEnabled,
} from "../core/config/config-sources";
import {
  canonicalSchedulerActivationRef,
  type SchedulerActivation,
  type SchedulerActivationKind,
  schedulerActivations,
} from "./activation-config";
import { selectBackend } from "./backends";
import type { InstalledSchedulerBinding, SchedulerBackendInspection } from "./scheduler-binding";

export interface SchedulerGrantCarryForwardResult {
  readonly applied: readonly SchedulerActivation[];
  readonly warnings: readonly string[];
  readonly staleGrants: readonly StaleSchedulerGrant[];
}

/**
 * An installed native scheduler row whose ref already has a host-local grant,
 * but bound to a different `sourceId` than the ref currently resolves to (the
 * bundle was removed and re-added under the same name from a different
 * origin). `sourceId` exists to stop exactly this kind of silent rebind, so
 * carry-forward reports it instead of granting the new origin.
 */
export interface StaleSchedulerGrant {
  readonly kind: SchedulerActivationKind;
  readonly ref: string;
  readonly grantedSourceId: string;
  readonly currentSourceId: string;
}

/**
 * Human-readable warning for a {@link StaleSchedulerGrant}, naming the
 * command that rebinds it explicitly. Shared by `akm-migrate` (host-local
 * reconciliation) and `akm task sync` so the wording never drifts between
 * the two callers that can observe the same stale grant.
 */
export function staleSchedulerGrantWarning(grant: StaleSchedulerGrant): string {
  const rebind =
    grant.kind === "task"
      ? `Run \`akm task enable ${grant.ref}\` to rebind it explicitly.`
      : "It must be re-created explicitly; no command currently rebinds a stale workflow grant.";
  return (
    `Scheduler activation ${JSON.stringify(grant.ref)} is granted to source ${JSON.stringify(grant.grantedSourceId)} ` +
    `but currently resolves to ${JSON.stringify(grant.currentSourceId)}; not carried forward. ${rebind}`
  );
}

/**
 * Whether `bundle`'s resolved content root has an on-disk file backing
 * `conceptId`. A conceptId with no registered placement stashDir (an
 * adapter-projected task, e.g. `adapter: "akm-task"`) or a bundle this
 * process cannot resolve to a filesystem content root (a `git`/`website`/
 * `npm` bundle, materialized elsewhere) is treated as backed: this function
 * has no way to check it without I/O beyond what "pure" here allows, and
 * carry-forward for those cases defers to the caller's own removal path
 * (`akm task sync`'s desired/removed computation), which already resolves
 * such sources fully.
 */
function hasBackingFile(config: AkmConfig, bundle: string, conceptId: string): boolean {
  const parts = typeNameFromConceptId(conceptId);
  if (!parts) return true;
  const typeDir = stashDirFor(parts.type);
  if (!typeDir) return true;
  const contentRoot = bundleContentRoots(config).find((entry) => entry.id === bundle)?.contentRoot;
  if (!contentRoot) return true;
  try {
    const target = assetPathForName(parts.type, path.join(contentRoot, typeDir), parts.name);
    return fs.existsSync(target) && fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function activationFromInstalledEntry(
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
      const parsed = parseBundleRef(canonicalRef);
      const bundle = parsed.bundle;
      if (!bundle || !isBundleEnabled(config, bundle)) return undefined;
      if (!hasBackingFile(config, bundle, parsed.conceptId)) return undefined;
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
  if (!hasBackingFile(config, bundle, conceptId)) return undefined;
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

// Matches the config schema's own uniqueness key for `scheduler.enabled`
// (`config-schema.ts`): a valid config never has two grants for the same
// kind+ref, regardless of sourceId, so this is the only key that can find an
// "existing" grant for an installed row.
function activationKey(activation: SchedulerActivation): string {
  return `${activation.kind}\0${activation.ref}`;
}

/**
 * Classify installed native scheduler bindings against existing host-local
 * grants. Pure: no config mutation, no scheduler backend call — the only I/O
 * is confirming that a candidate still has a backing asset file on disk (see
 * {@link hasBackingFile}). A ref with no existing grant is `pending`. A ref
 * with an existing grant bound to a different `sourceId` is `stale`, never
 * `pending` — carrying it forward would silently rebind authority to a new
 * origin. `akm task enable <ref>` rebinds a stale task grant explicitly; a
 * stale workflow grant has no such command and must be re-created explicitly.
 */
function classifyInstalled(
  installed: readonly InstalledSchedulerBinding[],
  config: AkmConfig,
): { readonly pending: readonly SchedulerActivation[]; readonly stale: readonly StaleSchedulerGrant[] } {
  const existingByKey = new Map(
    schedulerActivations(config).map((activation) => [activationKey(activation), activation]),
  );
  const pending = new Map<string, SchedulerActivation>();
  const stale = new Map<string, StaleSchedulerGrant>();
  for (const entry of installed) {
    const activation = activationFromInstalledEntry(entry, config);
    if (!activation) continue;
    const key = activationKey(activation);
    const existing = existingByKey.get(key);
    if (!existing) {
      pending.set(key, activation);
    } else if (existing.sourceId !== activation.sourceId) {
      stale.set(key, {
        kind: activation.kind,
        ref: activation.ref,
        grantedSourceId: existing.sourceId,
        currentSourceId: activation.sourceId,
      });
    }
  }
  return {
    pending: Object.freeze(
      [...pending.values()].sort(
        (left, right) => left.ref.localeCompare(right.ref) || left.kind.localeCompare(right.kind),
      ),
    ),
    stale: Object.freeze([...stale.values()].sort((left, right) => left.ref.localeCompare(right.ref))),
  };
}

/**
 * Which installed native scheduler bindings are eligible to become
 * host-local scheduler grants that do not already exist. See
 * {@link classifyInstalled} for what excludes a candidate; a ref whose
 * existing grant is stale (bound to a different `sourceId`) is excluded
 * here, not reported — use {@link staleGrantsFromInstalled} for that.
 */
export function pendingGrantsFromInstalled(
  installed: readonly InstalledSchedulerBinding[],
  config: AkmConfig,
): readonly SchedulerActivation[] {
  return classifyInstalled(installed, config).pending;
}

/**
 * Installed native scheduler rows whose ref already has a grant bound to a
 * different `sourceId`. See {@link classifyInstalled}.
 */
export function staleGrantsFromInstalled(
  installed: readonly InstalledSchedulerBinding[],
  config: AkmConfig,
): readonly StaleSchedulerGrant[] {
  return classifyInstalled(installed, config).stale;
}

/**
 * Apply {@link pendingGrantsFromInstalled} to config. `backendInspection`
 * lets a caller that already inspected the scheduler backend (`akm task
 * sync`'s own `inspectBindings` call) reuse that read instead of triggering
 * a second one; omitting it inspects the platform backend directly (the
 * migrator's path, which has no inspection of its own).
 */
export async function carryForwardSchedulerGrants(
  backendInspection?: SchedulerBackendInspection,
): Promise<SchedulerGrantCarryForwardResult> {
  const config = loadConfig();
  let inspection = backendInspection;
  if (!inspection) {
    let selected: ReturnType<typeof selectBackend>;
    try {
      selected = selectBackend();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        applied: [],
        warnings: [`Native scheduler activation could not be inspected: ${message}`],
        staleGrants: [],
      };
    }
    if (!selected.inspectBindings) {
      return {
        applied: [],
        warnings: [`Scheduler backend ${JSON.stringify(selected.name)} cannot inspect native bindings.`],
        staleGrants: [],
      };
    }
    try {
      inspection = await selected.inspectBindings({});
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        applied: [],
        warnings: [`Native scheduler activation could not be inspected: ${message}`],
        staleGrants: [],
      };
    }
  }
  const { pending, stale } = classifyInstalled(inspection.installed, config);
  if (pending.length === 0) {
    return { applied: Object.freeze([]), warnings: Object.freeze([]), staleGrants: stale };
  }
  const additions = new Map(pending.map((activation) => [activationKey(activation), activation]));
  mutateConfig((current) => {
    const combined = new Map(
      schedulerActivations(current).map((activation) => [activationKey(activation), activation]),
    );
    for (const [key, activation] of additions) combined.set(key, activation);
    const enabled = [...combined.values()].sort(
      (left, right) => left.ref.localeCompare(right.ref) || left.kind.localeCompare(right.kind),
    );
    return { ...current, scheduler: { ...current.scheduler, enabled } };
  });
  resetConfigCache();
  return { applied: pending, warnings: Object.freeze([]), staleGrants: stale };
}
