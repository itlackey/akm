// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Re-exports the public API from the per-asset-type linter architecture.
 * The CLI registration in src/cli.ts requires no changes.
 */
export type { AkmLintOptions, AkmLintResult, LintIssue, LintIssueType } from "./lint/index";
export { akmLint } from "./lint/index";
