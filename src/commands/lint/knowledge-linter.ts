import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `knowledge/` assets.
 *
 * All checks are inherited from BaseLinter (`unquoted-colon`, `missing-updated`,
 * `stale-path`, `missing-ref`). No type-specific rules needed.
 */
export class KnowledgeLinter extends BaseLinter {
  readonly types = ["knowledge"] as const;

  lint(ctx: LintContext): LintIssue[] {
    return this.runBaseChecks(ctx);
  }
}
