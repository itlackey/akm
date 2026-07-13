// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Backend selection for the OS-native scheduler.
 *
 *   • Linux   → crontab
 *   • macOS   → launchd (per-user LaunchAgent)
 *   • Windows → schtasks.exe / Task Scheduler
 *
 * Each backend implements {@link TaskBackend}; selection is a one-line
 * platform check. Tests inject a fake `platform` to exercise non-host
 * code paths.
 */

import type { ScheduleBackend } from "../schedule";
import type { TaskDocument } from "../schema";
import { CRON_BACKEND, type CronBackendOptions } from "./cron";
import { LAUNCHD_BACKEND, type LaunchdBackendOptions } from "./launchd";
import { SCHTASKS_BACKEND, type SchtasksBackendOptions } from "./schtasks";

export interface InstalledTaskRef {
  id: string;
  /**
   * Opaque, backend-specific fingerprint of the *currently installed* entry
   * (e.g. the cron line incl. enabled/disabled state). `tasks sync` compares
   * it against {@link TaskBackend.expectedSignature} to detect schedule drift
   * on tasks that already exist in the scheduler. Undefined when the backend
   * cannot cheaply read its installed form — sync then reinstalls to be safe.
   */
  signature?: string;
}

export interface TaskBackend {
  /** Stable name surfaced by `tasks doctor`. */
  readonly name: ScheduleBackend;
  /** Replace a native definition transactionally; rejection must leave the prior definition active. */
  install(task: TaskDocument): Promise<void> | void;
  uninstall(id: string): Promise<void> | void;
  setEnabled(id: string, enabled: boolean): Promise<void> | void;
  list(): Promise<InstalledTaskRef[]> | InstalledTaskRef[];
  /**
   * The signature the task *should* have once installed, derived from its
   * current on-disk definition. Compared against {@link InstalledTaskRef.signature}
   * during `tasks sync` so a changed schedule (or enabled state) is reinstalled
   * instead of being silently reported "unchanged". Optional — backends that
   * omit it fall back to always-reinstall during sync.
   */
  expectedSignature?(task: TaskDocument): string;
}

export interface SelectBackendOptions {
  platform?: NodeJS.Platform;
  cron?: CronBackendOptions;
  launchd?: LaunchdBackendOptions;
  schtasks?: SchtasksBackendOptions;
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore overrides. Inert in production; only tests call the setter
// (via tests/_helpers/seams.ts). See docs/design/di-seams-plan.md.
interface BackendsOverridesForTests {
  selectBackend?: typeof selectBackend;
  backendNameForPlatform?: typeof backendNameForPlatform;
}
let backendsOverrides: BackendsOverridesForTests | undefined;

/** TEST-ONLY. Swap backend selection; pass undefined to restore the real implementations. */
export function _setBackendsForTests(fakes?: BackendsOverridesForTests): void {
  backendsOverrides = fakes;
}

export function selectBackend(options: SelectBackendOptions = {}): TaskBackend {
  if (backendsOverrides?.selectBackend) return backendsOverrides.selectBackend(options);
  const platform = options.platform ?? process.platform;
  switch (platform) {
    case "win32":
      return SCHTASKS_BACKEND(options.schtasks);
    case "darwin":
      return LAUNCHD_BACKEND(options.launchd);
    default:
      return CRON_BACKEND(options.cron);
  }
}

export function backendNameForPlatform(platform: NodeJS.Platform = process.platform): ScheduleBackend {
  if (backendsOverrides?.backendNameForPlatform) return backendsOverrides.backendNameForPlatform(platform);
  if (platform === "win32") return "schtasks";
  if (platform === "darwin") return "launchd";
  return "cron";
}
