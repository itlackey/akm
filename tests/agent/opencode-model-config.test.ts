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
  opencodeCarriedKeys,
  opencodeInferenceConfig,
  opencodeModelConfig,
  splitOpencodeModel,
} from "../../src/integrations/harnesses/opencode/model-config";

const ALL = {
  temperature: 0.2,
  reasoningEffort: "low",
  enableThinking: false,
  maxTokens: 4096,
  contextLength: 120000,
} as const;

describe("carriedInference", () => {
  test("carries temperature, reasoningEffort and enableThinking, and the limit as one pair", () => {
    const { carried, keys } = carriedInference(ALL);

    expect(carried).toEqual({
      temperature: 0.2,
      reasoningEffort: "low",
      enableThinking: false,
      limit: { context: 120000, output: 4096 },
    });
    expect(keys).toEqual(["temperature", "reasoningEffort", "enableThinking", "maxTokens", "contextLength"]);
  });

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

  test("no inference carries nothing", () => {
    expect(carriedInference(undefined)).toEqual({ carried: {}, keys: [] });
    expect(carriedInference(null)).toEqual({ carried: {}, keys: [] });
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

describe("opencodeCarriedKeys", () => {
  test("with a model to attach to, every carried key is carried, model work or not", () => {
    for (const modelWork of [false, true]) {
      expect(opencodeCarriedKeys(true, ALL, modelWork)).toEqual([
        "temperature",
        "reasoningEffort",
        "enableThinking",
        "maxTokens",
        "contextLength",
      ]);
    }
  });

  test("without one, an ordinary dispatch carries nothing", () => {
    expect(opencodeCarriedKeys(false, ALL, false)).toEqual([]);
  });

  // The model-work agent is akm's own and runs whichever model opencode picks,
  // so it carries the options without a model named. The limit is the model's.
  test("without one, model work carries its options but not the limit", () => {
    expect(opencodeCarriedKeys(false, ALL, true)).toEqual(["temperature", "reasoningEffort", "enableThinking"]);
  });
});

describe("opencodeInferenceConfig", () => {
  test("an ordinary dispatch puts the options and the limit on the model", () => {
    expect(opencodeInferenceConfig(ALL, false)).toEqual({
      entry: {
        options: {
          temperature: 0.2,
          reasoningEffort: "low",
          chat_template_kwargs: { enable_thinking: false },
          enable_thinking: false,
        },
        limit: { context: 120000, output: 4096 },
      },
    });
  });

  // opencode makes calls of its own on the same model (a title for the
  // session) and applies the model's options to them. The model-work agent is
  // akm's own, so its options reach only the work.
  test("model work puts the options on the confined agent and only the limit on the model", () => {
    expect(opencodeInferenceConfig(ALL, true)).toEqual({
      entry: { limit: { context: 120000, output: 4096 } },
      agentOptions: {
        temperature: 0.2,
        reasoningEffort: "low",
        chat_template_kwargs: { enable_thinking: false },
        enable_thinking: false,
      },
    });
  });

  test("enableThinking is sent in both forms the LLM transport sends", () => {
    for (const enableThinking of [true, false]) {
      expect(opencodeInferenceConfig({ enableThinking }, false).entry).toEqual({
        options: { chat_template_kwargs: { enable_thinking: enableThinking }, enable_thinking: enableThinking },
      });
    }
  });

  test("camelCase reasoningEffort, never opencode's dropped snake_case spelling", () => {
    const options = (opencodeInferenceConfig({ reasoningEffort: "none" }, false).entry.options ?? {}) as Record<
      string,
      unknown
    >;

    expect(options).toEqual({ reasoningEffort: "none" });
    expect(options).not.toHaveProperty("reasoning_effort");
  });

  test("nothing to carry is an empty entry, and no agent options", () => {
    expect(opencodeInferenceConfig(undefined, false)).toEqual({ entry: {} });
    expect(opencodeInferenceConfig({ topP: 0.9 }, true)).toEqual({ entry: {} });
  });
});

describe("opencodeModelConfig", () => {
  test("gives the model's entry under its provider, splitting at the first slash", () => {
    expect(opencodeModelConfig("krang/chat/qwen3.8-27b", { limit: { context: 1, output: 1 } })).toEqual({
      provider: { krang: { models: { "chat/qwen3.8-27b": { limit: { context: 1, output: 1 } } } } },
    });
  });

  test("is undefined without a provider/model or an entry", () => {
    expect(opencodeModelConfig(undefined, { options: {} })).toBeUndefined();
    expect(opencodeModelConfig("unqualified", { options: {} })).toBeUndefined();
    expect(opencodeModelConfig("krang/model", {})).toBeUndefined();
  });
});
