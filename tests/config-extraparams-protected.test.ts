// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #852: an asset's `extraParams` (a workflow unit's `extra_params:`) may not
// shadow a setting akm manages, and the issue names the portable setting to use
// instead. A connection no longer has `extraParams` at all: its request fields
// are written directly and sent as written.
import { describe, expect, test } from "bun:test";
import { formatExtraParamsIssue, validateExtraParams } from "../src/core/extra-params";

function firstIssue(extraParams: Record<string, unknown>): string {
  const issue = validateExtraParams(extraParams)[0];
  if (!issue) throw new Error("expected extraParams to be refused");
  return formatExtraParamsIssue("extraParams", issue);
}

describe("an extraParams key that shadows a portable setting is refused, naming the setting", () => {
  test.each([
    ["reasoning_effort", "none", "reasoningEffort"],
    ["temperature", 0.2, "temperature"],
    ["maxtokens", 512, "maxTokens"],
    ["enable_thinking", true, "enableThinking"],
  ])("extraParams.%s names %s", (key, value, field) => {
    const message = firstIssue({ [key]: value });
    expect(message).toContain("is protected by AKM");
    expect(message).toContain(`set ${field} instead`);
  });

  test("a protected key with no portable equivalent is refused, and the error names the remedy", () => {
    const message = firstIssue({ stream: true });
    expect(message).toContain("stream is protected by AKM");
    expect(message).toContain("AKM controls streaming internally");
  });

  test("credential-shaped keys are refused at any depth, inside arrays too", () => {
    expect(validateExtraParams({ nested: { "API-Key": "leak" } })).toHaveLength(1);
    expect(validateExtraParams({ provider: [{ auth: [{ API_KEY: "leak" }] }] })).toHaveLength(1);
  });

  test("chat_template_kwargs is the enableThinking setting's to send", () => {
    expect(firstIssue({ chat_template_kwargs: { enable_thinking: true } })).toContain("set enableThinking instead");
  });
});
