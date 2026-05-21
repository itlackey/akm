/**
 * Re-exports the public API from the per-asset-type linter architecture.
 * The CLI registration in src/cli.ts requires no changes.
 */
export type { AkmLintOptions, AkmLintResult, LintIssue, LintIssueType } from "./lint/index";
export { akmLint } from "./lint/index";
