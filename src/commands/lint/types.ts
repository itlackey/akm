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
  | "invalid-workflow-structure";

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

export interface AssetLinter {
  /** Asset type(s) this linter handles. Matched against the stash subdirectory name. */
  readonly types: readonly string[];
  /** Run checks against the context. Mutates files when ctx.fix === true. Returns issues found. */
  lint(ctx: LintContext): LintIssue[];
  /**
   * Optional directory-level check called once per direct subdirectory of the
   * asset type's root folder, before the per-file loop runs for that subdir.
   * Useful for linters that need to verify directory structure (e.g. skills
   * requiring a SKILL.md entry point).
   *
   * @param subdirPath  Absolute path to the subdirectory being checked.
   * @param stashRoot   Absolute path to the stash root (for computing relPath).
   */
  lintDirectory?(subdirPath: string, stashRoot: string): LintIssue[];
}
