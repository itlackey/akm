// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `agents/` assets.
 *
 * Extra check beyond base:
 *   - `missing-name-or-type`: frontmatter exists but `name` or `type` field is
 *     absent. Not auto-fixable; detail includes a suggested slug.
 */
export class AgentLinter extends BaseLinter {
  readonly types = ["agents"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    const missingFieldDetail = this.#checkMissingNameOrType(ctx.data, ctx.frontmatter);
    if (missingFieldDetail) {
      const slug = this.#suggestSlug(ctx.filePath);
      issues.push({
        file: ctx.relPath,
        issue: "missing-name-or-type",
        detail: `${missingFieldDetail}; suggested slug: ${slug}`,
        fixed: false,
      });
    }

    return issues;
  }

  #checkMissingNameOrType(data: Record<string, unknown>, frontmatterText: string | null): string | null {
    if (!frontmatterText) return null;
    const missingFields: string[] = [];
    if (!("name" in data) || !data.name) missingFields.push("name");
    if (!("type" in data) || !data.type) missingFields.push("type");
    if (missingFields.length === 0) return null;
    return `missing fields: ${missingFields.join(", ")}`;
  }

  #suggestSlug(filePath: string): string {
    return path
      .basename(filePath, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
}
