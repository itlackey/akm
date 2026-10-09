// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An agent engine takes no connection or inference of its own: inference for
 * opencode belongs in opencode's own config, and an improve process's `llm`
 * overlay carries it into model work.
 */

import { describe, expect, test } from "bun:test";
import { validateConfigShape } from "../src/core/config/config-schema";

test.each([
  "provider",
  "endpoint",
  "apiKey",
  "apiKeyFile",
  "concurrency",
  "extraParams",
  "temperature",
  "maxTokens",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
])("%s is not valid on an agent engine", (key) => {
  const result = validateConfigShape({
    configVersion: "0.9.0",
    engines: { e: { kind: "agent", platform: "opencode", [key]: "x" } },
  });

  expect(result.ok ? [] : result.errors).toEqual([
    { path: `engines.e.${key}`, message: `${key} is not valid on an agent engine` },
  ]);
});

// `agent` names the engine's default native agent, so it needs a harness that can run one.
describe("an agent engine's default agent", () => {
  const errorsFor = (engine: Record<string, unknown>) => {
    const result = validateConfigShape({ configVersion: "0.9.0", engines: { e: { kind: "agent", ...engine } } });
    return result.ok ? [] : result.errors;
  };

  test.each(["opencode", "opencode-sdk", "claude"])("is accepted on %s", (platform) => {
    expect(errorsFor({ platform, agent: "akm-workflow" })).toEqual([]);
  });

  test("is rejected when empty", () => {
    expect(errorsFor({ platform: "opencode-sdk", agent: "" })).not.toEqual([]);
  });

  test("is rejected on a harness with no native agent selector", () => {
    expect(errorsFor({ platform: "codex", agent: "x" })).toEqual([
      { path: "engines.e.agent", message: "agent is not valid on codex: it has no native agent selector" },
    ]);
  });

  test("is rejected on an llm engine", () => {
    const result = validateConfigShape({
      configVersion: "0.9.0",
      engines: { e: { kind: "llm", endpoint: "https://llm.invalid/v1/chat/completions", model: "m", agent: "x" } },
    });
    expect(result.ok ? [] : result.errors).toEqual([
      { path: "engines.e.agent", message: "agent is not valid on an LLM engine" },
    ]);
  });
});
