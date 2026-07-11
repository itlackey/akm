// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Default scheduled-task set for the improve pipeline (issue #552).
 *
 * Ships a well-tuned multi-cadence task set so a typical single-developer
 * install is correct with zero manual config. Registration is **idempotent**:
 * running `akm setup` / `akm tasks init` twice yields the same task set with no
 * duplicates. Each default task is a shell-command task (`akm improve --strategy
 * <name>`), so the strategy is overridable in `config.json` without editing the
 * task definition.
 *
 * The OS-scheduler-touching primitives (`add` / `setEnabled` / `list`) are
 * injected via {@link RegisterDefaultTasksDeps} so tests can supply fakes and
 * never mutate the host scheduler or a real stash — mirroring the
 * dependency-injection pattern used by `stepScheduledTasks` in setup.ts.
 */

import fs from "node:fs";
import os from "node:os";
import { akmTasksAdd, akmTasksList, type TasksAddInput } from "./tasks";

/**
 * One default task in the improve task set. `command` is the shell command run
 * on the schedule; `strategy` is informational (it is encoded into `command`).
 */
export interface DefaultTaskSpec {
  id: string;
  /** Improve strategy this task runs. Encoded into {@link command}. */
  strategy: string;
  command: string;
  /** Cron-style schedule, or `null` for a registered-but-unscheduled task. */
  schedule: string | null;
  description: string;
  /**
   * How the task's default enabled-state is decided:
   *  - `always`  → enabled on every install.
   *  - `server`  → enabled only on server installs (else registered disabled).
   *  - `manual`  → registered but never scheduled (run via `akm tasks run`).
   */
  enableMode: "always" | "server" | "manual";
}

/**
 * The canonical default improve task set. The `update-stashes` embedded core
 * template (nightly `akm update --all`) was retired in meta-review 06-M2:
 * third-party stash pulls are on-demand only now, not a scheduled cron.
 */
export const DEFAULT_IMPROVE_TASKS: readonly DefaultTaskSpec[] = [
  {
    id: "akm-improve-frequent",
    strategy: "frequent",
    command: "akm improve --strategy frequent --auto-accept safe",
    schedule: "0 * * * *",
    description: "Frequent extract + inference pass (every 60 min)",
    enableMode: "always",
  },
  {
    id: "akm-improve-consolidate",
    strategy: "consolidate",
    command: "akm improve --strategy consolidate --auto-accept safe",
    schedule: "0 */4 * * *",
    description: "Consolidation-only pass (every 4h)",
    enableMode: "always",
  },
  {
    id: "akm-improve-nightly",
    strategy: "thorough",
    command: "akm improve --strategy thorough --auto-accept safe",
    schedule: "0 2 * * *",
    description: "Full nightly quality sweep (daily 2am)",
    enableMode: "server",
  },
  {
    id: "akm-improve-catchup",
    strategy: "catchup",
    command: "akm improve --strategy catchup --auto-accept safe",
    schedule: null,
    description: "Manual recovery — consolidation + triage drain (run on demand)",
    enableMode: "manual",
  },
  {
    id: "akm-graph-refresh-weekly",
    strategy: "graph-refresh",
    command: "akm improve --strategy graph-refresh --auto-accept safe",
    schedule: "0 3 * * 0",
    description: "Full-corpus graph rebuild (weekly Sunday 3am)",
    enableMode: "always",
  },
] as const;

/**
 * A schedule for the manual catch-up task. The scheduler requires a valid
 * cron expression even when the task is registered disabled, so we give the
 * unscheduled task a nominal far-future-ish cadence and leave it disabled —
 * the documented entry point is `akm tasks run akm-improve-catchup`.
 */
const MANUAL_TASK_NOMINAL_SCHEDULE = "0 4 1 1 *"; // 04:00 on Jan 1 — never effectively fires

/** Injected primitives so tests never touch the OS scheduler or a real stash. */
export interface RegisterDefaultTasksDeps {
  list: typeof akmTasksList;
  add: typeof akmTasksAdd;
}

const DEFAULT_DEPS: RegisterDefaultTasksDeps = {
  list: akmTasksList,
  add: akmTasksAdd,
};

export interface RegisterDefaultTasksOptions {
  /**
   * Whether this is a server install. Governs the `server`-mode tasks
   * (currently only the nightly sweep). Defaults to {@link detectServerDefault}.
   */
  serverInstall?: boolean;
  /** Override the injected scheduler primitives (tests). */
  deps?: RegisterDefaultTasksDeps;
}

export interface RegisterDefaultTasksResult {
  skipped: boolean;
  reason?: "ci";
  /** Tasks newly created on this run. */
  created: string[];
  /** Tasks that already existed and were left in place (idempotent no-op). */
  existing: string[];
  /** Tasks whose enabled-state was toggled to match the desired default. */
  toggled: string[];
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.

interface DefaultTasksOverridesForTests {
  detectServerDefault?: typeof detectServerDefault;
  isCiEnvironment?: typeof isCiEnvironment;
  registerDefaultTasks?: typeof registerDefaultTasks;
}

let defaultTasksOverrides: DefaultTasksOverridesForTests | undefined;

/** TEST-ONLY. Swap the CI/server/register functions; pass undefined to restore. */
export function _setDefaultTasksForTests(fakes?: DefaultTasksOverridesForTests): void {
  defaultTasksOverrides = fakes;
}

/**
 * Decide whether `akm setup` is running in a CI environment, where it must
 * register NO scheduled tasks. Mirrors the common `CI=true` convention used by
 * GitHub Actions, GitLab CI, CircleCI, etc.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (defaultTasksOverrides?.isCiEnvironment) return defaultTasksOverrides.isCiEnvironment(env);
  const ci = env.CI;
  if (ci === undefined || ci === null) return false;
  const v = String(ci).trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/**
 * Platform-appropriate default for the "Is this a server install?" prompt:
 *  - Linux without a battery → `true` (server).
 *  - macOS / any host with a battery (laptop) → `false`.
 * Used as the default when setup is non-interactive (no TTY / --yes / CI).
 */
export function detectServerDefault(): boolean {
  if (defaultTasksOverrides?.detectServerDefault) return defaultTasksOverrides.detectServerDefault();
  if (os.platform() !== "linux") return false;
  // A laptop exposes a battery under /sys/class/power_supply/BAT*. Absence of
  // any battery is our heuristic for "server / desktop".
  try {
    const entries = fs.readdirSync("/sys/class/power_supply");
    const hasBattery = entries.some((e) => /^BAT/i.test(e));
    return !hasBattery;
  } catch {
    // If we cannot read power-supply info, prefer the safe server default on
    // Linux (the nightly sweep is low-impact and re-runnable).
    return true;
  }
}

/**
 * Idempotently register the default improve task set.
 *
 * - Skips entirely when `CI` is set (returns `{ skipped: true, reason: "ci" }`).
 * - Creates any missing task; never duplicates an existing one.
 * - Re-aligns the enabled-state of existing tasks to the desired default only
 *   when the install is fresh-creating them (existing tasks the user may have
 *   toggled are left untouched — we only toggle tasks we just created, plus we
 *   never re-disable a user-enabled task).
 */
export async function registerDefaultTasks(
  options: RegisterDefaultTasksOptions = {},
): Promise<RegisterDefaultTasksResult> {
  if (defaultTasksOverrides?.registerDefaultTasks) {
    return defaultTasksOverrides.registerDefaultTasks(options);
  }
  if (isCiEnvironment()) {
    return { skipped: true, reason: "ci", created: [], existing: [], toggled: [] };
  }

  const deps = options.deps ?? DEFAULT_DEPS;
  const serverInstall = options.serverInstall ?? detectServerDefault();

  let installed: Awaited<ReturnType<typeof akmTasksList>>["tasks"] = [];
  try {
    installed = (await deps.list()).tasks;
  } catch {
    installed = [];
  }
  const existingIds = new Set(installed.map((t) => t.id));

  const created: string[] = [];
  const existing: string[] = [];
  const toggled: string[] = [];

  for (const spec of DEFAULT_IMPROVE_TASKS) {
    const desiredEnabled = resolveDesiredEnabled(spec, serverInstall);
    if (existingIds.has(spec.id)) {
      // Idempotent: never re-create. Leave the existing task in place.
      existing.push(spec.id);
      continue;
    }

    const schedule = spec.schedule ?? MANUAL_TASK_NOMINAL_SCHEDULE;
    const addInput: TasksAddInput = {
      id: spec.id,
      schedule,
      command: spec.command,
      description: spec.description,
      // Manual + non-server-enabled tasks are written disabled so the
      // scheduler entry is inert until the user opts in / runs it manually.
      disabled: !desiredEnabled,
    };
    await deps.add(addInput);
    created.push(spec.id);
    if (desiredEnabled) toggled.push(spec.id);
  }

  return { skipped: false, created, existing, toggled };
}

function resolveDesiredEnabled(spec: DefaultTaskSpec, serverInstall: boolean): boolean {
  switch (spec.enableMode) {
    case "always":
      return true;
    case "server":
      return serverInstall;
    case "manual":
      return false;
  }
}
