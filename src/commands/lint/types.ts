// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export type LintIssueType =
  | "unquoted-colon"
  | "missing-updated"
  | "orphaned-stub"
  | "placeholder-stub"
  | "missing-name-or-type"
  | "missing-type"
  | "stale-path"
  | "missing-skill-md"
  | "invalid-task-yaml"
  | "missing-ref"
  | "dangerous-env-key"
  | "invalid-workflow-structure"
  | "missing-category"
  // ── non-akm adapter `validate()` codes (akm 0.9.0 lint/adapter-dispatch wiring) ──
  //
  // These four are `llm-wiki`'s native structural checks
  // (`core/adapter/adapters/llm-wiki-adapter.ts`), reachable now that `akm lint`
  // dispatches every non-akm bundle through its OWN adapter's `validate()`
  // instead of the akm-shaped per-file sweep. `missing-type` / `missing-ref`
  // above are shared with `okf` (already closed members of this union).
  | "uncited-raw"
  | "missing-description"
  | "broken-xref"
  | "broken-source"
  /**
   * Non-fatal workflow compile ADVISORY (`compileWorkflowPlan().warnings` —
   * e.g. a step with no `output:` schema, or a `params.<name>` reference to an
   * undeclared param). Routed into `AkmLintResult.warnings`, never `flagged`,
   * so `--fail-on-flagged` ignores it (see
   * `core/adapter/adapters/akm-lint.ts#workflowCompileWarnings`).
   */
  | "workflow-warning"
  /**
   * Fallback for a `Diagnostic.issue` code this union does not (yet) name.
   * `Diagnostic.issue` (`core/adapter/types.ts`) is deliberately an OPEN
   * `string` — any current or future `BundleAdapter.validate()` may emit a
   * code this closed lint-command union has never heard of. Rather than
   * silently dropping that finding (or throwing at the CLI boundary), the
   * lint→adapter mapping (`commands/lint/index.ts#diagnosticToLintIssue`)
   * folds an unrecognized code onto this member and preserves the ORIGINAL
   * code in `detail` (prefixed `[<issue>] `) so nothing an adapter reports is
   * ever lost, even though the closed union can't type it precisely.
   */
  | "adapter-diagnostic";

export interface LintIssue {
  file: string;
  issue: LintIssueType;
  detail: string;
  /** `true` = fix applied; `false` = not fixable or no fix requested; `"failed"` = fix attempted but threw. */
  fixed: boolean | "failed";
  /**
   * 1-indexed line in `file`, when the producing check knows one — the same
   * optional field `Diagnostic.line` carries (`core/adapter/types.ts`), kept
   * OPTIONAL because most lint checks are whole-file and have no location.
   * Workflow parse/compile findings are line-anchored
   * (`WorkflowError.line`), so `akm lint` renders them as `file:line` in text
   * output and emits `"line": <n>` in `--format json`.
   */
  line?: number;
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
