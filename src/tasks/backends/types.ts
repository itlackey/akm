// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OS-native scheduler contract. akm owns at most one entry per user: it
 * runs `<launcher> task dispatch` every minute (see `src/tasks/dispatch.ts`).
 * Backends also find and remove the per-task rows akm 0.9 wrote, once, on upgrade.
 */

export type ScheduleBackend = "cron" | "launchd" | "schtasks";

/** What a backend installs: the launcher argv and the PATH captured when it was written. */
export interface DispatchEntry {
  readonly launcher: readonly string[];
  readonly path?: string;
}

/** A per-task row written by akm 0.9 (`# akm:task` block, `com.akm.task.*` plist, `\akm\<id>` task). */
export interface LegacyRow {
  readonly id: string;
  /** The `AKM_*` assignments the row set inline; they name the installation that wrote it. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface EntryInspection {
  /** The installed dispatch entry; absent when there is none. */
  readonly entry?: DispatchEntry;
  readonly legacy: readonly LegacyRow[];
}

export interface EntryChange {
  /** Install or replace the entry; `null` removes it; absent leaves it. */
  readonly entry?: DispatchEntry | null;
  /** Legacy rows (by id) to remove in the same operation. */
  readonly removeLegacy: readonly string[];
}

export interface SchedulerBackend {
  readonly name: ScheduleBackend;
  inspect(): Promise<EntryInspection> | EntryInspection;
  /** One operation: a backend that can write atomically (cron) does. Idempotent. */
  apply(change: EntryChange): Promise<void> | void;
}
