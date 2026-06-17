// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/** Valid values for the `type` field in agent frontmatter. */
const VALID_AGENT_TYPES = ["agent"] as const;

/**
 * Linter for `agents/` assets.
 *
 * Extra checks beyond base:
 *   - `missing-name-or-type`: frontmatter exists but `name` or `type` field is
 *     absent. Not auto-fixable; detail includes a suggested slug.
 *   - `missing-name-or-type` (invalid value): `type` is present but not a
 *     recognised agent type value.
 */
export class AgentLinter extends BaseLinter {
  readonly types = ["agents"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    const missingFieldDetail = this.checkMissingNameOrType(ctx.data, ctx.frontmatter);
    if (missingFieldDetail) {
      const slug = this.suggestSlug(ctx.filePath);
      issues.push({
        file: ctx.relPath,
        issue: "missing-name-or-type",
        detail: `${missingFieldDetail}; suggested slug: ${slug}`,
        fixed: false,
      });
    } else {
      // Only validate the value when the field is actually present.
      const invalidTypeDetail = this.checkInvalidTypeValue(ctx.data, VALID_AGENT_TYPES);
      if (invalidTypeDetail) {
        issues.push({
          file: ctx.relPath,
          issue: "missing-name-or-type",
          detail: invalidTypeDetail,
          fixed: false,
        });
      }
    }

    return issues;
  }
}
