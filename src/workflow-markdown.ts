import { parseFrontmatter, toStringOrUndefined } from "./frontmatter";
import type { WorkflowParameter, WorkflowStepDefinition } from "./stash-types";

const ALLOWED_FRONTMATTER_KEYS = new Set(["description", "tags", "params"]);
const STEP_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ParsedWorkflowDocument {
  title: string;
  description?: string;
  tags?: string[];
  parameters?: WorkflowParameter[];
  steps: WorkflowStepDefinition[];
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export function parseWorkflowMarkdown(markdown: string): ParsedWorkflowDocument {
  const parsed = parseFrontmatter(markdown);
  validateFrontmatter(parsed.data);

  const title = extractWorkflowTitle(parsed.content);
  const parameters = extractWorkflowParameters(parsed.data);
  const tags = extractWorkflowTags(parsed.data, parsed.frontmatter);
  const steps = extractWorkflowSteps(parsed.content);

  return {
    title,
    description: toStringOrUndefined(parsed.data.description),
    ...(tags ? { tags } : {}),
    ...(parameters ? { parameters } : {}),
    steps,
  };
}

function validateFrontmatter(data: Record<string, unknown>): void {
  const unsupported = Object.keys(data).filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new WorkflowValidationError(
      `Workflow frontmatter only supports description, tags, and params. Unsupported key(s): ${unsupported.join(", ")}`,
    );
  }
}

function extractWorkflowTitle(body: string): string {
  const matches = Array.from(body.matchAll(/^#\s+Workflow:\s+(.+?)\s*$/gm));
  if (matches.length === 0) {
    throw new WorkflowValidationError('Workflow markdown must contain a "# Workflow: <title>" heading.');
  }
  if (matches.length > 1) {
    throw new WorkflowValidationError('Workflow markdown must contain exactly one "# Workflow: <title>" heading.');
  }

  const title = matches[0]?.[1]?.trim() ?? "";
  if (!title) {
    throw new WorkflowValidationError('Workflow markdown must contain a non-empty "# Workflow: <title>" heading.');
  }

  return title;
}

function extractWorkflowTags(data: Record<string, unknown>, frontmatter: string | null): string[] | undefined {
  const tags = data.tags;
  if (typeof tags === "undefined") return undefined;
  if (typeof tags === "string") {
    const trimmed = tags.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (
    frontmatter &&
    typeof tags === "object" &&
    tags !== null &&
    !Array.isArray(tags) &&
    Object.keys(tags).length === 0
  ) {
    const blockTags = extractTagListFromFrontmatter(frontmatter);
    if (blockTags) return blockTags;
  }
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag.trim().length > 0)) {
    throw new WorkflowValidationError("Workflow frontmatter `tags` must be a string or an array of non-empty strings.");
  }
  return tags.map((tag) => tag.trim());
}

function extractWorkflowParameters(data: Record<string, unknown>): WorkflowParameter[] | undefined {
  const params = data.params;
  if (typeof params === "undefined") return undefined;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new WorkflowValidationError(
      "Workflow frontmatter `params` must be a mapping of parameter names to descriptions.",
    );
  }

  const entries = Object.entries(params);
  if (entries.length === 0) return undefined;

  return entries.map(([name, description]) => {
    if (!name.trim()) {
      throw new WorkflowValidationError("Workflow parameter names must be non-empty.");
    }
    if (typeof description !== "string" || !description.trim()) {
      throw new WorkflowValidationError(
        `Workflow parameter "${name}" must have a non-empty string description in frontmatter params.`,
      );
    }
    return { name: name.trim(), description: description.trim() };
  });
}

function extractWorkflowSteps(body: string): WorkflowStepDefinition[] {
  const lines = normalizeLines(body);
  const titleLineIndex = lines.findIndex((line) => /^#\s+Workflow:\s+/.test(line));
  if (titleLineIndex === -1) {
    throw new WorkflowValidationError('Workflow markdown must contain a "# Workflow: <title>" heading.');
  }

  const steps: WorkflowStepDefinition[] = [];
  let index = titleLineIndex + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index++;
      continue;
    }

    if (trimmed.startsWith("# ") && !/^#\s+Workflow:\s+/.test(trimmed)) {
      throw new WorkflowValidationError(`Unexpected top-level heading after workflow title: "${trimmed}".`);
    }

    const stepHeader = trimmed.match(/^##\s+Step:\s+(.+?)\s*$/);
    if (!stepHeader) {
      throw new WorkflowValidationError(
        `Expected a "## Step: <title>" section after the workflow title, but found: "${trimmed}".`,
      );
    }

    const stepTitle = stepHeader[1].trim();
    const sequenceIndex = steps.length;
    index++;

    let stepId: string | undefined;
    let instructions: string | undefined;
    let completionCriteria: string[] | undefined;

    while (index < lines.length) {
      const current = lines[index] ?? "";
      const currentTrimmed = current.trim();

      if (/^##\s+Step:\s+/.test(currentTrimmed)) break;
      if (/^#\s+/.test(currentTrimmed)) {
        throw new WorkflowValidationError(
          `Unexpected heading "${currentTrimmed}" inside step "${stepTitle}". Only step sections and step subsections are allowed.`,
        );
      }

      if (!currentTrimmed) {
        index++;
        continue;
      }

      const stepIdMatch = currentTrimmed.match(/^Step ID:\s+(.+?)\s*$/);
      if (stepIdMatch) {
        if (stepId) {
          throw new WorkflowValidationError(`Step "${stepTitle}" must contain exactly one "Step ID: <id>" line.`);
        }
        stepId = stepIdMatch[1].trim();
        if (!STEP_ID_REGEX.test(stepId)) {
          throw new WorkflowValidationError(
            `Step "${stepTitle}" has invalid Step ID "${stepId}". Use letters, numbers, ".", "_" or "-".`,
          );
        }
        index++;
        continue;
      }

      const subsection = currentTrimmed.match(/^###\s+(.+?)\s*$/);
      if (!subsection) {
        throw new WorkflowValidationError(
          `Unexpected content in step "${stepTitle}". Add "Step ID: <id>" before subsections or move text under "### Instructions".`,
        );
      }

      const subsectionName = subsection[1].trim();
      index++;
      const block = collectSectionBlock(lines, index);
      index = block.nextIndex;

      if (subsectionName === "Instructions") {
        if (instructions) {
          throw new WorkflowValidationError(`Step "${stepTitle}" must contain exactly one "### Instructions" section.`);
        }
        instructions = block.text;
        if (!instructions) {
          throw new WorkflowValidationError(`Step "${stepTitle}" must include instructions text.`);
        }
        continue;
      }

      if (subsectionName === "Completion Criteria") {
        if (completionCriteria) {
          throw new WorkflowValidationError(
            `Step "${stepTitle}" must contain at most one "### Completion Criteria" section.`,
          );
        }
        completionCriteria = block.items;
        if (!completionCriteria || completionCriteria.length === 0) {
          throw new WorkflowValidationError(`Step "${stepTitle}" has an empty "### Completion Criteria" section.`);
        }
        continue;
      }

      throw new WorkflowValidationError(
        `Unknown subsection "### ${subsectionName}" in step "${stepTitle}". Only "### Instructions" and optional "### Completion Criteria" are supported.`,
      );
    }

    if (!stepId) {
      throw new WorkflowValidationError(`Step "${stepTitle}" must contain exactly one "Step ID: <id>" line.`);
    }
    if (!instructions) {
      throw new WorkflowValidationError(`Step "${stepTitle}" must contain a "### Instructions" section.`);
    }

    steps.push({
      id: stepId,
      title: stepTitle,
      instructions,
      ...(completionCriteria ? { completionCriteria } : {}),
      sequenceIndex,
    });
  }

  if (steps.length === 0) {
    throw new WorkflowValidationError('Workflow markdown must contain at least one "## Step: <title>" section.');
  }

  const seenStepIds = new Set<string>();
  for (const step of steps) {
    if (seenStepIds.has(step.id)) {
      throw new WorkflowValidationError(`Workflow step IDs must be unique. Duplicate Step ID: "${step.id}".`);
    }
    seenStepIds.add(step.id);
  }

  return steps;
}

function normalizeLines(body: string): string[] {
  return body.replace(/\r\n|\r/g, "\n").split("\n");
}

function collectSectionBlock(
  lines: string[],
  startIndex: number,
): { text: string; items?: string[]; nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (/^##\s+Step:\s+/.test(trimmed) || /^###\s+/.test(trimmed) || /^#\s+/.test(trimmed)) break;
    collected.push(line);
    index++;
  }

  const text = collected.join("\n").trim();
  const items = text
    ? text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean)
    : undefined;

  return { text, items, nextIndex: index };
}

function extractTagListFromFrontmatter(frontmatter: string): string[] | undefined {
  const lines = frontmatter.split("\n");
  const tagIndex = lines.findIndex((line) => /^tags:\s*$/.test(line.trim()));
  if (tagIndex === -1) return undefined;

  const tags: string[] = [];
  for (let index = tagIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!line.startsWith("  ")) break;

    const match = trimmed.match(/^-\s+(.+?)\s*$/);
    if (!match) {
      throw new WorkflowValidationError(
        "Workflow frontmatter `tags` must contain only dash-prefixed list items when declared as a block list.",
      );
    }
    const tag = stripMatchingQuotes(match[1]?.trim() ?? "");
    if (tag) tags.push(tag);
  }

  return tags.length > 0 ? tags : undefined;
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
