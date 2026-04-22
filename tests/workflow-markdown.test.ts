import { describe, expect, test } from "bun:test";
import { parseWorkflowMarkdown, WorkflowValidationError } from "../src/workflow-markdown";

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
