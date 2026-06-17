// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { parseWorkflow } from "../../workflows/parser";
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
            fixed: "failed",
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

    const isReadOnly = ctx.filePath.includes("/.cache/") || ctx.filePath.includes("/registry/");
    if (!isReadOnly) {
      try {
        const result = parseWorkflow(ctx.raw, { path: ctx.filePath });
        if (!result.ok) {
          for (const err of result.errors ?? []) {
            issues.push({
              file: ctx.relPath,
              issue: "invalid-workflow-structure",
              detail: err.message ?? String(err),
              fixed: false,
            });
          }
        }
      } catch (e) {
        issues.push({
          file: ctx.relPath,
          issue: "invalid-workflow-structure",
          detail: `workflow parser error: ${e instanceof Error ? e.message : String(e)}`,
          fixed: false,
        });
      }
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
