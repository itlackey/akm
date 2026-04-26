import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../src/workflows/parser";
import type { WorkflowParseResult } from "../src/workflows/schema";

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

function parse(markdown: string, path = "workflows/test.md"): WorkflowParseResult {
  return parseWorkflow(markdown, { path });
}

function expectOk(
  result: WorkflowParseResult,
): asserts result is { ok: true; document: NonNullable<Extract<WorkflowParseResult, { ok: true }>["document"]> } {
  if (!result.ok) {
    throw new Error(`Expected ok parse, got errors: ${result.errors.map((e) => `${e.line}: ${e.message}`).join("; ")}`);
  }
}

describe("parseWorkflow", () => {
  test("parses a valid workflow document into structured steps", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const doc = result.document;

    expect(doc.title).toBe("Ship Release");
    expect(doc.description).toBe("Ship a release with validation checks");
    expect(doc.tags).toEqual(["release", "deploy"]);
    expect(doc.parameters?.map((p) => ({ name: p.name, description: p.description }))).toEqual([
      { name: "version", description: "Version being released" },
    ]);
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[0].id).toBe("validate");
    expect(doc.steps[0].title).toBe("Validate Release Inputs");
    expect(doc.steps[0].instructions.text).toBe("Confirm release notes, tag, and version are present.");
    expect(doc.steps[0].completionCriteria?.map((c) => c.text)).toEqual([
      "Release notes reviewed",
      "Version matches tag",
    ]);
    expect(doc.steps[0].sequenceIndex).toBe(0);
    expect(doc.steps[1].completionCriteria).toBeUndefined();
  });

  test("attaches accurate SourceRef line spans to steps and instructions", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const [first, second] = result.document.steps;

    // VALID_WORKFLOW: frontmatter ends at line 8, "# Workflow: Ship Release" at line 10,
    // first "## Step:" at line 12, second "## Step:" at line 22.
    expect(first.source.path).toBe("workflows/test.md");
    expect(first.source.start).toBe(12);
    expect(first.instructions.source.start).toBeGreaterThanOrEqual(first.source.start);
    expect(first.instructions.source.end).toBeLessThan(second.source.start);
    expect(first.completionCriteria?.[0].source.start).toBeGreaterThan(first.instructions.source.end);
    expect(second.source.start).toBe(22);
  });

  test("rejects missing workflow title", () => {
    const result = parse(VALID_WORKFLOW.replace("# Workflow: Ship Release\n\n", ""));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain('"# Workflow: <title>"');
  });

  test("rejects duplicate step ids", () => {
    const result = parse(VALID_WORKFLOW.replace("Step ID: deploy", "Step ID: validate"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('"validate"') && e.message.includes("already used"))).toBe(
      true,
    );
  });

  test("rejects missing instructions sections", () => {
    const invalid = VALID_WORKFLOW.replace(
      "### Instructions\nRun the deployment command and watch health checks.\n",
      "",
    );
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("Instructions"))).toBe(true);
  });

  test("rejects unknown step subsections", () => {
    const invalid = VALID_WORKFLOW.replace(
      "### Completion Criteria\n- Release notes reviewed\n- Version matches tag\n",
      "### Notes\nDo something else\n",
    );
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("Notes"))).toBe(true);
  });

  test("rejects unsupported workflow frontmatter keys", () => {
    const invalid = VALID_WORKFLOW.replace("---\n", "---\nmodel: gpt-5\n");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("model"))).toBe(true);
  });

  test("collects every error in one pass instead of stopping at the first", () => {
    const broken = `# Workflow: Multi

## Step: One
Step ID: A B
### Instructions
do A

## Step: Two
Step ID: A B
### Instructions
do B
`;
    const result = parse(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Both invalid step IDs should be reported, not just the first.
    const idErrors = result.errors.filter((e) => e.message.includes("Step ID"));
    expect(idErrors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseWorkflow — intro paragraph (issue #158)", () => {
  const WORKFLOW_WITH_INTRO = `# Workflow: Example

This workflow is advisory and should only prepare commands.

## Step: First Step
Step ID: first-step

### Instructions
Do the thing.
`;

  test("parses cleanly when intro paragraph precedes first step", () => {
    const result = parse(WORKFLOW_WITH_INTRO);
    expectOk(result);
    expect(result.document.title).toBe("Example");
    expect(result.document.steps).toHaveLength(1);
    expect(result.document.steps[0].id).toBe("first-step");
    expect(result.document.steps[0].title).toBe("First Step");
  });

  test("existing valid workflows without intro paragraph parse identically", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    expect(result.document.title).toBe("Ship Release");
    expect(result.document.steps).toHaveLength(2);
    expect(result.document.steps[0].id).toBe("validate");
    expect(result.document.steps[1].id).toBe("deploy");
  });

  test("rejects workflow with intro paragraph but no steps", () => {
    const noSteps = `# Workflow: No Steps

This workflow has an intro but no steps at all.
`;
    const result = parse(noSteps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("Step"))).toBe(true);
  });
});
