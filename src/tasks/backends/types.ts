// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the OS-native scheduler backend contract (see
 * `tasks/backends/index.ts`).
 *
 * Split out of `index.ts` so that `cron.ts`/`launchd.ts`/`schtasks.ts` (which
 * `index.ts` imports by value to build the platform-selection barrel) do not
 * need a type-only import back into `index.ts` — that back-edge is a
 * static-graph cycle even though it is type-only (chunk 9 WI-9.8 KILL 7
 * sever). `index.ts` re-exports these types so existing import sites are
 * unaffected.
 */

import type { ScheduleBackend } from "../schedule";
import type { TaskDocument } from "../schema";

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
  /**
   * The bundle this scheduled entry was installed from, parsed from the
   * embedded `--target <bundle>` token. Absent (undefined) means the primary /
   * default bundle — the byte-identical, no-`--target` form. `tasks sync`
   * scopes reconciliation to entries whose `target` matches the bundle being
   * synced so a plain (primary) sync never removes another bundle's entries.
   */
  target?: string;
}

/**
 * Optional per-install context. `target` is the bundle name embedded as a
 * `--target <bundle>` token in the scheduled invocation — passed ONLY for a
 * non-default bundle (a default/primary task installs without it so its native
 * definition stays byte-identical). `expectedSignature` receives the same opts
 * so drift detection compares against the target-aware signature.
 */
export interface TaskInstallOptions {
  target?: string;
}

export interface TaskBackend {
  /** Stable name surfaced by `tasks doctor`. */
  readonly name: ScheduleBackend;
  /** Replace a native definition transactionally; rejection must leave the prior definition active. */
  install(task: TaskDocument, opts?: TaskInstallOptions): Promise<void> | void;
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
  expectedSignature?(task: TaskDocument, opts?: TaskInstallOptions): string;
}
