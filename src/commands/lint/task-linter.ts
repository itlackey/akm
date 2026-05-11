import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `tasks/` assets.
 *
 * Tasks are `.md` files with YAML frontmatter. In addition to the base checks
 * this linter validates the required task fields:
 *
 *   - `schedule`  (string, non-empty) — cron expression or `@`-alias
 *   - `enabled`   (boolean)
 *   - At least one of: `prompt` or `workflow` field present
 *
 * All issues are reported as `invalid-task-frontmatter` and are **not**
 * auto-fixable. Cron expression syntax validation is intentionally out of
 * scope (that belongs to `parseSchedule()`).
 */
export class TaskLinter extends BaseLinter {
  readonly types = ["tasks"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    // Only validate frontmatter fields when frontmatter is present.
    if (ctx.frontmatter === null) return issues;

    const missing: string[] = [];

    // schedule: must be present and non-empty
    if (!("schedule" in ctx.data) || typeof ctx.data.schedule !== "string" || ctx.data.schedule.trim() === "") {
      missing.push("schedule");
    }

    // enabled: must be present (boolean — value of false is valid)
    if (!("enabled" in ctx.data)) {
      missing.push("enabled");
    }

    // At least one of: prompt or workflow
    const hasTarget = "prompt" in ctx.data || "workflow" in ctx.data;
    if (!hasTarget) {
      missing.push("prompt or workflow");
    }

    if (missing.length > 0) {
      issues.push({
        file: ctx.relPath,
        issue: "invalid-task-frontmatter",
        detail: `missing required fields: ${missing.join(", ")}`,
        fixed: false,
      });
    }

    return issues;
  }
}
