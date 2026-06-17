// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/** Valid values for the `type` field in command frontmatter. */
const VALID_COMMAND_TYPES = ["command"] as const;

/**
 * Linter for `commands/` assets.
 *
 * Extra checks beyond base:
 *   - `missing-name-or-type`: frontmatter exists but `name` or `type` field is
 *     absent. Not auto-fixable; detail includes a suggested slug.
 *   - `missing-name-or-type` (invalid value): `type` is present but not a
 *     recognised command type value.
 */
export class CommandLinter extends BaseLinter {
  readonly types = ["commands"] as const;

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
      const invalidTypeDetail = this.checkInvalidTypeValue(ctx.data, VALID_COMMAND_TYPES);
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
