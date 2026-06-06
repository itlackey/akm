// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { type SummaryJudge, validateStepSummary } from "../../src/workflows/validate-summary";

const input = {
  stepTitle: "Validate release",
  completionCriteria: ["Release notes reviewed", "Version matches tag"],
  summary: "I reviewed the release notes and confirmed the version matches the tag.",
};

describe("validateStepSummary (#506 — completion-criteria gate)", () => {
  test("skips (fail-open) when there are no completion criteria", async () => {
    const result = await validateStepSummary({ ...input, completionCriteria: [] }, async () => "unused");
    expect(result).toEqual({ complete: true, missing: [], skipped: true });
  });

  test("skips (fail-open) when no judge is available", async () => {
    const result = await validateStepSummary(input, undefined);
    expect(result.complete).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("passes when the judge returns complete:true", async () => {
    const judge: SummaryJudge = async () => '{"complete": true, "missing": [], "feedback": ""}';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  test("fails with structured corrective feedback when the judge returns complete:false", async () => {
    const judge: SummaryJudge = async () =>
      '{"complete": false, "missing": ["Version matches tag"], "feedback": "Confirm the tagged version explicitly."}';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["Version matches tag"]);
    expect(result.feedback).toBe("Confirm the tagged version explicitly.");
  });

  test("tolerates code-fenced JSON from the model", async () => {
    const judge: SummaryJudge = async () =>
      '```json\n{"complete": false, "missing": ["Release notes reviewed"], "feedback": "Review notes."}\n```';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["Release notes reviewed"]);
  });

  test("fails open when the judge throws (LLM unreachable)", async () => {
    const judge: SummaryJudge = async () => {
      throw new Error("network down");
    };
    const result = await validateStepSummary(input, judge);
    expect(result).toEqual({ complete: true, missing: [], skipped: true });
  });

  test("fails open when the model returns unparseable output", async () => {
    const judge: SummaryJudge = async () => "totally not json";
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("synthesizes feedback when the model omits it", async () => {
    const judge: SummaryJudge = async () => '{"complete": false, "missing": ["X"]}';
    const result = await validateStepSummary(input, judge);
    expect(result.complete).toBe(false);
    expect(typeof result.feedback).toBe("string");
    expect(result.feedback?.length).toBeGreaterThan(0);
  });
});
