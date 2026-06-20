// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/** Recommended `category` values for facts (see docs/design/fact-asset-type.md). */
const KNOWN_CATEGORIES = new Set(["personal", "team", "project", "convention", "meta"]);

/**
 * Linter for `facts/` assets.
 *
 * Extra check beyond base:
 *   - `missing-category`: a fact without a non-empty `category` frontmatter
 *     key. Category scopes the fact (personal/team/project/convention/meta)
 *     and drives how it is surfaced/injected, so it is expected. Reported as a
 *     non-fixable warning — we cannot infer the right scope automatically.
 */
export class FactLinter extends BaseLinter {
  readonly types = ["facts"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    const category = typeof ctx.data.category === "string" ? ctx.data.category.trim() : "";
    if (!category) {
      issues.push({
        file: ctx.relPath,
        issue: "missing-category",
        detail: "fact is missing a `category` (personal|team|project|convention|meta)",
        fixed: false,
      });
    } else if (!KNOWN_CATEGORIES.has(category)) {
      issues.push({
        file: ctx.relPath,
        issue: "missing-category",
        detail: `unrecognized category "${category}" (expected one of: ${[...KNOWN_CATEGORIES].join(", ")})`,
        fixed: false,
      });
    }

    return issues;
  }
}
