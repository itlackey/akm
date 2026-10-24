// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a request's inference becomes the OpenCode model entry akm declares
 * (`opencode-sdk/model-entry.ts`). The SDK runner tests assert it where it is
 * used.
 */

import { describe, expect, test } from "bun:test";
import { opencodeModelEntry } from "../../src/integrations/harnesses/opencode-sdk/model-entry";

describe("opencodeModelEntry", () => {
  // opencode refuses `limit` with only one of context and output, so akm declares it only when it has both.
  test.each([
    ["maxTokens", { maxTokens: 4096 }],
    ["contextLength", { contextLength: 120000 }],
  ])("%s alone declares no limit", (_key, inference) => {
    expect(opencodeModelEntry(inference)).toEqual({});
  });

  test("a value of the wrong type is left out", () => {
    expect(
      opencodeModelEntry({
        temperature: "hot",
        reasoningEffort: "",
        enableThinking: "no",
        maxTokens: 0,
        contextLength: 1.5,
      }),
    ).toEqual({});
  });

  test("enableThinking is sent in both forms the LLM transport sends", () => {
    for (const enableThinking of [true, false]) {
      expect(opencodeModelEntry({ enableThinking })).toEqual({
        options: { chat_template_kwargs: { enable_thinking: enableThinking }, enable_thinking: enableThinking },
      });
    }
  });

  test("a key opencode has no setting for, or no inference at all, carries nothing", () => {
    expect(opencodeModelEntry({ topP: 0.9, extraParams: { seed: 1 } })).toEqual({});
    expect(opencodeModelEntry(undefined)).toEqual({});
    expect(opencodeModelEntry(null)).toEqual({});
  });
});

test("temperature, reasoning effort and a full limit all land on the model entry", () => {
  expect(
    opencodeModelEntry({ temperature: 0.2, reasoningEffort: "low", maxTokens: 4096, contextLength: 120000 }),
  ).toEqual({
    options: { temperature: 0.2, reasoningEffort: "low" },
    limit: { context: 120000, output: 4096 },
  });
});
