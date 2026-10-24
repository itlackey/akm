// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text rendering of the combined migration plan's task-file section
 * (spec docs/plans/specs/p4-deletions-closeout.md §3.2.5, rows B-31/B-32).
 */

import type { TextFormatterEntry } from "./registry";

interface MigrationPlanResult {
  status: string;
  blockers?: string[];
  taskFiles?: { changed: number; skipped: number; blocked: number };
  backupPath?: string;
  applied?: number;
}

function planGlyph(status: string): string {
  switch (status) {
    case "current":
      return "✓";
    case "ready":
      return "⚠";
    default: // "blocked"
      return "✗";
  }
}

export function formatMigratePlain(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const plan = result as MigrationPlanResult;
  if (typeof plan.status !== "string") return null;

  const lines: string[] = [`${planGlyph(plan.status)} ${plan.status}`];
  if (plan.taskFiles) {
    const tasks = plan.taskFiles;
    lines.push(`    task files: ${tasks.changed} change, ${tasks.skipped} current, ${tasks.blocked} blocked`);
  }

  if (plan.blockers?.length) {
    lines.push("", "blockers:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (plan.backupPath) {
    lines.push("", `backup: ${plan.backupPath}`);
  }
  if (plan.applied !== undefined) lines.push(`applied: ${plan.applied}`);

  return lines.join("\n");
}

export const migrateFormatters: TextFormatterEntry[] = [
  { command: "migrate-status", handler: (r) => formatMigratePlain(r) },
  { command: "migrate-apply", handler: (r) => formatMigratePlain(r) },
];
