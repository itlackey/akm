/**
 * Workflow markdown → WorkflowDocument JSON.
 *
 * Composition over invention: frontmatter is parsed with the `yaml` package,
 * heading discovery with `parseMarkdownToc`, and section bodies with
 * `extractLineRange` — all already in the codebase. The parser walks the
 * heading list once to assemble a `WorkflowDocument` with `SourceRef`
 * line spans, accumulating `WorkflowError`s rather than throwing.
 */

import { parse as yamlParse } from "yaml";
import { parseFrontmatterBlock } from "../core/frontmatter";
import { parseMarkdownToc } from "../core/markdown";
import {
  type SourceRef,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowCompletionCriterion,
  type WorkflowDocument,
  type WorkflowError,
  type WorkflowInstructionBlock,
  type WorkflowParameter,
  type WorkflowParseResult,
  type WorkflowStep,
} from "./schema";
import { runSemanticChecks } from "./validator";

const WORKFLOW_TITLE_PREFIX = "Workflow:";
const STEP_PREFIX = "Step:";
const STEP_ID_LINE = /^Step ID:\s+(.+?)\s*$/;
const BULLET_LINE = /^[-*]\s+(.+)$/;
const SUBSECTION_INSTRUCTIONS = "Instructions";
const SUBSECTION_COMPLETION_CRITERIA = "Completion Criteria";

/**
 * Cheap structural probe for the matcher. Returns true if the body has the
 * unmistakable shape of a workflow file. Used in `src/indexer/matchers.ts` so
 * the matcher and parser cannot drift.
 */
export function looksLikeWorkflow(body: string): boolean {
  const structuralBody = stripFencedCodeBlocks(body);
  return (
    /^#\s+Workflow:\s+/m.test(structuralBody) &&
    /^##\s+Step:\s+/m.test(structuralBody) &&
    /^Step ID:\s+/m.test(structuralBody) &&
    /^###\s+Instructions\s*$/m.test(structuralBody)
  );
}

function stripFencedCodeBlocks(body: string): string {
  let inFence = false;
  const lines = body.split(/\r?\n/);
  const stripped: string[] = [];

  for (const line of lines) {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence;
      stripped.push("");
      continue;
    }
    stripped.push(inFence ? "" : line);
  }

  return stripped.join("\n");
}

export function parseWorkflow(markdown: string, source: { path: string }): WorkflowParseResult {
  const errors: WorkflowError[] = [];
  const path = source.path;
  const lines = markdown.split(/\r?\n/);
  const totalLines = lines.length;

  const fmBlock = parseFrontmatterBlock(markdown);
  const frontmatterEndLine = fmBlock ? Math.max(1, fmBlock.bodyStartLine - 1) : 1;
  const fmData = readFrontmatter(fmBlock?.frontmatter, errors);

  const description = readDescription(fmData);
  const tags = readTags(fmData, errors, frontmatterEndLine);
  const parameters = readParameters(fmData, errors, frontmatterEndLine, path);

  const toc = parseMarkdownToc(markdown);

  const { title, titleLine } = extractTitle(toc.headings, errors);

  // Disallow stray level-1 and non-Step level-2 headings.
  for (const h of toc.headings) {
    if (h.level === 1 && !h.text.startsWith(WORKFLOW_TITLE_PREFIX)) {
      errors.push({
        line: h.line,
        message: `Unexpected top-level heading "# ${h.text}" on line ${h.line}. A workflow file may only contain one "# Workflow: <title>" heading.`,
      });
    }
    if (h.level === 2 && !h.text.startsWith(STEP_PREFIX)) {
      errors.push({
        line: h.line,
        message: `Unexpected level-2 heading "## ${h.text}" on line ${h.line}. Only "## Step: <title>" sections are allowed.`,
      });
    }
  }

  const steps = extractSteps(toc.headings, lines, totalLines, path, errors);

  if (steps.length === 0 && titleLine > 0) {
    errors.push({
      line: titleLine,
      message: `Workflow has no "## Step: <title>" sections. Add at least one step.`,
    });
  }

  const draft: WorkflowDocument = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    title,
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(parameters ? { parameters } : {}),
    steps,
    source: { path, lineCount: totalLines },
  };

  runSemanticChecks(draft, fmData, frontmatterEndLine, errors);

  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors) };
  }
  return { ok: true, document: draft };
}

// ── Title ───────────────────────────────────────────────────────────────────

function extractTitle(
  headings: { level: number; text: string; line: number }[],
  errors: WorkflowError[],
): { title: string; titleLine: number } {
  const titleHeadings = headings.filter((h) => h.level === 1 && h.text.startsWith(WORKFLOW_TITLE_PREFIX));

  if (titleHeadings.length === 0) {
    errors.push({
      line: 1,
      message: `Workflow markdown must start with a "# Workflow: <title>" heading. Add one at the top of the file.`,
    });
    return { title: "", titleLine: 0 };
  }

  if (titleHeadings.length > 1) {
    for (const extra of titleHeadings.slice(1)) {
      errors.push({
        line: extra.line,
        message: `Found a second "# Workflow:" heading on line ${extra.line}. A workflow file must contain exactly one.`,
      });
    }
  }

  const first = titleHeadings[0];
  const title = first.text.slice(WORKFLOW_TITLE_PREFIX.length).trim();
  if (!title) {
    errors.push({
      line: first.line,
      message: `The "# Workflow:" heading on line ${first.line} is missing a title. Use "# Workflow: <title>".`,
    });
  }
  return { title, titleLine: first.line };
}

// ── Steps ───────────────────────────────────────────────────────────────────

function extractSteps(
  headings: { level: number; text: string; line: number }[],
  lines: string[],
  totalLines: number,
  path: string,
  errors: WorkflowError[],
): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let sequenceIndex = 0;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level !== 2 || !h.text.startsWith(STEP_PREFIX)) continue;

    const stepTitle = h.text.slice(STEP_PREFIX.length).trim();
    if (!stepTitle) {
      errors.push({
        line: h.line,
        message: `The "## Step:" heading on line ${h.line} is missing a title. Use "## Step: <title>".`,
      });
      continue;
    }

    const stepEnd = Math.min(findNextSiblingOrParentLine(headings, i, 2) - 1, totalLines);
    const stepSource: SourceRef = { path, start: h.line, end: stepEnd };

    const subsections = collectSubsections(headings, i, stepEnd);
    const stepIdSearchEnd = subsections.length > 0 ? subsections[0].headingLine - 1 : stepEnd;
    const stepId = scanStepId(lines, h.line + 1, stepIdSearchEnd, stepTitle, errors);

    const { instructions, completionCriteria } = collectStepBody(subsections, lines, path, stepTitle, errors);

    if (!stepId) continue; // scanStepId already pushed the missing-id error
    if (!instructions) {
      errors.push({
        line: h.line,
        message: `Step "${stepTitle}" is missing the required "### Instructions" section. Add one under the step.`,
      });
      continue;
    }

    steps.push({
      id: stepId,
      title: stepTitle,
      sequenceIndex: sequenceIndex++,
      instructions,
      ...(completionCriteria ? { completionCriteria } : {}),
      source: stepSource,
    });
  }

  return steps;
}

interface Subsection {
  name: string;
  headingLine: number;
  bodyStart: number;
  bodyEnd: number;
}

function collectSubsections(
  headings: { level: number; text: string; line: number }[],
  stepIndex: number,
  stepEnd: number,
): Subsection[] {
  const subs: Subsection[] = [];
  for (let j = stepIndex + 1; j < headings.length; j++) {
    const sub = headings[j];
    if (sub.level <= 2) break;
    if (sub.level !== 3) continue;
    const next = headings[j + 1];
    const rawEnd = next ? next.line - 1 : stepEnd;
    subs.push({
      name: sub.text,
      headingLine: sub.line,
      bodyStart: sub.line + 1,
      bodyEnd: Math.min(rawEnd, stepEnd),
    });
  }
  return subs;
}

function collectStepBody(
  subsections: Subsection[],
  lines: string[],
  path: string,
  stepTitle: string,
  errors: WorkflowError[],
): {
  instructions?: WorkflowInstructionBlock;
  completionCriteria?: WorkflowCompletionCriterion[];
} {
  let instructions: WorkflowInstructionBlock | undefined;
  let completionCriteria: WorkflowCompletionCriterion[] | undefined;

  for (const sub of subsections) {
    if (sub.name === SUBSECTION_INSTRUCTIONS) {
      if (instructions) {
        errors.push({
          line: sub.headingLine,
          message: `Step "${stepTitle}" has more than one "### Instructions" section (line ${sub.headingLine}). Keep only one.`,
        });
        continue;
      }
      const text = sliceLines(lines, sub.bodyStart, sub.bodyEnd).trim();
      if (!text) {
        errors.push({
          line: sub.headingLine,
          message: `Step "${stepTitle}" has an empty "### Instructions" section. Add the instructions text below the heading.`,
        });
        continue;
      }
      instructions = {
        text,
        source: { path, start: sub.bodyStart, end: sub.bodyEnd },
      };
      continue;
    }

    if (sub.name === SUBSECTION_COMPLETION_CRITERIA) {
      if (completionCriteria) {
        errors.push({
          line: sub.headingLine,
          message: `Step "${stepTitle}" has more than one "### Completion Criteria" section (line ${sub.headingLine}). Keep only one.`,
        });
        continue;
      }
      const items = collectBullets(lines, sub.bodyStart, sub.bodyEnd, path);
      if (items.length === 0) {
        errors.push({
          line: sub.headingLine,
          message: `Step "${stepTitle}" has an empty "### Completion Criteria" section. Add at least one "- criterion" bullet.`,
        });
        continue;
      }
      completionCriteria = items;
      continue;
    }

    errors.push({
      line: sub.headingLine,
      message: `Step "${stepTitle}" has an unknown "### ${sub.name}" section. Only "### Instructions" and "### Completion Criteria" are supported.`,
    });
  }

  return {
    ...(instructions ? { instructions } : {}),
    ...(completionCriteria ? { completionCriteria } : {}),
  };
}

function scanStepId(
  lines: string[],
  startLineInclusive: number,
  endLineInclusive: number,
  stepTitle: string,
  errors: WorkflowError[],
): string | undefined {
  let foundId: string | undefined;
  let foundLine = -1;

  for (let lineNum = startLineInclusive; lineNum <= endLineInclusive; lineNum++) {
    const trimmed = (lines[lineNum - 1] ?? "").trim();
    if (!trimmed) continue;
    const match = trimmed.match(STEP_ID_LINE);
    if (!match) continue;
    if (foundId !== undefined) {
      errors.push({
        line: lineNum,
        message: `Step "${stepTitle}" has more than one "Step ID:" line (first on line ${foundLine}). Keep only one.`,
      });
      continue;
    }
    foundId = match[1].trim();
    foundLine = lineNum;
  }

  if (!foundId) {
    errors.push({
      line: startLineInclusive,
      message: `Step "${stepTitle}" is missing a "Step ID: <id>" line. Add one between the step heading and its subsections.`,
    });
  }
  return foundId;
}

function collectBullets(
  lines: string[],
  startLineInclusive: number,
  endLineInclusive: number,
  path: string,
): WorkflowCompletionCriterion[] {
  const items: WorkflowCompletionCriterion[] = [];
  for (let lineNum = startLineInclusive; lineNum <= endLineInclusive; lineNum++) {
    const trimmed = (lines[lineNum - 1] ?? "").trim();
    if (!trimmed) continue;
    const match = trimmed.match(BULLET_LINE);
    if (!match) continue;
    items.push({
      text: match[1].trim(),
      source: { path, start: lineNum, end: lineNum },
    });
  }
  return items;
}

function findNextSiblingOrParentLine(
  headings: { level: number; line: number }[],
  fromIndex: number,
  level: number,
): number {
  for (let i = fromIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= level) return headings[i].line;
  }
  return Number.MAX_SAFE_INTEGER;
}

function sliceLines(lines: string[], startLineInclusive: number, endLineInclusive: number): string {
  if (endLineInclusive < startLineInclusive) return "";
  const s = Math.max(1, startLineInclusive);
  const e = Math.min(endLineInclusive, lines.length);
  return lines.slice(s - 1, e).join("\n");
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

function readFrontmatter(frontmatter: string | undefined, errors: WorkflowError[]): Record<string, unknown> {
  if (!frontmatter) return {};
  let parsed: unknown;
  try {
    parsed = yamlParse(frontmatter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({
      line: 1,
      message: `Workflow frontmatter is not valid YAML: ${msg}`,
    });
    return {};
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push({
      line: 1,
      message: `Workflow frontmatter must be a YAML mapping (key: value pairs). Use "key: value" lines between the --- markers.`,
    });
    return {};
  }
  return parsed as Record<string, unknown>;
}

function readDescription(data: Record<string, unknown>): string | undefined {
  const v = data.description;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed || undefined;
}

function readTags(data: Record<string, unknown>, errors: WorkflowError[], fmEndLine: number): string[] | undefined {
  const v = data.tags;
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return t ? [t] : undefined;
  }
  if (!Array.isArray(v) || !v.every((tag) => typeof tag === "string" && tag.trim().length > 0)) {
    errors.push({
      line: fmEndLine,
      message: `Workflow frontmatter "tags" must be a string or a list of non-empty strings.`,
    });
    return undefined;
  }
  return v.map((tag) => (tag as string).trim());
}

function readParameters(
  data: Record<string, unknown>,
  errors: WorkflowError[],
  fmEndLine: number,
  path: string,
): WorkflowParameter[] | undefined {
  const v = data.params;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    errors.push({
      line: fmEndLine,
      message: `Workflow frontmatter "params" must be a mapping of parameter names to descriptions.`,
    });
    return undefined;
  }

  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  const out: WorkflowParameter[] = [];
  for (const [name, desc] of entries) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      errors.push({
        line: fmEndLine,
        message: `Workflow parameter names must be non-empty.`,
      });
      continue;
    }
    if (typeof desc !== "string" || !desc.trim()) {
      errors.push({
        line: fmEndLine,
        message: `Workflow parameter "${trimmedName}" must have a non-empty string description in frontmatter "params".`,
      });
      continue;
    }
    out.push({
      name: trimmedName,
      description: desc.trim(),
      // The frontmatter parser doesn't track per-key line numbers; anchor to the
      // frontmatter block end so editors land somewhere sensible.
      source: { path, start: 1, end: fmEndLine },
    });
  }

  return out.length > 0 ? out : undefined;
}

// ── Error sorting ───────────────────────────────────────────────────────────

function sortErrors(errors: WorkflowError[]): WorkflowError[] {
  return [...errors].sort((a, b) => a.line - b.line);
}
