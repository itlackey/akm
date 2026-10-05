// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a request's inference becomes opencode config (`model-config.ts`), where
 * akm writes that config itself. The shapes were checked against opencode
 * 1.18.25 and a local OpenAI-compatible stub; the contract suite and the SDK
 * runner tests assert them where they are used.
 */

import { describe, expect, test } from "bun:test";
import { opencodeInferenceConfig } from "../../src/integrations/harnesses/opencode/model-config";

describe("opencodeInferenceConfig", () => {
  // opencode refuses `limit` with only one of context and output, so akm declares it only when it has both.
  test.each([
    ["maxTokens", { maxTokens: 4096 }],
    ["contextLength", { contextLength: 120000 }],
  ])("%s alone declares no limit", (_key, inference) => {
    expect(opencodeInferenceConfig(inference, false)).toEqual({ entry: {} });
  });

  test("a value of the wrong type is left out", () => {
    expect(
      opencodeInferenceConfig(
        { temperature: "hot", reasoningEffort: "", enableThinking: "no", maxTokens: 0, contextLength: 1.5 },
        false,
      ),
    ).toEqual({ entry: {} });
  });

  test("enableThinking is sent in both forms the LLM transport sends", () => {
    for (const enableThinking of [true, false]) {
      expect(opencodeInferenceConfig({ enableThinking }, false).entry).toEqual({
        options: { chat_template_kwargs: { enable_thinking: enableThinking }, enable_thinking: enableThinking },
      });
    }
  });

  test("a key opencode has no setting for, or no inference at all, carries nothing", () => {
    expect(opencodeInferenceConfig({ topP: 0.9, extraParams: { seed: 1 } }, true)).toEqual({ entry: {} });
    expect(opencodeInferenceConfig(undefined, false)).toEqual({ entry: {} });
    expect(opencodeInferenceConfig(null, true)).toEqual({ entry: {} });
  });
});
