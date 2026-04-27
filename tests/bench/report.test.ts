/**
 * Unit tests for the JSON + markdown report renderers.
 */

import { describe, expect, test } from "bun:test";

import { type ReportInput, renderJsonReport, renderMarkdownSummary } from "./report";

const sample: ReportInput = {
  timestamp: "2026-04-27T12:00:00Z",
  branch: "feature/akm-bench",
  commit: "deadbeef",
  model: "anthropic/claude-opus-4-7",
  track: "utility",
  arms: {
    noakm: { passRate: 0.4, tokensPerPass: 18000, wallclockMs: 41000, budgetExceeded: 0 },
    akm: { passRate: 0.7, tokensPerPass: 14000, wallclockMs: 36000, budgetExceeded: 1 },
  },
};

describe("renderJsonReport", () => {
  test("stamps timestamp, branch, commit, and model", () => {
    const json = renderJsonReport(sample);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.timestamp).toBe(sample.timestamp);
    expect(parsed.branch).toBe(sample.branch);
    expect(parsed.commit).toBe(sample.commit);
    expect(parsed.track).toBe("utility");
    expect((parsed.agent as { harness: string }).harness).toBe("opencode");
    expect((parsed.agent as { model: string }).model).toBe(sample.model);
  });

  test("includes arm aggregates verbatim", () => {
    const json = renderJsonReport(sample);
    const parsed = JSON.parse(json) as { aggregate: Record<string, { passRate: number }> };
    expect(parsed.aggregate.noakm.passRate).toBeCloseTo(0.4);
    expect(parsed.aggregate.akm.passRate).toBeCloseTo(0.7);
  });
});

describe("renderMarkdownSummary", () => {
  test("produces a roughly 5-line summary with the model + arm rows", () => {
    const md = renderMarkdownSummary(sample);
    const lines = md.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(md).toContain(sample.model);
    expect(md).toContain("noakm");
    expect(md).toContain("akm");
    expect(md).toContain("pass_rate=");
  });
});
