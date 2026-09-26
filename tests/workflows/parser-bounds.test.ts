// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bug 9 regression — decoder-only bounds are now enforced at the PARSER layer
 * with line-anchored, fix-in-the-message errors, from the shared constants in
 * `src/workflows/resource-limits.ts` (the frozen-plan decoder keeps enforcing
 * the same values as the corruption gate). Before this, `akm lint` and
 * `workflow create` passed and `workflow run` failed at freeze/decode with a
 * terse, unlocated "Invalid frozen workflow plan: …".
 */

import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../../src/workflows/parser";
import { WORKFLOW_MAX_CONCURRENCY, WORKFLOW_MAX_TIMEOUT_MS } from "../../src/workflows/resource-limits";
import { parseErrors, workflowDoc as workflowWith } from "../_helpers/workflow";

describe("bug 9 — parser enforces the decoder's bounds with line anchors", () => {
  test("gate.max_loops has no authoring-time ceiling; any positive integer parses", () => {
    const markdown = workflowWith(["    gate: { max_loops: 100000 }"]);
    expect(parseErrors(markdown)).toHaveLength(0);
  });

  test("gate.max_loops still rejects a non-positive value", () => {
    const markdown = workflowWith(["    gate: { max_loops: 0 }"]);
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`"gate.max_loops" must be an integer of at least 1`);
  });

  test("map.concurrency above the shared bound is CLAMPED to it, not rejected", () => {
    const markdown = workflowWith([
      "    map:",
      "      over: params.items",
      `      concurrency: ${WORKFLOW_MAX_CONCURRENCY + 1}`,
    ]);
    const result = parseWorkflow(markdown, { path: "workflows/test.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected parse to succeed");
    expect(result.plan.steps[0]!.spec?.map?.concurrency).toBe(WORKFLOW_MAX_CONCURRENCY);
  });

  test("map.concurrency at the bound still parses unclamped", () => {
    const markdown = workflowWith([
      "    map:",
      "      over: params.items",
      `      concurrency: ${WORKFLOW_MAX_CONCURRENCY}`,
    ]);
    expect(parseErrors(markdown)).toHaveLength(0);
  });

  test("retry.max has no authoring-time ceiling; any non-negative integer parses", () => {
    const markdown = workflowWith(["    unit: { retry: { max: 100000, on: [timeout] } }"]);
    expect(parseErrors(markdown)).toHaveLength(0);
  });

  test("retry.max still rejects a negative value", () => {
    const markdown = workflowWith(["    unit: { retry: { max: -1, on: [timeout] } }"]);
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`"retry.max" is required and must be a non-negative integer`);
  });

  test("a timeout above the 32-bit millisecond ceiling is a line-anchored parser error", () => {
    // 40000 minutes = 2.4e9 ms > 2^31-1.
    const markdown = workflowWith([`    unit: { timeout: 40000m }`]);
    const errors = parseErrors(markdown);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(5);
    expect(errors[0]!.message).toContain(`above the maximum of ${WORKFLOW_MAX_TIMEOUT_MS} ms`);
    expect(errors[0]!.message).toContain(`"none"`);
  });

  test("a bare-integer timeout above the ceiling is also rejected; the ceiling itself passes", () => {
    expect(parseErrors(workflowWith([`    unit: { timeout: ${WORKFLOW_MAX_TIMEOUT_MS + 1} }`]))).toHaveLength(1);
    expect(parseErrors(workflowWith([`    unit: { timeout: ${WORKFLOW_MAX_TIMEOUT_MS} }`]))).toHaveLength(0);
  });

  test("an engine name outside the frozen-plan grammar is a line-anchored parser error (unit and defaults)", () => {
    const unitCase = parseErrors(workflowWith([`    unit: { engine: My_Engine }`]));
    expect(unitCase).toHaveLength(1);
    expect(unitCase[0]!.line).toBe(5);
    expect(unitCase[0]!.message).toContain(`invalid engine name "My_Engine"`);
    expect(unitCase[0]!.message).toContain("lowercase");

    const markdown = workflowWith([], undefined, ["defaults:", "  engine: UPPER"]);
    const defaultsCase = parseErrors(markdown);
    expect(defaultsCase).toHaveLength(1);
    expect(defaultsCase[0]!.line).toBe(4);
    expect(defaultsCase[0]!.message).toContain(`"defaults.engine" has an invalid engine name "UPPER"`);
  });

  test("an over-long engine name is rejected; a valid dash-separated name passes", () => {
    const longName = `a${"-b".repeat(40)}`; // 81 chars, pattern-valid but over 63
    expect(parseErrors(workflowWith([`    unit: { engine: ${longName} }`]))).toHaveLength(1);
    expect(parseErrors(workflowWith([`    unit: { engine: code-review-llm }`]))).toHaveLength(0);
  });
});
