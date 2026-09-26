import { describe, expect, test } from "bun:test";
import { workflowStepInstructions } from "../src/workflows/compile";
import { parseWorkflow, type WorkflowParseResult } from "../src/workflows/parser";
import type { WorkflowPlanStep } from "../src/workflows/plan";

const VALID_WORKFLOW = `---
type: workflow
description: Ship a release with validation checks
tags:
  - release
  - deploy
params:
  version: { type: string, description: Version being released }
steps:
  - id: validate
  - id: deploy
---

# Ship Release

## validate

Confirm release notes, tag, and version are present.

### gate

- Release notes reviewed
- Version matches tag

## deploy

Run the deployment command and watch health checks.
`;

function parse(markdown: string, path = "workflows/test.md"): WorkflowParseResult {
  return parseWorkflow(markdown, { path });
}

function step(result: Extract<WorkflowParseResult, { ok: true }>, id: string): WorkflowPlanStep {
  const found = result.plan.steps.find((candidate) => candidate.stepId === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

function expectOk(result: WorkflowParseResult): asserts result is Extract<WorkflowParseResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected ok parse, got errors: ${result.errors.map((e) => `${e.line}: ${e.message}`).join("; ")}`);
  }
}

describe("parseWorkflow", () => {
  test("parses a valid workflow document into a compiled plan", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const plan = result.plan;

    expect(plan.description).toBe("Ship a release with validation checks");
    expect(plan.paramSchemas).toEqual({ version: { type: "string", description: "Version being released" } });
    expect(plan.params).toEqual(["version"]);
    expect(plan.preamble).toBe("# Ship Release");
    expect(plan.preamble).not.toContain("type: workflow");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.stepId).toBe("validate");
    expect(workflowStepInstructions(plan.steps[0]!)).toBe("Confirm release notes, tag, and version are present.");
    expect(plan.steps[0]!.gate.criteria).toEqual(["- Release notes reviewed\n- Version matches tag"]);
    expect(plan.steps[0]!.sequenceIndex).toBe(0);
    expect(plan.steps[1]!.gate.criteria).toEqual([]);
  });

  test("bare `- id:` with no map/route/unit is a complete minimal unit step", () => {
    const minimal = `---
type: workflow
steps:
  - id: only
---

## only

Do the one thing.
`;
    const result = parse(minimal);
    expectOk(result);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]!.stepId).toBe("only");
    expect(result.plan.steps[0]!.spec?.unit).toBeUndefined();
    expect(result.plan.steps[0]!.spec?.map).toBeUndefined();
    expect(result.plan.steps[0]!.route).toBeUndefined();
  });

  test("accepts canonical opaque xrefs in workflow frontmatter", () => {
    const withXrefs = VALID_WORKFLOW.replace(
      "params:\n",
      "xrefs:\n  - memories/project-a/deploy-order\n  - catalog//tables/customers\n  - guide#usage\nparams:\n",
    );
    expect(parse(withXrefs).ok).toBe(true);
  });

  test("rejects xrefs that are not an array of canonical asset refs", () => {
    for (const xrefs of [
      "xrefs: memories/deploy-order\n",
      "xrefs:\n  - environment:production\n",
      "xrefs:\n  - ../outside\n",
      "xrefs:\n  - memories/deploy-order\n  - 42\n",
    ]) {
      const result = parse(VALID_WORKFLOW.replace("params:\n", `${xrefs}params:\n`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((error) => error.message.includes("xrefs"))).toBe(true);
    }
  });

  test("accepts actor stamps in every form allowed by the shared envelope", () => {
    for (const stamps of [
      'generated: { by: " ", at: "" }\nverified: { by: human:reviewer, at: "2026-07-30" }\n',
      "generated: { by: process:builder }\nverified:\n  - { by: human:first }\n  - { by: process:second, at: now }\n",
      "generated: { by: process:builder }\nverified: []\n",
    ]) {
      expect(parse(VALID_WORKFLOW.replace("params:\n", `${stamps}params:\n`)).ok).toBe(true);
    }
  });

  test("rejects unknown actor stamp properties", () => {
    for (const stamps of [
      "generated: { by: process:builder, model: gpt-5 }\n",
      "verified: { by: human:reviewer, note: approved }\n",
      "verified:\n  - { by: human:reviewer, extra: true }\n",
    ]) {
      const result = parse(VALID_WORKFLOW.replace("params:\n", `${stamps}params:\n`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((error) => error.message.includes("actor stamp key"))).toBe(true);
    }
  });

  test("rejects actor stamps with invalid forms or field types", () => {
    for (const stamps of [
      "generated: [{ by: process:builder }]\n",
      "generated: { by: process:builder, at: 42 }\n",
      'generated: { by: "" }\n',
      "verified: human:reviewer\n",
      "verified:\n  - { at: now }\n",
      "verified:\n  - { by: 42 }\n",
      "verified:\n  - { by: human:reviewer, at: false }\n",
    ]) {
      const result = parse(VALID_WORKFLOW.replace("params:\n", `${stamps}params:\n`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((error) => /generated|verified/.test(error.message))).toBe(true);
    }
  });

  test("attaches accurate SourceRef line spans to steps", () => {
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    const [first, second] = result.plan.steps;

    expect(first!.spec?.source).toEqual({ path: "workflows/test.md", start: 10, end: 10 });
    expect(second!.spec?.source).toEqual({ path: "workflows/test.md", start: 11, end: 11 });
  });

  test("preserves instruction indentation and trailing Markdown hard-break spaces", () => {
    const hardBreak = "  ";
    const markdown = `---
type: workflow
steps:
  - id: only
---

## only

    Keep this first-line indentation.
Keep this hard break.${hardBreak}
And this line.
`;
    const result = parse(markdown);
    expectOk(result);

    expect(workflowStepInstructions(result.plan.steps[0]!)).toBe(
      `    Keep this first-line indentation.\nKeep this hard break.${hardBreak}\nAnd this line.`,
    );
  });

  test("a gate rubric includes later H3/H4 content through the next H2", () => {
    const markdown = VALID_WORKFLOW.replace(
      "- Release notes reviewed\n- Version matches tag",
      "- Release notes reviewed  \n### Evidence\nKeep the report.\n#### Details\n  Preserve this indentation.",
    );
    const result = parse(markdown);
    expectOk(result);

    expect(result.plan.steps[0]!.gate.criteria).toEqual([
      "- Release notes reviewed  \n### Evidence\nKeep the report.\n#### Details\n  Preserve this indentation.",
    ]);
  });

  test("rejects duplicate ### gate headings even after another nested H3", () => {
    const markdown = VALID_WORKFLOW.replace(
      "- Release notes reviewed\n- Version matches tag",
      "First rubric.\n\n### Evidence\nKeep the report.\n\n### gate\n\nSecond rubric.",
    );
    const result = parse(markdown);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.message.includes('more than one "### gate"'))).toBe(true);
  });

  test("rejects duplicate step ids", () => {
    const result = parse(VALID_WORKFLOW.replace("- id: deploy", "- id: validate"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("Duplicate step id") && e.message.includes("validate"))).toBe(
      true,
    );
  });

  test("unit/map steps must have a body section", () => {
    const missingSection = VALID_WORKFLOW.replace(
      "## deploy\n\nRun the deployment command and watch health checks.\n",
      "",
    );
    const result = parse(missingSection);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('"## deploy" body section'))).toBe(true);
  });

  test("a route step MAY omit its body section", () => {
    const routeOnly = `---
type: workflow
steps:
  - id: intake
  - id: triage
    route:
      input: steps.intake.output.status
      when: [{ match: pass, step: done }]
      default: done
  - id: done
---

## intake

Do the intake work.

## done

Post the summary.
`;
    const result = parse(routeOnly);
    expectOk(result);
    expect(step(result, "triage").spec?.instructions).toBeUndefined();
  });

  test("every level-2 heading must exactly match a declared step id", () => {
    const invalid = VALID_WORKFLOW.replace("## deploy\n", "## deployment\n");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('Unexpected level-2 heading "## deployment"'))).toBe(true);
  });

  test("frontmatter gate configuration without a rubric is inert", () => {
    const configured = VALID_WORKFLOW.replace("- id: deploy\n", "- id: deploy\n    gate: { max_loops: 2 }\n");
    const result = parse(configured);
    expectOk(result);
    const deploy = step(result, "deploy");
    expect(deploy.gate.maxLoops).toBe(2);
    expect(deploy.gate.criteria).toEqual([]);
  });

  test("gate.required is not part of the workflow format", () => {
    const result = parse(VALID_WORKFLOW.replace("- id: deploy\n", "- id: deploy\n    gate: { required: true }\n"));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.message.includes('Unknown Step "deploy" "gate" key'))).toBe(true);
  });

  test("an empty or whitespace-only ### gate section skips validation", () => {
    for (const rubric of ["", "   \n\t"]) {
      const markdown = VALID_WORKFLOW.replace(
        "### gate\n\n- Release notes reviewed\n- Version matches tag",
        `### gate\n${rubric}`,
      );
      const result = parse(markdown);
      expectOk(result);
      expect(step(result, "validate").gate).toMatchObject({ criteria: [], maxLoops: 1 });
    }
  });

  test("a ### gate rubric alone (no frontmatter gate:) declares a default gate", () => {
    // VALID_WORKFLOW's "validate" step already has a "### gate" rubric with no
    // frontmatter `gate:` block — this enables optional validation with the
    // default single attempt.
    const result = parse(VALID_WORKFLOW);
    expectOk(result);
    // The rubric's presence alone declares the gate, with the default single attempt.
    expect(step(result, "validate").gate).toMatchObject({ criteria: [expect.any(String)], maxLoops: 1 });
  });

  test("rejects unsupported workflow frontmatter keys", () => {
    const invalid = VALID_WORKFLOW.replace("type: workflow\n", "type: workflow\nmodel: gpt-5\n");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('"model"'))).toBe(true);
  });

  test("rejects an invalid step id (dots forbidden, one grammar everywhere)", () => {
    const invalid = VALID_WORKFLOW.replace("- id: validate", "- id: valid.ate");
    const result = parse(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("invalid id"))).toBe(true);
  });

  test("collects every error in one pass instead of stopping at the first", () => {
    const broken = `---
type: workflow
steps:
  - id: a b
  - id: c d
---

## a b

x
`;
    const result = parse(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const idErrors = result.errors.filter((e) => e.message.includes("invalid id"));
    expect(idErrors.length).toBeGreaterThanOrEqual(2);
  });
});
