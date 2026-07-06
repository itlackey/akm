// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../../src/workflows/parser";
import type { WorkflowDocument } from "../../src/workflows/schema";

/**
 * P1 extended Markdown grammar (orchestration plan): `### Runner`,
 * `### Model`, `### Timeout`, `### Fan-out`, `### Schema`, `### Env`,
 * `### Depends On` step subsections. Additive and backward-compatible —
 * steps that declare none behave exactly as before.
 */

function parseOk(markdown: string): WorkflowDocument {
  const result = parseWorkflow(markdown, { path: "workflows/test.md" });
  if (!result.ok) {
    throw new Error(`expected parse to succeed, got: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  return result.document;
}

function parseErrors(markdown: string): string[] {
  const result = parseWorkflow(markdown, { path: "workflows/test.md" });
  if (result.ok) throw new Error("expected parse to fail");
  return result.errors.map((e) => e.message);
}

const LINEAR = `# Workflow: Linear

## Step: Only step
Step ID: only

### Instructions
Do the thing.
`;

const ORCHESTRATED = `# Workflow: Review files

## Step: Review changed files
Step ID: review

### Runner
sdk
profile: reviewer

### Model
deep

### Timeout
10m

### Fan-out
over: changed_files
concurrency: 8
reducer: collect

### Instructions
Review {{item}} for correctness bugs.

### Schema
\`\`\`json
{ "type": "object", "properties": { "file": { "type": "string" } }, "required": ["file"] }
\`\`\`

### Completion Criteria
- every changed file has a verdict

## Step: Summarize
Step ID: summarize

### Depends On
- review

### Instructions
Summarize the findings.
`;

describe("extended workflow grammar — orchestration subsections", () => {
  test("linear workflows parse unchanged with no orchestration field", () => {
    const doc = parseOk(LINEAR);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].orchestration).toBeUndefined();
  });

  test("parses runner, profile, model, timeout, fan-out, schema, and dependsOn", () => {
    const doc = parseOk(ORCHESTRATED);
    const review = doc.steps[0];
    expect(review.orchestration?.runner).toBe("sdk");
    expect(review.orchestration?.profile).toBe("reviewer");
    expect(review.orchestration?.model).toBe("deep");
    expect(review.orchestration?.timeoutMs).toBe(600_000);
    expect(review.orchestration?.fanOut).toEqual({ over: "changed_files", concurrency: 8, reducer: "collect" });
    expect(review.orchestration?.schema).toEqual({
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    });

    const summarize = doc.steps[1];
    expect(summarize.orchestration?.dependsOn).toEqual(["review"]);
  });

  test("timeout accepts seconds, ms, and none", () => {
    const mk = (timeout: string) => `# Workflow: T

## Step: S
Step ID: s

### Timeout
${timeout}

### Instructions
x
`;
    expect(parseOk(mk("90s")).steps[0].orchestration?.timeoutMs).toBe(90_000);
    expect(parseOk(mk("2500ms")).steps[0].orchestration?.timeoutMs).toBe(2_500);
    expect(parseOk(mk("none")).steps[0].orchestration?.timeoutMs).toBeNull();
  });

  test("rejects an unknown runner kind with an actionable error", () => {
    const errors = parseErrors(`# Workflow: T

## Step: S
Step ID: s

### Runner
warp-drive

### Instructions
x
`);
    expect(errors.some((m) => m.includes("warp-drive") && m.includes("llm"))).toBe(true);
  });

  test("rejects a fan-out without over:", () => {
    const errors = parseErrors(`# Workflow: T

## Step: S
Step ID: s

### Fan-out
concurrency: 4

### Instructions
x
`);
    expect(errors.some((m) => m.includes("over:"))).toBe(true);
  });

  test("rejects invalid fan-out concurrency and reducer", () => {
    const errors = parseErrors(`# Workflow: T

## Step: S
Step ID: s

### Fan-out
over: items
concurrency: zero
reducer: telepathy

### Instructions
x
`);
    expect(errors.some((m) => m.includes("concurrency"))).toBe(true);
    expect(errors.some((m) => m.includes("reducer"))).toBe(true);
  });

  test("rejects a schema that is not a JSON object", () => {
    const errors = parseErrors(`# Workflow: T

## Step: S
Step ID: s

### Schema
\`\`\`json
["not", "an", "object"]
\`\`\`

### Instructions
x
`);
    expect(errors.some((m) => m.includes("Schema"))).toBe(true);
  });

  test("rejects Depends On referencing an unknown step id", () => {
    const errors = parseErrors(`# Workflow: T

## Step: S
Step ID: s

### Depends On
- ghost-step

### Instructions
x
`);
    expect(errors.some((m) => m.includes("ghost-step"))).toBe(true);
  });

  test("parses env refs as a list", () => {
    const doc = parseOk(`# Workflow: T

## Step: S
Step ID: s

### Env
- env:build-vars

### Instructions
x
`);
    expect(doc.steps[0].orchestration?.env).toEqual(["env:build-vars"]);
  });

  test("still rejects truly unknown subsections", () => {
    const errors = parseErrors(`# Workflow: T

## Step: S
Step ID: s

### Wibble
x

### Instructions
x
`);
    expect(errors.some((m) => m.includes("Wibble"))).toBe(true);
  });
});
