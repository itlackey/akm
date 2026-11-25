// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Diagnostic } from "../adapter/types";
import type { LintIssue, LintIssueType } from "./types";

/**
 * Every closed {@link LintIssueType} member a current adapter `validate()` can
 * legitimately emit. Anything outside this set folds onto `"adapter-diagnostic"`
 * (see `types.ts`'s doc comment on that member) rather than being dropped.
 */
const KNOWN_ADAPTER_ISSUE_TYPES: ReadonlySet<string> = new Set<LintIssueType>([
  "unquoted-colon",
  "missing-updated",
  "stale-path",
  "missing-ref",
  "missing-type",
  "missing-name-or-type",
  "missing-skill-md",
  // The `akm-task` adapter's own code, reported by `akm lint` for a
  // malformed or misnamed task file; without it here, a genuine
  // task finding would arrive folded onto `adapter-diagnostic`.
  "invalid-task-yaml",
  "dangerous-env-key",
  "uncited-raw",
  "missing-description",
  "broken-xref",
  "broken-source",
  "shadowed-spelling",
  "type-from-content",
  "invalid-workflow-structure",
  "workflow-warning",
]);

/** Map one adapter {@link Diagnostic} onto a {@link LintIssue} — see `types.ts`'s `"adapter-diagnostic"` doc comment for the open→closed reconciliation. */
export function diagnosticToLintIssue({ ref, ...diag }: Diagnostic): LintIssue {
  const issue = { ...diag, file: diag.file ?? ref };
  if (KNOWN_ADAPTER_ISSUE_TYPES.has(issue.issue)) return { ...issue, issue: issue.issue as LintIssueType };
  return { ...issue, issue: "adapter-diagnostic", detail: `[${issue.issue}] ${issue.detail}` };
}

/** The key two findings share when they are the same finding reported twice. */
export function lintIssueDedupeKey(issue: LintIssue): string {
  return `${issue.file} ${issue.issue} ${issue.detail}`;
}
