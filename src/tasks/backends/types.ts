// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the OS-native scheduler backend contract (see
 * `tasks/backends/index.ts`). Split out so `cron.ts`/`launchd.ts`/`schtasks.ts`
 * never import the platform-selection barrel that imports them.
 */

export type { InstalledSchedulerBinding, SchedulerBackend, SchedulerInstallOptions } from "../scheduler-binding";
