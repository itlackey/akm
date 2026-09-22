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
  | "redacted-content"
  | "dangerous-env-key"
  | "invalid-workflow-structure"
  | "missing-category"
  /**
   * A file the sweep reached but could not finish checking — the per-file
   * dispatch threw (unreadable mid-run, a `--fix` write that failed in a way
   * the fixer could not absorb). Reported in-band so a partial sweep is
   * VISIBLE: before this code existed the throw escaped `akmLint()` entirely
   * and the caller learned neither which file failed nor which fixes had
   * already landed on disk (issue #761).
   */
  | "lint-failed"
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
   * `core/adapter/adapters/akm-lint.ts#workflowFrontendDiagnostics`).
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

/**
 * The issue codes that are ADVISORY: surfaced in lint output but never routed
 * into `flagged`, so `--fail-on-flagged` cannot fail a run over one.
 *
 * ONE home for that decision. EVERY routing point consults it — the adapter
 * path (`lint/index.ts#lintViaAdapter`), the sweep's per-file loop, and the
 * sweep's workflow-frontend pass — so a new advisory code cannot be classified
 * correctly in one place and land in `flagged` (exit 1) in another; a finding
 * is never filed by which producer emitted it. A future advisory belongs in
 * BOTH this set and {@link LintIssueType}: an unrecognized code is folded onto
 * `adapter-diagnostic` at the adapter boundary, which is deliberately NOT
 * advisory, so a code missing from the union cannot be routed by this set.
 *
 * Advisory-ness is deliberately NOT a field on {@link LintIssue}: issues are
 * serialized verbatim by `--format json`, and a new key on every advisory
 * would change every consumer's output to restate what `issue` already says.
 */
export const ADVISORY_LINT_ISSUES: ReadonlySet<string> = new Set<LintIssueType>(["workflow-warning"]);

/** True when `issue` belongs to the advisory channel — see {@link ADVISORY_LINT_ISSUES}. */
export function isAdvisoryLintIssue(issue: { issue: string }): boolean {
  return ADVISORY_LINT_ISSUES.has(issue.issue);
}

export interface LintIssue {
  file: string;
  issue: LintIssueType;
  detail: string;
  /** `true` = fix applied; `false` = not fixable or no fix requested; `"failed"` = no safe replacement was produced or written. */
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
  /** #884: opt-in dangling belief-edge repair. Independent of `fix`. */
  pruneDanglingEdges?: boolean;
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
