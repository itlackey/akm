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

import type { LintIssue } from "../../core/lint/types";
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

/** Whether `--fix` repairs a rule's findings, and the one-line way to fix them otherwise. */
const RULE_HELP: Record<string, { fix: boolean; how: string }> = {
  "unquoted-colon": { fix: true, how: "quote the description value" },
  "missing-updated": { fix: true, how: "add `updated: YYYY-MM-DD` to the frontmatter" },
  "orphaned-stub": { fix: true, how: "write the stub's derived file or delete the stub" },
  "placeholder-stub": { fix: true, how: "replace the placeholder text or delete the file" },
  "missing-name-or-type": { fix: false, how: "add the missing `name` or `type` to the frontmatter" },
  "missing-type": { fix: false, how: "add `type` to the frontmatter" },
  "stale-path": {
    fix: false,
    how: 'correct the path; if the line records the past or an example, say so on the line ("formerly", "for example") or put it under a History/Examples heading',
  },
  "missing-skill-md": { fix: false, how: "add a SKILL.md to the skill directory" },
  "invalid-task-yaml": { fix: false, how: "use the .yml extension and valid task YAML" },
  "missing-ref": { fix: false, how: "correct the ref or create the asset it names" },
  "redacted-content": { fix: false, how: "restore the original text from version history" },
  "dangerous-env-key": { fix: false, how: "remove the key from the env file" },
  "tracked-secrets": {
    fix: false,
    how: "`git rm --cached` the file, or list its path under `lint.skip.tracked-secrets`",
  },
  "missing-category": { fix: false, how: "add the fact's `category`" },
  "invalid-workflow-structure": { fix: false, how: "correct the workflow as the detail says" },
};

/** Up to three folders (two directory levels at most) holding most of `files`, with their counts. */
function topFolders(files: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const folder = file.split(/[\\/]/).slice(0, -1).slice(0, 2).join("/") || ".";
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([folder, count]) => `${folder} (${count})`)
    .join(", ");
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One line per rule: findings, assets, where they cluster, whether `--fix` repairs them, and how to fix them. */
function renderRuleSummary(
  flagged: readonly LintIssue[],
  byRule: Record<string, { findings: number; assets: number }>,
): string[] {
  if (flagged.length === 0) return ["flagged: (none)"];
  const rules = Object.entries(byRule).sort((a, b) => b[1].findings - a[1].findings);
  return [
    `flagged (${flagged.length}); list one rule with \`akm lint --rule <rule>\``,
    ...rules.map(([rule, { findings, assets }]) => {
      const help = RULE_HELP[rule];
      const folders = topFolders(flagged.filter((issue) => issue.issue === rule).map((issue) => issue.file));
      return (
        `  ${rule}: ${count(findings, "finding")} in ${count(assets, "asset")}; ${folders}; ` +
        `--fix ${help?.fix ? "fixes it" : "does not fix it"}; ${help?.how ?? "see the detail with --rule"}`
      );
    }),
  ];
}

/** `lineText` cut to a window around `path` when the line is long, so one long line stays readable. */
function excerpt(lineText: string, path: string): string {
  if (lineText.length <= 200) return lineText;
  const start = Math.max(0, lineText.indexOf(path) - 80);
  return `${start > 0 ? "..." : ""}${lineText.slice(start, start + 200)}...`;
}

/** One rule's findings grouped by asset, each with where it is and what to change. */
function renderRuleListing(rule: string, flagged: readonly LintIssue[]): string[] {
  if (flagged.length === 0) return [`${rule}: no findings`];
  const byFile = new Map<string, LintIssue[]>();
  for (const issue of flagged) byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), issue]);
  const help = RULE_HELP[rule];
  const lines = [`${rule}: ${count(flagged.length, "finding")} in ${count(byFile.size, "asset")}`];
  if (help) lines.push(`how to fix: ${help.how}`);
  for (const [file, issues] of byFile) {
    const ref = issues[0]?.ref;
    lines.push("", ref ? `${ref}  (${file})` : file);
    for (const issue of issues) {
      const at = typeof issue.line === "number" ? `line ${issue.line}  ` : "";
      if (issue.path === undefined) {
        lines.push(`  ${at}${issue.detail}`);
        continue;
      }
      lines.push(`  ${at}${issue.path}  ${issue.reason}; nearest existing: ${issue.nearestExisting}`);
      lines.push(`      ${excerpt(issue.lineText ?? "", issue.path)}`);
    }
  }
  return lines;
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
  const rule = typeof r.rule === "string" ? r.rule : undefined;
  lines.push(
    "",
    ...(rule
      ? renderRuleListing(rule, flagged)
      : renderRuleSummary(flagged, (r.byRule ?? {}) as Record<string, { findings: number; assets: number }>)),
  );
  lines.push("", ...renderIssueSection("warnings", warnings));
  lines.push("", ...renderIssueSection("fixed", fixed));

  return lines.join("\n").trim();
}
