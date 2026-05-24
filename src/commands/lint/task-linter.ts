// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `tasks/` assets.
 *
 * Tasks are pure YAML files at `<stash>/tasks/<id>.yml`. In addition to the
 * base checks this linter validates the required task fields:
 *
 *   - `schedule`  (string, non-empty) — cron expression or `@`-alias
 *   - `enabled`   (boolean)
 *   - At least one of: `prompt`, `workflow`, or `command` field present
 *
 * All issues are reported as `invalid-task-yaml` and are **not** auto-fixable.
 * Cron expression syntax validation is intentionally out of scope (that
 * belongs to `parseSchedule()`).
 */
export class TaskLinter extends BaseLinter {
  readonly types = ["tasks"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    // Skip files that failed to parse — `data` will be empty.
    if (ctx.data === null || Object.keys(ctx.data).length === 0) return issues;

    const missing: string[] = [];

    // schedule: must be present and non-empty
    if (!("schedule" in ctx.data) || typeof ctx.data.schedule !== "string" || ctx.data.schedule.trim() === "") {
      missing.push("schedule");
    }

    // enabled: must be present (boolean — value of false is valid)
    if (!("enabled" in ctx.data)) {
      missing.push("enabled");
    }

    // At least one of: prompt, workflow, or command
    const hasTarget = "prompt" in ctx.data || "workflow" in ctx.data || "command" in ctx.data;
    if (!hasTarget) {
      missing.push("prompt, workflow, or command");
    }

    if (missing.length > 0) {
      issues.push({
        file: ctx.relPath,
        issue: "invalid-task-yaml",
        detail: `missing required fields: ${missing.join(", ")}`,
        fixed: false,
      });
    }

    return issues;
  }
}
