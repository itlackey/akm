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

import { isBundleSlug } from "../core/asset/asset-ref";
import { conceptIdFromTypeName, parseRefInput } from "../core/asset/resolve-ref";
import { utf8Bytes, WORKFLOW_MAX_INSTRUCTION_BYTES, WORKFLOW_MAX_PARAMS, WORKFLOW_MAX_STEPS } from "./resource-limits";
import type { WorkflowDocument, WorkflowError } from "./schema";

const STEP_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FRONTMATTER_KEYS = new Set(["description", "tags", "params", "name", "updated", "when_to_use", "xrefs"]);

export function runSemanticChecks(
  draft: WorkflowDocument,
  frontmatterData: Record<string, unknown>,
  frontmatterEndLine: number,
  errors: WorkflowError[],
): void {
  checkFrontmatterKeys(frontmatterData, frontmatterEndLine, errors);
  checkXrefs(frontmatterData.xrefs, frontmatterEndLine, errors);
  checkStepIdFormat(draft, errors);
  checkDuplicateStepIds(draft, errors);
  checkResourceLimits(draft, errors);
}

function checkXrefs(value: unknown, line: number, errors: WorkflowError[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ line, message: 'Workflow frontmatter "xrefs" must be an array of canonical asset refs.' });
    return;
  }
  for (const ref of value) {
    try {
      if (typeof ref !== "string") throw new Error("non-canonical ref");
      // Canonicity accepts BOTH grammars during the transition (WI-8.5a flipped
      // the content writers to the new grammar; existing content still carries
      // legacy xrefs — the dual-reader arm stays alive until WI-8.5b): the new
      // bare `conceptId` (or slug-clean `bundle//conceptId`) that lint/mv now
      // recognize, OR the legacy `[origin//]type:name` round-trip.
      const p = parseRefInput(ref);
      const conceptId = conceptIdFromTypeName(p.type, p.name);
      const newCanonical =
        p.origin !== undefined && p.origin !== "local" && p.origin !== "stash"
          ? isBundleSlug(p.origin)
            ? `${p.origin}//${conceptId}`
            : `${p.origin}//${p.type}:${p.name}`
          : conceptId;
      const legacyCanonical = p.origin ? `${p.origin}//${p.type}:${p.name}` : `${p.type}:${p.name}`;
      if (ref !== newCanonical && ref !== legacyCanonical) throw new Error("non-canonical ref");
    } catch {
      errors.push({
        line,
        message: `Workflow frontmatter "xrefs" contains an invalid or non-canonical ref: ${String(ref)}.`,
      });
    }
  }
}

function checkResourceLimits(draft: WorkflowDocument, errors: WorkflowError[]): void {
  if (draft.steps.length > WORKFLOW_MAX_STEPS) {
    errors.push({ line: 1, message: `Workflow must contain at most ${WORKFLOW_MAX_STEPS} steps.` });
  }
  if ((draft.parameters?.length ?? 0) > WORKFLOW_MAX_PARAMS) {
    errors.push({ line: 1, message: `Workflow must contain at most ${WORKFLOW_MAX_PARAMS} parameters.` });
  }
  for (const step of draft.steps) {
    if (utf8Bytes(step.instructions.text) > WORKFLOW_MAX_INSTRUCTION_BYTES) {
      errors.push({
        line: step.instructions.source.start,
        message: `Step "${step.id}" instructions exceed the 256 KiB resource limit.`,
      });
    }
  }
}

function checkFrontmatterKeys(data: Record<string, unknown>, fmEndLine: number, errors: WorkflowError[]): void {
  for (const key of Object.keys(data)) {
    if (ALLOWED_FRONTMATTER_KEYS.has(key)) continue;
    errors.push({
      line: fmEndLine,
      message: `Workflow frontmatter "${key}" is not supported. Use only: description, tags, params, name, updated, when_to_use, xrefs.`,
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
