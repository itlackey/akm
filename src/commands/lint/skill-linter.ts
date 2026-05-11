import fs from "node:fs";
import path from "node:path";
import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `skills/` assets.
 *
 * Skills are **directory bundles**: each skill lives at `skills/<name>/` and
 * must contain a `SKILL.md` entry-point file.
 *
 * Directory-level check (via `lintDirectory`):
 *   - `missing-skill-md`: a skill subdirectory has no `SKILL.md`. Not
 *     auto-fixable — flagged with detail `"no SKILL.md in skills/<name>/"`.
 *
 * Per-file check:
 *   - Base checks (`unquoted-colon`, `missing-updated`) are run against any
 *     `.md` files found inside skill subdirectories.
 */
export class SkillLinter extends BaseLinter {
  readonly types = ["skills"] as const;

  /**
   * Called once per direct subdirectory of `skills/`. Reports a
   * `missing-skill-md` issue when the directory does not contain a `SKILL.md`.
   */
  lintDirectory(subdirPath: string, stashRoot: string): LintIssue[] {
    const skillMdPath = path.join(subdirPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      const relDir = path.relative(stashRoot, subdirPath);
      return [
        {
          file: relDir,
          issue: "missing-skill-md",
          detail: `no SKILL.md in ${relDir}/`,
          fixed: false,
        },
      ];
    }
    return [];
  }

  lint(ctx: LintContext): LintIssue[] {
    return this.runBaseChecks(ctx);
  }
}
