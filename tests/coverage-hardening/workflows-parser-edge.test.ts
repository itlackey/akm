// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: exercises the ERROR branches of the workflow parser that
 * the happy-path suite (tests/workflow-markdown.test.ts) never touches.
 *
 * Baseline coverage (workflow-markdown.test.ts only) left parser.ts at ~90%
 * funcs / ~72% lines, with every uncovered line being a validation/error
 * branch: looksLikeWorkflow + stripFencedCodeBlocks (fully uncovered), stray
 * headings, duplicate/empty subsections, frontmatter type errors, and the
 * parameter-shape checks. Each test asserts the specific error message so a
 * regression that drops or mis-routes a branch fails loudly (the relink-class
 * gap: code executed but only on well-formed input).
 */

import { describe, expect, test } from "bun:test";
import { looksLikeWorkflow, parseWorkflow } from "../../src/workflows/parser";
import type { WorkflowParseResult } from "../../src/workflows/schema";

function parse(markdown: string, path = "workflows/edge.md"): WorkflowParseResult {
  return parseWorkflow(markdown, { path });
}

function errors(result: WorkflowParseResult): { line: number; message: string }[] {
  if (result.ok) throw new Error("expected parse to fail, but it succeeded");
  return result.errors;
}

function hasMessage(result: WorkflowParseResult, needle: string): boolean {
  return errors(result).some((e) => e.message.includes(needle));
}

// ── looksLikeWorkflow (structural probe, fenced-code stripping) ───────────────

describe("looksLikeWorkflow", () => {
  const REAL = `# Workflow: Demo

## Step: One
Step ID: one

### Instructions
Do it.
`;

  test("returns true for a body with all four structural markers", () => {
    expect(looksLikeWorkflow(REAL)).toBe(true);
  });

  test("returns false when the Step ID line is missing", () => {
    const body = REAL.replace("Step ID: one\n", "");
    expect(looksLikeWorkflow(body)).toBe(false);
  });

  test("returns false when the Instructions heading is missing", () => {
    const body = REAL.replace("### Instructions\n", "");
    expect(looksLikeWorkflow(body)).toBe(false);
  });

  test("ignores markers that live only inside a fenced code block", () => {
    // A doc that merely SHOWS workflow syntax in a ``` fence must not be
    // mistaken for a real workflow — stripFencedCodeBlocks blanks the fence.
    const doc = `# Some Doc

Here is an example workflow:

\`\`\`
# Workflow: Not Real

## Step: Fake
Step ID: fake

### Instructions
Nope.
\`\`\`
`;
    expect(looksLikeWorkflow(doc)).toBe(false);
  });

  test("still detects a real workflow that also contains an unrelated fenced block", () => {
    const doc = `${REAL}
\`\`\`
console.log("hi");
\`\`\`
`;
    expect(looksLikeWorkflow(doc)).toBe(true);
  });

  test("treats a tilde-fenced block the same as a backtick fence", () => {
    const doc = `# Some Doc

~~~
# Workflow: Not Real
## Step: Fake
Step ID: fake
### Instructions
Nope.
~~~
`;
    expect(looksLikeWorkflow(doc)).toBe(false);
  });
});

// ── Title-level errors ────────────────────────────────────────────────────────

describe("parseWorkflow — title errors", () => {
  test("rejects an empty title (# Workflow: with no text)", () => {
    const md = `# Workflow:

## Step: One
Step ID: one

### Instructions
Do it.
`;
    const result = parse(md);
    expect(hasMessage(result, "missing a title")).toBe(true);
  });

  test("rejects a second # Workflow: heading", () => {
    const md = `# Workflow: First

## Step: One
Step ID: one

### Instructions
Do it.

# Workflow: Second
`;
    const result = parse(md);
    expect(hasMessage(result, 'second "# Workflow:" heading')).toBe(true);
  });

  test("rejects a stray non-Workflow level-1 heading", () => {
    const md = `# Workflow: Demo

# Random Top Heading

## Step: One
Step ID: one

### Instructions
Do it.
`;
    const result = parse(md);
    expect(hasMessage(result, "Unexpected top-level heading")).toBe(true);
  });

  test("rejects a non-Step level-2 heading", () => {
    const md = `# Workflow: Demo

## Notes

## Step: One
Step ID: one

### Instructions
Do it.
`;
    const result = parse(md);
    expect(hasMessage(result, "Unexpected level-2 heading")).toBe(true);
  });
});

// ── Step-level errors ─────────────────────────────────────────────────────────

describe("parseWorkflow — step errors", () => {
  test("rejects an empty step title (## Step: with no text)", () => {
    const md = `# Workflow: Demo

## Step:
Step ID: one

### Instructions
Do it.
`;
    const result = parse(md);
    expect(hasMessage(result, '"## Step:" heading')).toBe(true);
  });

  test("rejects a step missing its Step ID line", () => {
    const md = `# Workflow: Demo

## Step: One

### Instructions
Do it.
`;
    const result = parse(md);
    expect(hasMessage(result, 'missing a "Step ID:')).toBe(true);
  });

  test("rejects duplicate Step ID lines within one step", () => {
    const md = `# Workflow: Demo

## Step: One
Step ID: one
Step ID: two

### Instructions
Do it.
`;
    const result = parse(md);
    expect(hasMessage(result, 'more than one "Step ID:"')).toBe(true);
  });

  test("rejects a step missing its Instructions section", () => {
    const md = `# Workflow: Demo

## Step: One
Step ID: one

### Completion Criteria
- something
`;
    const result = parse(md);
    expect(hasMessage(result, 'required "### Instructions"')).toBe(true);
  });

  test("rejects duplicate Instructions sections", () => {
    const md = `# Workflow: Demo

## Step: One
Step ID: one

### Instructions
First.

### Instructions
Second.
`;
    const result = parse(md);
    expect(hasMessage(result, 'more than one "### Instructions"')).toBe(true);
  });

  test("rejects an empty Instructions section", () => {
    const md = `# Workflow: Demo

## Step: One
Step ID: one

### Instructions

### Completion Criteria
- ok
`;
    const result = parse(md);
    expect(hasMessage(result, 'empty "### Instructions"')).toBe(true);
  });

  test("rejects duplicate Completion Criteria sections", () => {
    const md = `# Workflow: Demo

## Step: One
Step ID: one

### Instructions
Do it.

### Completion Criteria
- a

### Completion Criteria
- b
`;
    const result = parse(md);
    expect(hasMessage(result, 'more than one "### Completion Criteria"')).toBe(true);
  });

  test("rejects an empty Completion Criteria section (no bullets)", () => {
    const md = `# Workflow: Demo

## Step: One
Step ID: one

### Instructions
Do it.

### Completion Criteria
Just prose, no bullets.
`;
    const result = parse(md);
    expect(hasMessage(result, 'empty "### Completion Criteria"')).toBe(true);
  });
});

// ── Frontmatter type errors ───────────────────────────────────────────────────

describe("parseWorkflow — frontmatter errors", () => {
  const BODY = `

# Workflow: Demo

## Step: One
Step ID: one

### Instructions
Do it.
`;

  test("rejects invalid YAML frontmatter", () => {
    const md = `---\nfoo: [unclosed\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, "not valid YAML")).toBe(true);
  });

  test("rejects frontmatter that is a YAML list, not a mapping", () => {
    const md = `---\n- one\n- two\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, "must be a YAML mapping")).toBe(true);
  });

  test("rejects a scalar frontmatter value", () => {
    const md = `---\njust a bare string\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, "must be a YAML mapping")).toBe(true);
  });

  test("accepts tags given as a single string (normalised to a one-element list)", () => {
    const md = `---\ntags: release\n---${BODY}`;
    const result = parse(md);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.tags).toEqual(["release"]);
  });

  test("rejects tags containing a non-string / empty entry", () => {
    const md = `---\ntags:\n  - ok\n  - ""\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, '"tags" must be a string or a list')).toBe(true);
  });

  test("rejects params that is a list rather than a mapping", () => {
    const md = `---\nparams:\n  - a\n  - b\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, '"params" must be a mapping')).toBe(true);
  });

  test("rejects a param whose description is not a non-empty string", () => {
    const md = `---\nparams:\n  version: 123\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, "must have a non-empty string description")).toBe(true);
  });

  test("rejects an empty parameter name", () => {
    const md = `---\nparams:\n  "": some description\n---${BODY}`;
    const result = parse(md);
    expect(hasMessage(result, "parameter names must be non-empty")).toBe(true);
  });
});

// ── Cross-cutting: error ordering + CRLF handling ─────────────────────────────

describe("parseWorkflow — ordering and line endings", () => {
  test("returns errors sorted ascending by line number", () => {
    const md = `# Workflow: Demo

## Notes

## Step: One
Step ID: bad id
`;
    const errs = errors(parse(md));
    const lines = errs.map((e) => e.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  test("parses identically whether the source uses LF or CRLF line endings", () => {
    const lf = `# Workflow: Demo

## Step: One
Step ID: one

### Instructions
Do it.
`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const lfResult = parse(lf);
    const crlfResult = parse(crlf);
    expect(lfResult.ok).toBe(true);
    expect(crlfResult.ok).toBe(true);
    if (lfResult.ok && crlfResult.ok) {
      expect(crlfResult.document.title).toBe(lfResult.document.title);
      expect(crlfResult.document.steps.map((s) => s.id)).toEqual(lfResult.document.steps.map((s) => s.id));
      expect(crlfResult.document.steps[0].instructions.text).toBe(lfResult.document.steps[0].instructions.text);
    }
  });
});
