// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

const PLACEHOLDER_STRINGS = ["Describe what this workflow accomplishes", "Example Workflow"];

/**
 * Linter for `workflows/` assets.
 *
 * Extra check beyond base:
 *   - `placeholder-stub`: body contains a known placeholder string.
 *     Fix: delete the file.
 */
export class WorkflowLinter extends BaseLinter {
  readonly types = ["workflows"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    const placeholderMatch = this.#checkPlaceholderStub(ctx.body);
    if (placeholderMatch) {
      if (ctx.fix) {
        try {
          fs.unlinkSync(ctx.filePath);
          issues.push({
            file: ctx.relPath,
            issue: "placeholder-stub",
            detail: `deleted: found "${placeholderMatch}"`,
            fixed: true,
          });
        } catch (e) {
          issues.push({
            file: ctx.relPath,
            issue: "placeholder-stub",
            detail: `could not delete: ${e instanceof Error ? e.message : String(e)}`,
            fixed: false,
          });
        }
        return issues;
      }
      issues.push({
        file: ctx.relPath,
        issue: "placeholder-stub",
        detail: `placeholder text: "${placeholderMatch}"`,
        fixed: false,
      });
    }

    return issues;
  }

  #checkPlaceholderStub(body: string): string | null {
    for (const placeholder of PLACEHOLDER_STRINGS) {
      if (body.includes(placeholder)) return placeholder;
    }
    return null;
  }
}
