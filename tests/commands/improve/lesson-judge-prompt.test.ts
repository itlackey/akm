// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { buildJudgePrompt } from "../../../src/commands/improve/stage";

describe("lesson judge prompt", () => {
  test("REUSABLE credits a tested result with its conditions and limits", () => {
    const prompt = buildJudgePrompt("---\ndescription: d.\n---\n\nbody", "memory");
    expect(prompt).toContain(
      "a tested or measured result about a change or method, stated with the conditions and limits it held under",
    );
  });

  test("REUSABLE scores one run's report with only a suspected cause as not reusable", () => {
    const prompt = buildJudgePrompt("---\ndescription: d.\n---\n\nbody", "memory");
    expect(prompt).toContain("the counts or outcomes of one run");
    expect(prompt).toContain("whose cause is only suspected, with no fix verified");
  });

  test("REUSABLE asks only whether the added lines leave an existing lesson a rule", () => {
    const prompt = buildJudgePrompt("---\ndescription: d.\n---\n\nbody", "memory", undefined, undefined, "existing");
    expect(prompt).toContain("ask only whether the added lines leave it one");
    expect(prompt).not.toContain("only records what was done");
    expect(prompt).not.toContain("a tested or measured result about a change or method");
    expect(prompt).toContain("only records who did something, when, or what shipped");
    expect(prompt).not.toContain("REUSABLE's question");
  });
});
