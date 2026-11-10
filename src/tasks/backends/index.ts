// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Backend selection for the OS-native scheduler entry.
 *
 *   • Linux   → crontab
 *   • macOS   → launchd (per-user LaunchAgent)
 *   • Windows → schtasks.exe / Task Scheduler
 */

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

export function selectBackend(options: SelectBackendOptions = {}): SchedulerBackend {
  switch (options.platform ?? process.platform) {
    case "win32":
      return SCHTASKS_BACKEND(options.schtasks);
    case "darwin":
      return LAUNCHD_BACKEND(options.launchd);
    default:
      return CRON_BACKEND(options.cron);
  }
}
