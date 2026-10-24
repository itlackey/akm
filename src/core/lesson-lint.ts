// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic frontmatter lint for `lesson` assets (v1 spec §13).
 *
 * The contract is fixed:
 *
 *   - Required: `description` — a non-empty single-line string describing
 *     what the lesson teaches.
 *   - Required: `when_to_use` — a non-empty single-line string describing
 *     the trigger that should make a caller apply the lesson.
 *
 * Lint produces structured findings rather than throwing so callers can
 * batch-validate (e.g. `akm proposal accept` over a queue) and surface every
 * violation in a single pass.
 *
 * The lint is intentionally side-effect free and does not import the indexer
 * or filesystem walker; it operates on a single file path + raw string. This
 * lets it run from any code path (CLI, proposal-accept, asset-spec tests)
 * without dragging in the rest of the runtime.
 */

import { parseFrontmatter } from "./asset/frontmatter";

/** A single finding produced by `lintLessonContent`. */
export interface LessonLintFinding {
  /** Stable identifier for the kind of violation. */
  kind: "missing-description" | "missing-when_to_use" | "empty-description" | "empty-when_to_use";
  /** Frontmatter field that triggered the finding. */
  field: "description" | "when_to_use";
  /** Human-readable message including the offending file path when known. */
  message: string;
}

/** Aggregate result for one lesson. */
export interface LessonLintReport {
  /** Path of the lesson file (or a synthetic id for in-memory lints). */
  path: string;
  /** Findings — empty array means the lesson satisfies the contract. */
  findings: LessonLintFinding[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Lint a lesson given its raw markdown source.
 *
 * `pathForMessages` is woven into every finding's message so callers can
 * surface the offending file in CLI/proposal flows without having to map
 * findings back to paths separately.
 */
export function lintLessonContent(raw: string, pathForMessages: string): LessonLintReport {
  const findings: LessonLintFinding[] = [];
  const parsed = parseFrontmatter(raw);
  const fm = parsed.data;

  if (!("description" in fm)) {
    findings.push({
      kind: "missing-description",
      field: "description",
      message: `Lesson at ${pathForMessages} is missing required frontmatter field \`description\`.`,
    });
  } else if (!isNonEmptyString(fm.description)) {
    findings.push({
      kind: "empty-description",
      field: "description",
      message: `Lesson at ${pathForMessages} has an empty \`description\` frontmatter field; it must be a non-empty single-line string.`,
    });
  }

  if (!("when_to_use" in fm)) {
    findings.push({
      kind: "missing-when_to_use",
      field: "when_to_use",
      message: `Lesson at ${pathForMessages} is missing required frontmatter field \`when_to_use\`.`,
    });
  } else if (!isNonEmptyString(fm.when_to_use)) {
    findings.push({
      kind: "empty-when_to_use",
      field: "when_to_use",
      message: `Lesson at ${pathForMessages} has an empty \`when_to_use\` frontmatter field; it must be a non-empty single-line string.`,
    });
  }

  return { path: pathForMessages, findings };
}
