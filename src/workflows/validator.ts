/**
 * Cross-cutting semantic checks over an assembled WorkflowDocument draft.
 *
 * The parser handles per-line shape checks; this module runs rules that need
 * the whole document or the raw frontmatter at once: duplicate step IDs,
 * step-id format, and the frontmatter key whitelist.
 */

import type { WorkflowDocument, WorkflowError } from "./schema";

const STEP_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FRONTMATTER_KEYS = new Set(["description", "tags", "params"]);

export function runSemanticChecks(
  draft: WorkflowDocument,
  frontmatterData: Record<string, unknown>,
  frontmatterEndLine: number,
  errors: WorkflowError[],
): void {
  checkFrontmatterKeys(frontmatterData, frontmatterEndLine, errors);
  checkStepIdFormat(draft, errors);
  checkDuplicateStepIds(draft, errors);
}

function checkFrontmatterKeys(data: Record<string, unknown>, fmEndLine: number, errors: WorkflowError[]): void {
  for (const key of Object.keys(data)) {
    if (ALLOWED_FRONTMATTER_KEYS.has(key)) continue;
    errors.push({
      line: fmEndLine,
      message: `Workflow frontmatter "${key}" is not supported. Use only: description, tags, params.`,
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
