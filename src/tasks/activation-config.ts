// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The host's scheduling choice.
 *
 * `scheduler.enabled` in config.json is the list of fully-qualified refs
 * (`bundle//tasks/x`, `bundle//workflows/y`) this host installs in its native
 * scheduler. Installing a bundle never schedules anything: a task only gets a
 * native row once its ref is on this list (`akm task enable`, `akm setup`),
 * and only bundles that are active on this host are eligible.
 *
 * A config that predates the list (`scheduler.enabled` absent) is read as
 * "keep what is installed": `akm task sync` takes the akm-written rows already
 * in the native scheduler as the host's choice and writes the list once. A
 * 0.9.17-alpha `{kind, ref, sourceId}` entry is read as its `ref`.
 */
import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../core/asset/asset-placement";
import { bundleRefToString, makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { typeNameFromConceptId } from "../core/asset/resolve-ref";
import { type AkmConfig, mutateConfig, schedulerSourceIdFor } from "../core/config/config";
import { bundleComponentConfig, bundleContentRoots, isBundleEnabled } from "../core/config/config-sources";
import { UsageError } from "../core/errors";
import { warnOnce } from "../core/warn";
import type { InstalledSchedulerBinding } from "./scheduler-binding";

export function canonicalSchedulerRef(ref: string): string {
  const parsed = parseBundleRef(ref);
  if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) {
    throw new UsageError(
      `Scheduling requires a canonical fully-qualified ref, got ${JSON.stringify(ref)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return ref;
}

/**
 * Refs this host schedules, or `undefined` when the host has never chosen
 * (the config predates the list). An entry that is not a canonical ref is
 * skipped with a warning, never fatal.
 */
export function schedulerEnabledRefs(config: AkmConfig): readonly string[] | undefined {
  const enabled = config.scheduler?.enabled;
  if (enabled === undefined) return undefined;
  const refs = new Set<string>();
  for (const ref of enabled) {
    try {
      refs.add(canonicalSchedulerRef(ref));
    } catch {
      warnOnce(
        `scheduler:enabled:${ref}`,
        `Ignoring scheduler.enabled entry ${JSON.stringify(ref)}: not a canonical ref.`,
      );
    }
  }
  return Object.freeze([...refs]);
}

export function isSchedulerRefEnabled(config: AkmConfig, ref: string): boolean {
  return (schedulerEnabledRefs(config) ?? []).includes(canonicalSchedulerRef(ref));
}

export function revokeSchedulerActivationsForBundle(config: AkmConfig, bundleId: string): AkmConfig {
  const current = config.scheduler?.enabled;
  if (current === undefined) return config;
  const enabled = current.filter((ref) => bundleOf(ref) !== bundleId);
  if (enabled.length === current.length) return config;
  return { ...config, scheduler: { ...config.scheduler, enabled } };
}

/** Whether refs from this bundle may be scheduled here: configured and enabled, or the implicit `AKM_BUNDLE_DIR` stash. */
export function isSchedulerBundleActive(config: AkmConfig, bundleId: string): boolean {
  return schedulerSourceIdFor(config, bundleId) !== undefined;
}

/**
 * Add or remove one ref on this host's list. Callers must have made the host's
 * choice explicit first (see `initializeSchedulerChoice` in
 * `commands/tasks/tasks.ts`): on a config without the list this writes just
 * the one ref, which is the whole choice from then on.
 */
export function setSchedulerRefEnabled(
  ref: string,
  enabled: boolean,
): { config: AkmConfig; changed: boolean; ref: string } {
  const canonicalRef = canonicalSchedulerRef(ref);
  const result = mutateConfig((current) => {
    const existing = current.scheduler?.enabled ?? [];
    if (enabled && !isSchedulerBundleActive(current, bundleOf(canonicalRef) ?? "")) {
      throw new UsageError(
        `Cannot enable scheduled execution from inactive or unconfigured bundle ${JSON.stringify(bundleOf(canonicalRef))}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (current.scheduler?.enabled !== undefined && existing.includes(canonicalRef) === enabled) return current;
    const next = existing.filter((entry) => entry !== canonicalRef);
    if (enabled) next.push(canonicalRef);
    next.sort((left, right) => left.localeCompare(right));
    return { ...current, scheduler: { ...current.scheduler, enabled: next } };
  });
  return { config: result.config, changed: result.written, ref: canonicalRef };
}

/**
 * The refs behind the akm-written rows currently installed in the native
 * scheduler: what this host was running before it had a `scheduler.enabled`
 * list. Rows the backend proves disabled, rows for bundles that are not
 * active here, and rows whose task file is gone are left out.
 */
export function enabledRefsFromInstalled(
  installed: readonly InstalledSchedulerBinding[],
  config: AkmConfig,
): readonly string[] {
  const refs = new Set<string>();
  for (const entry of installed) {
    const ref = installedEntryRef(entry, config);
    if (ref !== undefined) refs.add(ref);
  }
  return Object.freeze([...refs].sort((left, right) => left.localeCompare(right)));
}

function installedEntryRef(entry: InstalledSchedulerBinding, config: AkmConfig): string | undefined {
  if (entry.enabled === false || !entry.invocation) return undefined;
  const invocation = entry.invocation;
  try {
    if (invocation[0] === "workflow" && invocation[1] === "run" && invocation.length === 3 && invocation[2]) {
      const ref = canonicalSchedulerRef(invocation[2]);
      const parsed = parseBundleRef(ref);
      if (!parsed.bundle || !isBundleEnabled(config, parsed.bundle)) return undefined;
      return hasBackingFile(config, parsed.bundle, parsed.conceptId) ? ref : undefined;
    }
    if (invocation[0] !== "task" || invocation[1] !== "run" || !invocation[2]) return undefined;
    const bundleIndex = invocation.indexOf("--bundle", 3);
    const bundle = bundleIndex === -1 ? config.defaultBundle : invocation[bundleIndex + 1];
    if (!bundle || !isBundleEnabled(config, bundle)) return undefined;
    const bundleConfig = config.bundles?.[bundle];
    const adapter = bundleConfig ? (bundleComponentConfig(bundleConfig)?.adapter ?? "akm") : "akm";
    const conceptId = adapter === "akm-task" ? invocation[2] : `tasks/${invocation[2]}`;
    if (!hasBackingFile(config, bundle, conceptId)) return undefined;
    return canonicalSchedulerRef(makeBundleRef(bundle, conceptId));
  } catch {
    return undefined;
  }
}

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

function bundleOf(ref: string): string | undefined {
  try {
    return parseBundleRef(ref).bundle;
  } catch {
    return undefined;
  }
}
