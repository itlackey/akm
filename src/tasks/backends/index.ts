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
}

export interface TaskBackend {
  /** Stable name surfaced by `tasks doctor`. */
  readonly name: ScheduleBackend;
  install(task: TaskDocument): Promise<void> | void;
  uninstall(id: string): Promise<void> | void;
  setEnabled(id: string, enabled: boolean): Promise<void> | void;
  list(): Promise<InstalledTaskRef[]> | InstalledTaskRef[];
}

export interface SelectBackendOptions {
  platform?: NodeJS.Platform;
  cron?: CronBackendOptions;
  launchd?: LaunchdBackendOptions;
  schtasks?: SchtasksBackendOptions;
}

export function selectBackend(options: SelectBackendOptions = {}): TaskBackend {
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
