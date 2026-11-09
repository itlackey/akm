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
 * in the native scheduler as the host's choice and writes the list once.
 */
import fs from "node:fs";
import { filesForRef } from "../core/asset/asset-placement";
import { bundleRefToString, makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { type AkmConfig, mutateConfig, resetConfigCache, schedulerSourceIdFor } from "../core/config/config";
import { bundleComponentConfig, bundleContentRoots, isBundleEnabled } from "../core/config/config-sources";
import { UsageError } from "../core/errors";
import { warn, warnOnce } from "../core/warn";
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
 * The one writer of `scheduler.enabled`'s entries: the `managed` refs leave this host's list, then the `selected` ones
 * join it. Callers must have made the host's choice explicit first ({@link initializeSchedulerChoice}): on a config
 * without the list this writes just these refs, which is the whole choice from then on.
 */
export function setSchedulerRefs(
  managed: readonly string[],
  selected: readonly string[],
): { config: AkmConfig; changed: boolean } {
  const result = mutateConfig((current) => {
    const existing = current.scheduler?.enabled ?? [];
    for (const ref of selected) {
      if (!isSchedulerBundleActive(current, bundleOf(ref) ?? "")) {
        throw new UsageError(
          `Cannot enable scheduled execution from inactive or unconfigured bundle ${JSON.stringify(bundleOf(ref))}.`,
          "INVALID_FLAG_VALUE",
        );
      }
    }
    const next = [...existing.filter((entry) => !managed.includes(entry) && !selected.includes(entry)), ...selected];
    next.sort((left, right) => left.localeCompare(right));
    if (current.scheduler?.enabled !== undefined && next.length === existing.length) {
      const held = new Set(existing);
      if (next.every((entry) => held.has(entry))) return current;
    }
    return { ...current, scheduler: { ...current.scheduler, enabled: next } };
  });
  return { config: result.config, changed: result.written };
}

/** Add or remove one ref on this host's list. */
export function setSchedulerRefEnabled(
  ref: string,
  enabled: boolean,
): { config: AkmConfig; changed: boolean; ref: string } {
  const canonicalRef = canonicalSchedulerRef(ref);
  return { ...setSchedulerRefs([canonicalRef], enabled ? [canonicalRef] : []), ref: canonicalRef };
}

/**
 * A config that predates `scheduler.enabled` means "keep what is installed": the akm-written rows in the native
 * scheduler become the host's explicit list (written unless `write` is false), and the host is told so. Returns the
 * list.
 */
export function initializeSchedulerChoice(
  installed: readonly InstalledSchedulerBinding[],
  config: AkmConfig,
  options: { write: boolean },
): readonly string[] {
  const refs = enabledRefsFromInstalled(installed, config);
  if (options.write) {
    mutateConfig((current) => ({ ...current, scheduler: { ...current.scheduler, enabled: [...refs] } }));
    resetConfigCache();
  }
  warn(
    `This host had no scheduler.enabled list; ${options.write ? "it was" : "it would be"} initialized from the ` +
      `${refs.length} installed akm scheduler ${refs.length === 1 ? "binding" : "bindings"}` +
      `${refs.length > 0 ? `: ${refs.join(", ")}` : ""}. Use \`akm task enable\`/\`akm task disable <ref>\` to change it.`,
  );
  return refs;
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
  const contentRoot = bundleContentRoots(config).find((entry) => entry.id === bundle)?.contentRoot;
  if (!contentRoot) return true;
  try {
    return filesForRef(contentRoot, conceptId).some((file) => fs.existsSync(file) && fs.statSync(file).isFile());
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
