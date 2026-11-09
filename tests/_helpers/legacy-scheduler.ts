/**
 * What akm 0.9.32 wrote into the OS scheduler: one `# akm:task` block per task (an `AKM_BUNDLE_DIR` assignment
 * before the launcher, `--bundle <b> --scheduled` after the id) and one `# akm:env` PATH block above the first.
 * Hand-built from the 0.9 renderer (`src/tasks/backends/cron.ts` at 0.9.32) so tests do not need 0.9 installed.
 */

export interface LegacyCronTask {
  id: string;
  cron: string;
  /** The working stash the syncing process had; the row's `AKM_BUNDLE_DIR`. */
  stashDir: string;
  bundle?: string;
  disabled?: boolean;
  /** Extra inline assignments a non-default installation's row carries (`AKM_STATE_DIR=...`). */
  extraEnvironment?: string[];
}

export function legacyCronBlock(task: LegacyCronTask, launcher: string, logDir: string): string {
  const environment = [`AKM_BUNDLE_DIR=${task.stashDir}`, ...(task.extraEnvironment ?? [])].join(" ");
  const line = `${task.cron} ${environment} ${launcher} task run ${task.id} --bundle ${task.bundle ?? "stash"} --scheduled > ${logDir}/${task.id}.log 2>&1`;
  return [
    `# akm:task ${task.id} BEGIN`,
    task.disabled ? `# akm:disabled ${line}` : line,
    `# akm:task ${task.id} END`,
  ].join("\n");
}

/** A 0.9.32 crontab: a user's own lines, the PATH block, then the task blocks. */
export function legacyCrontab(
  tasks: readonly LegacyCronTask[],
  options: { launcher: string; logDir: string; path?: string; userLines?: string[] },
): string {
  const [first, ...rest] = tasks.map((task) => legacyCronBlock(task, options.launcher, options.logDir));
  return `${[
    ...(options.userLines ?? ["MAILTO=ops@example.test", "17 4 * * * /usr/local/bin/backup-home"]),
    ...(first
      ? ["# akm:env BEGIN", `PATH=${options.path ?? "/usr/local/bin:/usr/bin:/bin"}`, "# akm:env END", first]
      : []),
    ...rest,
  ].join("\n")}\n`;
}
