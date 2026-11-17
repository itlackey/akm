// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure text rules shared by every lint surface (`akm lint` sweep and adapter
 * `validate`): which absolute paths count as current guidance, and how
 * sentence punctuation is kept out of paths and ref tokens. No filesystem
 * access here; callers decide how existence is probed.
 */

/**
 * A path segment shaped like a run-time filename template rather than a
 * literal reference: `<timestamp>`-style angle brackets, `{stamp}`/`${VAR}`
 * braces, a `YYYYMMDD`/`HHMMSS`-style run of date-format letters, a glob
 * character, or an elided `...` segment. Such a path never exists under its literal spelling.
 */
const PATH_PLACEHOLDER_PATTERN = /[<{]|[*?]|[YMDHS]{4,}|\.\.\./;

/** A line that presents a path as a record of the past or as an illustration, not as guidance to follow. */
const NON_CURRENT_LINE_PATTERN = /\b(?:historical(?:ly)?|previously|formerly|for example|for instance)\b|\be\.g\./i;

/** A heading whose section holds records or illustrations rather than current guidance. */
const NON_CURRENT_HEADING_PATTERN = /^#{1,6}\s.*\b(?:history|changelog|archive|examples?)\b/i;

/** Drop sentence punctuation absorbed at the end of a path or ref token. */
function stripTrailingSentencePunctuation(token: string): string {
  return token.replace(/[.;:!?]+$/, "");
}

/** True for a file under a bundle's `skills/` directory: a skill carries no `updated` field. */
function isSkillPath(relPath: string): boolean {
  return relPath.split(/[\\/]/)[0] === "skills";
}

/** What decides whether a lint rule applies to one file. */
export interface RuleScope {
  /** The file's path in its bundle. */
  relPath: string;
  /** The file sits inside an LLM Wiki: written by the wiki's own process, not authored as an akm asset. */
  llmWiki?: boolean;
  /** The rules the bundle's `lint.skip` (and the run) leave out for this file. */
  skip?: readonly string[];
}

/** The rules that state what an authored akm asset carries; they do not apply inside an LLM Wiki. */
const AUTHORED_ASSET_RULES: ReadonlySet<string> = new Set(["missing-updated", "missing-name-or-type"]);

/**
 * Whether `rule` applies to the file: the one place that decides it. Every producer of a lint finding (the `akm lint`
 * sweep and each adapter's `validate`) asks here before it reports a rule. What a check needs of the file's content (a
 * frontmatter block, a type) stays in the check.
 */
export function ruleApplies(rule: string, file: RuleScope): boolean {
  if (file.skip?.includes(rule)) return false;
  if (file.llmWiki === true && AUTHORED_ASSET_RULES.has(rule)) return false;
  if (rule === "missing-updated" && isSkillPath(file.relPath)) return false;
  return true;
}

/** An absolute path found in text, with where it sits. */
export interface PathReference {
  path: string;
  /** 1-based line in the file: `firstLine` is the line of the text's first line. */
  line: number;
  /** The line the path appears on, trimmed. */
  lineText: string;
}

/**
 * Absolute paths in `text` presented as current guidance. Paths on lines or in
 * sections that frame them as history or examples, fenced code examples,
 * run-time filename templates, and trailing sentence punctuation are excluded.
 */
export function findCurrentPathReferences(text: string, firstLine = 1): PathReference[] {
  const pathRe = /(?<=^|[\s"'`([=])\/[^\s"'`)\]>,:[\n]+/g;
  const out: PathReference[] = [];
  let inNonCurrentSection = false;
  let fence: { marker: string; length: number } | undefined;
  text.split(/\r?\n/).forEach((line, index) => {
    // Fenced examples can name generated files or sample inputs. Their literal
    // paths do not assert that a file exists on the author's current machine.
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.length &&
        delimiter[2]!.trim() === ""
      )
        fence = undefined;
      return;
    }
    if (delimiter && (delimiter[1]![0] !== "`" || !delimiter[2]!.includes("`"))) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      return;
    }
    if (/^#{1,6}\s/.test(line)) inNonCurrentSection = NON_CURRENT_HEADING_PATTERN.test(line);
    if (inNonCurrentSection || NON_CURRENT_LINE_PATTERN.test(line)) return;
    for (const match of line.matchAll(pathRe)) {
      const candidate = stripTrailingSentencePunctuation(match[0]);
      if (candidate.length > 1 && !PATH_PLACEHOLDER_PATTERN.test(candidate)) {
        out.push({ path: candidate, line: firstLine + index, lineText: line.trim() });
      }
    }
  });
  return out;
}
