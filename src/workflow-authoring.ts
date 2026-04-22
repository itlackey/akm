import fs from "node:fs";
import path from "node:path";
import { resolveAssetPathFromName } from "./asset-spec";
import { isWithin, resolveStashDir } from "./common";
import { UsageError } from "./errors";
import { parseWorkflowMarkdown, WorkflowValidationError } from "./workflow-markdown";

const DEFAULT_WORKFLOW_TEMPLATE = `---
description: Describe what this workflow accomplishes
tags:
  - example
params:
  example_param: Explain this parameter
---

# Workflow: Example Workflow

## Step: First Step
Step ID: first-step

### Instructions
Describe what to do in this step.

### Completion Criteria
- Confirm the first step is complete

## Step: Second Step
Step ID: second-step

### Instructions
Describe what happens next.
`;

export function getWorkflowTemplate(): string {
  return DEFAULT_WORKFLOW_TEMPLATE;
}

export function buildWorkflowTemplate(name?: string): string {
  if (!name) return DEFAULT_WORKFLOW_TEMPLATE;

  const title = humanizeWorkflowName(name);
  const stepId = slugifyWorkflowStepId(name);
  const customized = DEFAULT_WORKFLOW_TEMPLATE.replaceAll("Example Workflow", title)
    .replaceAll("First Step", `${title} Setup`)
    .replaceAll("first-step", `${stepId}-setup`);
  parseWorkflowMarkdown(customized);
  return customized;
}

export function createWorkflowAsset(input: { name: string; content?: string; from?: string; force?: boolean }): {
  ref: string;
  path: string;
  stashDir: string;
} {
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "workflows");
  fs.mkdirSync(typeRoot, { recursive: true });

  const normalizedName = normalizeWorkflowName(input.name);
  const assetPath = resolveAssetPathFromName("workflow", typeRoot, normalizedName);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved workflow path escapes the stash: "${normalizedName}"`);
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(`Workflow "${normalizedName}" already exists. Re-run with --force to overwrite it.`);
  }

  const content = input.from
    ? readWorkflowSource(input.from)
    : (input.content ?? buildWorkflowTemplate(normalizedName));
  try {
    parseWorkflowMarkdown(content);
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");

  return {
    ref: `workflow:${normalizedName}`,
    path: assetPath,
    stashDir,
  };
}

function readWorkflowSource(source: string): string {
  const resolved = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new UsageError(`Workflow source not found: "${source}".`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Workflow source must be a file: "${source}".`);
  }
  return fs.readFileSync(resolved, "utf8");
}

function normalizeWorkflowName(name: string): string {
  const normalized = name
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
  if (!normalized) {
    throw new UsageError("Workflow name cannot be empty.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("Workflow name must be a relative path without '.' or '..' segments.");
  }
  return normalized;
}

function humanizeWorkflowName(name: string): string {
  return (
    name
      .split("/")
      .pop()
      ?.replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase())
      .trim() || "Example Workflow"
  );
}

function slugifyWorkflowStepId(name: string): string {
  return (
    name
      .split("/")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}
