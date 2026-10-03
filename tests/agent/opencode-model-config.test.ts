// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a request's inference becomes opencode config (`model-config.ts`). The
 * shapes asserted here were each checked against opencode 1.18.25 and a local
 * OpenAI-compatible stub; see the module comment for what opencode does with
 * them.
 */

import { describe, expect, test } from "bun:test";
import {
  carriedInference,
  opencodeInferenceConfig,
  opencodeModelConfig,
  splitOpencodeModel,
} from "../../src/integrations/harnesses/opencode/model-config";

describe("carriedInference", () => {
  // opencode refuses `limit` with only one of context and output, and the
  // entry merges over the user's own, so half a limit would overwrite the
  // other half of one the user declared.
  test.each([
    ["maxTokens", { maxTokens: 4096 }],
    ["contextLength", { contextLength: 120000 }],
  ])("%s alone is not carried", (key, inference) => {
    const { carried, keys } = carriedInference(inference);

    expect(carried).toEqual({});
    expect(keys).not.toContain(key);
  });

  test("a value of the wrong type is not carried", () => {
    const { carried, keys } = carriedInference({
      temperature: "hot",
      reasoningEffort: "",
      enableThinking: "no",
      maxTokens: 0,
      contextLength: 1.5,
    });

    expect(carried).toEqual({});
    expect(keys).toEqual([]);
  });

  test("an explicit null clears a field: nothing is carried, and nothing is left untranslated", () => {
    const { carried, keys } = carriedInference({ temperature: null, reasoningEffort: null, maxTokens: null });

    expect(carried).toEqual({});
    expect(keys).toEqual(["temperature", "reasoningEffort", "maxTokens"]);
  });

  test("keys opencode has no setting for are not carried", () => {
    expect(carriedInference({ topP: 0.9, extraParams: { seed: 1 }, supportsJsonSchema: true })).toEqual({
      carried: {},
      keys: [],
    });
  });
});

describe("splitOpencodeModel", () => {
  test("splits at the first slash, as opencode does, so a model id may contain slashes", () => {
    expect(splitOpencodeModel("krang/chat/qwen3.8-27b")).toEqual({ providerID: "krang", modelID: "chat/qwen3.8-27b" });
    expect(splitOpencodeModel("openai/gpt-5.6-terra")).toEqual({ providerID: "openai", modelID: "gpt-5.6-terra" });
  });

  test.each(["gpt", "/gpt", "openai/", ""])("%j is not a provider/model", (model) => {
    expect(splitOpencodeModel(model)).toBeUndefined();
  });
});

describe("opencodeInferenceConfig", () => {
  test("enableThinking is sent in both forms the LLM transport sends", () => {
    for (const enableThinking of [true, false]) {
      expect(opencodeInferenceConfig({ enableThinking }, false).entry).toEqual({
        options: { chat_template_kwargs: { enable_thinking: enableThinking }, enable_thinking: enableThinking },
      });
    }
  });

  test("nothing to carry is an empty entry, and no agent options", () => {
    expect(opencodeInferenceConfig(undefined, false)).toEqual({ entry: {} });
    expect(opencodeInferenceConfig({ topP: 0.9 }, true)).toEqual({ entry: {} });
  });
});

describe("opencodeModelConfig", () => {
  test("is undefined without a provider/model or an entry", () => {
    expect(opencodeModelConfig(undefined, { options: {} })).toBeUndefined();
    expect(opencodeModelConfig("unqualified", { options: {} })).toBeUndefined();
    expect(opencodeModelConfig("krang/model", {})).toBeUndefined();
  });
});
