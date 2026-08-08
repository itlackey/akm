// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `parseWorkflow` bounds its diagnostic OUTPUT, not just its input.
 *
 * The resource limits cap the document (256 steps, 64 params, 1 MiB of
 * source), but the error list was unbounded, so one badly-malformed large
 * workflow buried its first real problem under hundreds of lines of its own
 * fallout. The reporting boundary now keeps the first
 * `WORKFLOW_MAX_REPORTED_ERRORS` (they are line-sorted, so those are the ones
 * to fix first) and appends an explicit trailer — truncation is never silent,
 * and never changes `ok: false`.
 */

import { describe, expect, test } from "bun:test";
import { parseWorkflow, WORKFLOW_MAX_REPORTED_ERRORS } from "../../src/workflows/parser";

/** A workflow whose every step declares an unknown key — one error per step. */
function workflowWithBrokenSteps(count: number): string {
  const steps: string[] = [];
  for (let i = 0; i < count; i++) {
    steps.push(`  - id: step_${i}`, `    bogus_key: true`);
  }
  const body: string[] = [];
  for (let i = 0; i < count; i++) body.push(`## step_${i}`, "", "Do it.", "");
  return ["---", "type: workflow", "steps:", ...steps, "---", "", ...body].join("\n");
}

function parseErrors(markdown: string): Array<{ line: number; message: string }> {
  const result = parseWorkflow(markdown, { path: "workflows/many-errors.md" });
  return result.ok ? [] : result.errors;
}

const TRAILER = /more errors? not shown/;

describe("parseWorkflow — diagnostic cap", () => {
  test("under the cap: every error is reported, with no trailer", () => {
    const count = 5;
    const errors = parseErrors(workflowWithBrokenSteps(count));
    expect(errors).toHaveLength(count);
    expect(errors.some((e) => TRAILER.test(e.message))).toBe(false);
    expect(errors.every((e) => e.message.includes('Unknown Step "step_'))).toBe(true);
  });

  test("exactly at the cap: still no trailer", () => {
    const errors = parseErrors(workflowWithBrokenSteps(WORKFLOW_MAX_REPORTED_ERRORS));
    expect(errors).toHaveLength(WORKFLOW_MAX_REPORTED_ERRORS);
    expect(errors.some((e) => TRAILER.test(e.message))).toBe(false);
  });

  test("over the cap: the first N survive and an explicit trailer names the remainder", () => {
    const count = WORKFLOW_MAX_REPORTED_ERRORS + 25;
    const errors = parseErrors(workflowWithBrokenSteps(count));

    expect(errors).toHaveLength(WORKFLOW_MAX_REPORTED_ERRORS + 1);
    const trailer = errors[errors.length - 1]!;
    expect(TRAILER.test(trailer.message)).toBe(true);
    expect(trailer.message).toContain("25 more errors not shown");
    expect(trailer.message).toContain(`${count} total`);
    expect(trailer.message).toContain(`capped at ${WORKFLOW_MAX_REPORTED_ERRORS}`);
    expect(trailer.line).toBeGreaterThan(0);

    // The KEPT errors are the earliest ones — the first step's error is present
    // and the last step's is not (they arrive sorted by line).
    expect(errors[0]!.message).toContain('"step_0"');
    expect(errors.some((e) => e.message.includes(`"step_${count - 1}"`))).toBe(false);
    const kept = errors.slice(0, WORKFLOW_MAX_REPORTED_ERRORS);
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i]!.line).toBeGreaterThanOrEqual(kept[i - 1]!.line);
    }
  });

  test("truncation does not change failure semantics", () => {
    const result = parseWorkflow(workflowWithBrokenSteps(WORKFLOW_MAX_REPORTED_ERRORS + 10), {
      path: "workflows/many-errors.md",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  test("a clean workflow is unaffected by the cap", () => {
    const markdown = ["---", "type: workflow", "steps:", "  - id: only", "---", "", "## only", "", "Do it.", ""].join(
      "\n",
    );
    expect(parseWorkflow(markdown, { path: "workflows/clean.md" }).ok).toBe(true);
  });
});
