// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-cutting semantic checks over an assembled WorkflowDocument draft.
 *
 * The parser handles per-line shape checks; this module runs rules that need
 * the whole document or the raw frontmatter at once: duplicate step IDs,
 * step-id format, and the frontmatter key whitelist.
 */

import type { WorkflowDocument, WorkflowError } from "./schema";

const STEP_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FRONTMATTER_KEYS = new Set(["description", "tags", "params", "name", "updated", "when_to_use"]);

export function runSemanticChecks(
  draft: WorkflowDocument,
  frontmatterData: Record<string, unknown>,
  frontmatterEndLine: number,
  errors: WorkflowError[],
): void {
  checkFrontmatterKeys(frontmatterData, frontmatterEndLine, errors);
  checkStepIdFormat(draft, errors);
  checkDuplicateStepIds(draft, errors);
  checkDependsOnReferences(draft, errors);
}

/** `### Depends On` edges must reference existing, other steps. */
function checkDependsOnReferences(draft: WorkflowDocument, errors: WorkflowError[]): void {
  const ids = new Set(draft.steps.map((step) => step.id));
  for (const step of draft.steps) {
    for (const dep of step.orchestration?.dependsOn ?? []) {
      const line = step.orchestration?.source.start ?? step.source.start;
      if (!ids.has(dep)) {
        errors.push({
          line,
          message: `Step "${step.id}" depends on unknown step "${dep}". "### Depends On" bullets must name existing Step IDs.`,
        });
        continue;
      }
      if (dep === step.id) {
        errors.push({
          line,
          message: `Step "${step.id}" cannot depend on itself.`,
        });
      }
    }
  }
}

function checkFrontmatterKeys(data: Record<string, unknown>, fmEndLine: number, errors: WorkflowError[]): void {
  for (const key of Object.keys(data)) {
    if (ALLOWED_FRONTMATTER_KEYS.has(key)) continue;
    errors.push({
      line: fmEndLine,
      message: `Workflow frontmatter "${key}" is not supported. Use only: description, tags, params, name, updated, when_to_use.`,
    });
  }
}

function checkStepIdFormat(draft: WorkflowDocument, errors: WorkflowError[]): void {
  for (const step of draft.steps) {
    if (STEP_ID_REGEX.test(step.id)) continue;
    errors.push({
      line: step.source.start,
      message: `Step ID "${step.id}" is invalid. Use letters, numbers, ".", "_" or "-" (e.g. "deploy-job").`,
    });
  }
}

function checkDuplicateStepIds(draft: WorkflowDocument, errors: WorkflowError[]): void {
  const firstSeenLine = new Map<string, number>();
  for (const step of draft.steps) {
    const previous = firstSeenLine.get(step.id);
    if (previous !== undefined) {
      errors.push({
        line: step.source.start,
        message: `Step ID "${step.id}" is already used on line ${previous}. Step IDs must be unique within a workflow.`,
      });
      continue;
    }
    firstSeenLine.set(step.id, step.source.start);
  }
}
