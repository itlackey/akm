import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Default linter for asset types that have no type-specific rules beyond the
 * base checks (`unquoted-colon`, `missing-updated`).
 *
 * Covers: `lessons`.
 */
export class DefaultLinter extends BaseLinter {
  readonly types = ["lessons"] as const;

  lint(ctx: LintContext): LintIssue[] {
    return this.runBaseChecks(ctx);
  }
}
