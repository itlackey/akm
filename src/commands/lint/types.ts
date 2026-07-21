// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export type LintIssueType =
  | "unquoted-colon"
  | "missing-updated"
  | "orphaned-stub"
  | "placeholder-stub"
  | "missing-name-or-type"
  | "stale-path"
  | "missing-skill-md"
  | "invalid-task-yaml"
  | "missing-ref"
  | "dangerous-vault-key"
  | "invalid-workflow-structure"
  | "missing-category";

export interface LintIssue {
  file: string;
  issue: LintIssueType;
  detail: string;
  /** `true` = fix applied; `false` = not fixable or no fix requested; `"failed"` = fix attempted but threw. */
  fixed: boolean | "failed";
}

export interface LintContext {
  filePath: string;
  relPath: string;
  raw: string;
  data: Record<string, unknown>;
  body: string;
  frontmatter: string | null;
  fix: boolean;
  stashRoot: string;
  /** Additional stash roots (secondary sources) for cross-stash ref resolution. */
  extraStashRoots?: string[];
  /**
   * M8: Per-file rule suppression. List of issue type strings to skip for this file.
   * Populated from the `lint_skip:` frontmatter key (YAML array of strings).
   * Example: `lint_skip: [missing-ref, stale-path]`
   */
  lintSkip?: string[];
}
