// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The host's scheduling choice.
 *
 * `scheduler.enabled` in config.json is the list of fully-qualified refs
 * (`bundle//tasks/x`) this host runs on schedule. Installing a bundle never
 * schedules anything: `akm task dispatch` only runs a task whose ref is on this
 * list (`akm task enable`, `akm setup`), and only bundles that are active on
 * this host are eligible.
 *
 * A config without the list has never chosen, and schedules nothing: akm 0.10
 * does not read the OS scheduler to seed it (a pre-0.9.32 config is upgraded
 * with akm 0.9.32 first). A 0.9.17-alpha `{kind, ref, sourceId}` entry is read
 * as its `ref`.
 */
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { type AkmConfig, mutateConfig } from "../core/config/config";
import { isBundleEnabled } from "../core/config/config-sources";
import { UsageError } from "../core/errors";
import { warnOnce } from "../core/warn";

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

/** Whether refs from this bundle may be scheduled here: configured and enabled. */
export function isSchedulerBundleActive(config: AkmConfig, bundleId: string): boolean {
  return isBundleEnabled(config, bundleId);
}

/**
 * The one writer of `scheduler.enabled`'s entries: the `managed` refs leave this host's list, then the `selected` ones
 * join it. On a config without the list this writes just these refs, which is the whole choice from then on.
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

function bundleOf(ref: string): string | undefined {
  try {
    return parseBundleRef(ref).bundle;
  } catch {
    return undefined;
  }
}
