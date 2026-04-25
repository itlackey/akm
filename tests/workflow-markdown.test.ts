import { describe, expect, test } from "bun:test";
import { parseWorkflowMarkdown, WorkflowValidationError } from "../src/workflows/workflow-markdown";

const VALID_WORKFLOW = `---
description: Ship a release with validation checks
tags:
  - release
  - deploy
params:
  version: Version being released
---

# Workflow: Ship Release

## Step: Validate Release Inputs
Step ID: validate

### Instructions
Confirm release notes, tag, and version are present.

### Completion Criteria
- Release notes reviewed
- Version matches tag

## Step: Deploy Release
Step ID: deploy

### Instructions
Run the deployment command and watch health checks.
`;

describe("parseWorkflowMarkdown", () => {
  test("parses a valid workflow document into structured steps", () => {
    const workflow = parseWorkflowMarkdown(VALID_WORKFLOW);

    expect(workflow.title).toBe("Ship Release");
    expect(workflow.description).toBe("Ship a release with validation checks");
    expect(workflow.tags).toEqual(["release", "deploy"]);
    expect(workflow.parameters).toEqual([{ name: "version", description: "Version being released" }]);
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0]).toEqual({
      id: "validate",
      title: "Validate Release Inputs",
      instructions: "Confirm release notes, tag, and version are present.",
      completionCriteria: ["Release notes reviewed", "Version matches tag"],
      sequenceIndex: 0,
    });
    expect(workflow.steps[1]?.completionCriteria).toBeUndefined();
  });

  test("rejects missing workflow title", () => {
    expect(() => parseWorkflowMarkdown(VALID_WORKFLOW.replace("# Workflow: Ship Release\n\n", ""))).toThrow(
      WorkflowValidationError,
    );
  });

  test("rejects duplicate step ids", () => {
    const invalid = VALID_WORKFLOW.replace("Step ID: deploy", "Step ID: validate");
    expect(() => parseWorkflowMarkdown(invalid)).toThrow(/Duplicate Step ID: "validate"/);
  });

  test("rejects missing instructions sections", () => {
    const invalid = VALID_WORKFLOW.replace(
      "### Instructions\nRun the deployment command and watch health checks.\n",
      "",
    );
    expect(() => parseWorkflowMarkdown(invalid)).toThrow(/must contain a "### Instructions" section/);
  });

  test("rejects unknown step subsections", () => {
    const invalid = VALID_WORKFLOW.replace(
      "### Completion Criteria\n- Release notes reviewed\n- Version matches tag\n",
      "### Notes\nDo something else\n",
    );
    expect(() => parseWorkflowMarkdown(invalid)).toThrow(/Unknown subsection "### Notes"/);
  });

  test("rejects unsupported workflow frontmatter keys", () => {
    const invalid = VALID_WORKFLOW.replace("---\n", "---\nmodel: gpt-5\n");
    expect(() => parseWorkflowMarkdown(invalid)).toThrow(/Unsupported key\(s\): model/);
  });
});

describe("parseWorkflowMarkdown — intro paragraph (issue #158)", () => {
  const WORKFLOW_WITH_INTRO = `# Workflow: Example

This workflow is advisory and should only prepare commands.

## Step: First Step
Step ID: first-step

### Instructions
Do the thing.
`;

  test("parses cleanly when intro paragraph precedes first step", () => {
    const workflow = parseWorkflowMarkdown(WORKFLOW_WITH_INTRO);
    expect(workflow.title).toBe("Example");
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0]?.id).toBe("first-step");
    expect(workflow.steps[0]?.title).toBe("First Step");
  });

  test("existing valid workflows without intro paragraph parse identically", () => {
    const workflow = parseWorkflowMarkdown(VALID_WORKFLOW);
    expect(workflow.title).toBe("Ship Release");
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0]?.id).toBe("validate");
    expect(workflow.steps[1]?.id).toBe("deploy");
  });

  test("rejects workflow with intro paragraph but no steps", () => {
    const noSteps = `# Workflow: No Steps

This workflow has an intro but no steps at all.
`;
    expect(() => parseWorkflowMarkdown(noSteps)).toThrow(/must contain at least one "## Step: <title>" section/);
  });
});
