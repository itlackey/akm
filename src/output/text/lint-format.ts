// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` plain-text renderer.
 *
 * Same defect as `akm health` (see `./health-format.ts`'s header comment for
 * the full writeup): `lint` had no registered text formatter, so
 * `--format text` fell through to `renderGenericText`, which JSON-dumps the
 * `fixed`/`flagged` arrays as one line each — e.g.
 * `flagged=[{"file":"agents/x.md","issue":"missing-ref",...}, ...]`. Those
 * are exactly the array-of-status-bearing-records shape `./status-list`
 * exists to render, reused here rather than duplicated.
 */

import type { LintIssue } from "../../commands/lint/types";
import { renderStatusEntries, type StatusEntry } from "./status-list";

/**
 * `fixed === true` succeeded; `"failed"` is an attempted-and-failed fix (worse
 * than an unfixed, merely-flagged issue, which in turn is worse than a clean
 * success). `severityRank` ascends from most urgent — see
 * {@link renderStatusEntries} — so the three states must get three DISTINCT
 * ranks or a failed fix can sort behind a successful one in the same section.
 */
function glyphFor(fixed: LintIssue["fixed"]): { glyph: string; severityRank: number } {
  if (fixed === "failed") return { glyph: "✗", severityRank: 0 };
  if (fixed === true) return { glyph: "✓", severityRank: 2 };
  return { glyph: "⚠", severityRank: 1 };
}

/**
 * `file:line` when the finding is line-anchored (workflow parse/compile
 * errors), bare `file` otherwise. `LintIssue.line` is optional precisely
 * because most lint sources are whole-file, so their headline is byte-identical
 * to what it has always been.
 */
function locationOf(issue: LintIssue): string {
  return typeof issue.line === "number" ? `${issue.file}:${issue.line}` : issue.file;
}

function issueEntry(issue: LintIssue): StatusEntry {
  const { glyph, severityRank } = glyphFor(issue.fixed);
  return { severityRank, glyph, headline: `${locationOf(issue)}  [${issue.issue}]  ${issue.detail}` };
}

function renderIssueSection(title: string, issues: readonly LintIssue[]): string[] {
  if (issues.length === 0) return [`${title}: (none)`];
  return [`${title} (${issues.length})`, ...renderStatusEntries(issues.map(issueEntry))];
}

export function formatLintPlain(r: Record<string, unknown>): string | null {
  if (r === null || typeof r !== "object") return null;

  const fixed = Array.isArray(r.fixed) ? (r.fixed as LintIssue[]) : [];
  const flagged = Array.isArray(r.flagged) ? (r.flagged as LintIssue[]) : [];
  const warnings = Array.isArray(r.warnings) ? (r.warnings as LintIssue[]) : [];
  const summary = r.summary as { fixed?: number; flagged?: number; warnings?: number } | undefined;

  const lines: string[] = [];
  if (typeof r.ok === "boolean") lines.push(`ok: ${r.ok}`);
  lines.push(
    `summary: fixed=${summary?.fixed ?? fixed.length} flagged=${summary?.flagged ?? flagged.length}` +
      ` warnings=${summary?.warnings ?? warnings.length}`,
  );

  // Flagged (still needs attention) surfaces before warnings (advisory,
  // non-fatal) and fixed (already handled), so a scan of the output hits the
  // actionable items first.
  lines.push("", ...renderIssueSection("flagged", flagged));
  lines.push("", ...renderIssueSection("warnings", warnings));
  lines.push("", ...renderIssueSection("fixed", fixed));

  return lines.join("\n").trim();
}
