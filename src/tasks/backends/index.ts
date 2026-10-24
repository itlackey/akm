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
 * Each backend implements {@link SchedulerBackend}; selection is a one-line
 * platform check. Tests inject a fake `platform` to exercise non-host
 * code paths.
 */

import type { ScheduleBackend } from "../schedule";
import { CRON_BACKEND, type CronBackendOptions } from "./cron";
import { LAUNCHD_BACKEND, type LaunchdBackendOptions } from "./launchd";
import { SCHTASKS_BACKEND, type SchtasksBackendOptions } from "./schtasks";
import type { SchedulerBackend } from "./types";

export interface SelectBackendOptions {
  platform?: NodeJS.Platform;
  cron?: CronBackendOptions;
  launchd?: LaunchdBackendOptions;
  schtasks?: SchtasksBackendOptions;
}

// WI-9.10e: the former `_setBackendsForTests` module-mutation seam was retired.
// Tests inject a fake `SchedulerBackend` directly via the `deps.backend` parameter
// the `akm task` mutation entries already accept (the backend carries its own
// `name`), so no module-level override binding is needed. `selectBackend`'s
// `options.platform` covers the platform-steering the seam's second override
// used to provide.
export function selectBackend(options: SelectBackendOptions = {}): SchedulerBackend {
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
  if (platform === "win32") return "schtasks";
  if (platform === "darwin") return "launchd";
  return "cron";
}
