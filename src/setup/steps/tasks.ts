// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard steps: register the default improve task set and enable/disable
 * scheduled core tasks.
 */

import * as p from "../../cli/clack";
import { detectServerDefault, isCiEnvironment, registerDefaultTasks } from "../../commands/tasks/default-tasks";
import { akmTasksAdd, akmTasksSetEnabled, akmTasksSync, listStashTasks } from "../../commands/tasks/tasks";
import { saveGitStash } from "../../sources/providers/git";
import { backendNameForPlatform } from "../../tasks/backends";
import { type EmbeddedTask, listEmbeddedTasks } from "../../tasks/embedded";
import { parseSchedule } from "../../tasks/schedule";
import { prompt } from "../prompt";

/**
 * Normalise a task id the same way `akm tasks` does (strip a trailing `.yml`
 * / `.md` suffix, trim) so the wizard can match embedded template ids against
 * the ids reported by `listStashTasks()`.
 */
function normaliseTaskIdForMatch(raw: string): string {
  return raw.trim().replace(/\.(yml|md)$/, "");
}

/**
 * Setup sub-step (issue #552): idempotently register the default improve task
 * set. Asks a single "Is this a server install?" question (defaulting per
 * platform) to decide whether the nightly sweep is enabled, then delegates to
 * {@link registerDefaultTasks}, which is CI-aware and never duplicates an
 * existing task. Skipped entirely under CI (the registration helper short-
 * circuits, and we never even prompt).
 *
 * Exported for testing.
 */
export async function stepDefaultImproveTasks(
  register: typeof registerDefaultTasks = registerDefaultTasks,
): Promise<void> {
  // CI: register nothing and don't prompt.
  if (isCiEnvironment()) {
    p.log.info("CI detected — skipping default improve task registration.");
    return;
  }

  const platformDefault = detectServerDefault();
  const serverInstall = await prompt(() =>
    p.confirm({
      message: "Is this a server install? (enables the nightly quality sweep at 2am)",
      initialValue: platformDefault,
    }),
  );

  const result = await register({ serverInstall: serverInstall === true });
  if (result.skipped) return;
  const total = result.created.length + result.existing.length;
  p.log.success(
    `Default improve tasks registered (${result.created.length} new, ${result.existing.length} already present, ${total} total).`,
  );
}

export interface ScheduledTasksDeps {
  list: typeof listStashTasks;
  add: typeof akmTasksAdd;
  setEnabled: typeof akmTasksSetEnabled;
  sync: typeof akmTasksSync;
  gitSync: typeof saveGitStash;
}

const DEFAULT_SCHEDULED_TASKS_DEPS: ScheduledTasksDeps = {
  list: listStashTasks,
  add: akmTasksAdd,
  setEnabled: akmTasksSetEnabled,
  sync: akmTasksSync,
  gitSync: saveGitStash,
};

export async function stepScheduledTasks(deps: ScheduledTasksDeps = DEFAULT_SCHEDULED_TASKS_DEPS): Promise<void> {
  const embedded = listEmbeddedTasks().filter((task) => task.enabled);
  if (embedded.length === 0) return;

  // Snapshot current state so we can diff against the user's selection.
  let installed: ReturnType<typeof listStashTasks>["tasks"] = [];
  try {
    installed = (await deps.list()).tasks;
  } catch {
    // A missing/empty tasks dir is fine — treat as nothing installed.
    installed = [];
  }
  const byId = new Map<string, (typeof installed)[number]>();
  for (const t of installed) byId.set(normaliseTaskIdForMatch(t.id), t);

  // Pre-check tasks that are installed AND enabled.
  const preChecked = embedded.filter((e) => byId.get(e.id)?.enabled === true).map((e) => e.id);

  const stateLabel = (e: EmbeddedTask): string => {
    const cur = byId.get(e.id);
    if (!cur) return "not installed";
    return cur.enabled ? "enabled" : "disabled";
  };

  const selected = await prompt(() =>
    p.multiselect({
      message: "Enable scheduled core tasks? (space to toggle, enter to confirm)",
      required: false,
      initialValues: preChecked,
      options: embedded.map((e) => ({
        value: e.id,
        label: e.label,
        hint: `${e.description} — ${e.schedule} [${stateLabel(e)}]`,
      })),
    }),
  );

  const selectedSet = new Set(selected as string[]);

  // Resolve per-task schedule edits for newly-checked, not-yet-installed tasks.
  const scheduleFor = new Map<string, string>();
  for (const e of embedded) {
    const cur = byId.get(e.id);
    if (selectedSet.has(e.id) && !cur) {
      const edited = await prompt(() =>
        p.text({
          message: `Schedule for ${e.label}?`,
          initialValue: e.schedule,
          validate(value) {
            const candidate = (value ?? "").trim() || e.schedule;
            try {
              parseSchedule(candidate, backendNameForPlatform());
            } catch (err) {
              return err instanceof Error ? err.message : "Invalid schedule.";
            }
            return undefined;
          },
        }),
      );
      const sched = ((edited as string) ?? "").trim() || e.schedule;
      scheduleFor.set(e.id, sched);
    }
  }

  let syncNeeded = false;
  for (const e of embedded) {
    const cur = byId.get(e.id);
    const checked = selectedSet.has(e.id);
    if (checked && !cur) {
      // New task: copy template into the primary stash + install scheduler entry.
      const schedule = scheduleFor.get(e.id) ?? e.schedule;
      await deps.add({
        id: e.id,
        schedule,
        command: e.command,
        description: e.description,
      });
      syncNeeded = true;
    } else if (checked && cur && !cur.enabled) {
      // Present but disabled → re-enable.
      await deps.setEnabled(e.id, true);
    } else if (!checked && cur?.enabled) {
      // Previously enabled, now unchecked → disable (keep the stash file).
      await deps.setEnabled(e.id, false);
    }
    // No state change → no action.
  }

  if (syncNeeded) {
    // Reconcile scheduler entries with on-disk YAML, then commit the new file
    // to git (a no-op for non-git stashes).
    await deps.sync();
    try {
      deps.gitSync(undefined, "akm setup: enable scheduled tasks");
    } catch {
      // Non-fatal — the task is installed regardless of git sync outcome.
    }
  }
}
