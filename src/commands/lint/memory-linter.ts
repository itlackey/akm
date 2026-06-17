// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { BaseLinter } from "./base-linter";
import type { LintContext, LintIssue } from "./types";

/**
 * Linter for `memories/` assets.
 *
 * Extra check beyond base:
 *   - `orphaned-stub`: `inferenceProcessed: true` in frontmatter AND body < 100
 *     chars AND no sibling `.derived.md` file. Fix: delete the stub file.
 */
export class MemoryLinter extends BaseLinter {
  readonly types = ["memories"] as const;

  lint(ctx: LintContext): LintIssue[] {
    const issues = this.runBaseChecks(ctx);

    // After base checks the file might have been mutated; re-parse body from
    // ctx.raw which was updated in place by BaseLinter when fix === true.
    const body = ctx.body;

    if (this.#isOrphanedStub(ctx.data, body, ctx.filePath)) {
      if (ctx.fix) {
        try {
          fs.unlinkSync(ctx.filePath);
          issues.push({
            file: ctx.relPath,
            issue: "orphaned-stub",
            detail: "deleted orphaned stub",
            fixed: true,
          });
        } catch (e) {
          issues.push({
            file: ctx.relPath,
            issue: "orphaned-stub",
            detail: `could not delete: ${e instanceof Error ? e.message : String(e)}`,
            fixed: "failed",
          });
        }
        // Signal caller to skip remaining checks via a sentinel issue
        // (caller must handle the deletion path; we mark the file as gone)
        return issues;
      }
      issues.push({
        file: ctx.relPath,
        issue: "orphaned-stub",
        detail: "inferenceProcessed stub with no derived sibling",
        fixed: false,
      });
    }

    return issues;
  }

  #isOrphanedStub(data: Record<string, unknown>, body: string, filePath: string): boolean {
    if (data.inferenceProcessed !== true) return false;
    if (body.trim().length >= 100) return false;
    const baseName = filePath.replace(/\.md$/, "");
    const derivedPath = `${baseName}.derived.md`;
    return !fs.existsSync(derivedPath);
  }
}
