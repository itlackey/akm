// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An agent engine may set the inference fields its platform translates
 * (`inference` in `harnesses/ids.ts`, pinned to each lowerer by the contract
 * suite) and no others. An asset's or a caller's inference reaches every engine
 * and reports what the engine does not translate as a lowering notice; an
 * engine the operator configures for a platform names only what that platform
 * carries, so the rest is a config error that names the platform.
 */

import { describe, expect, test } from "bun:test";
import { validateConfigShape } from "../src/core/config/config-schema";
import { HARNESS_ID_TABLE } from "../src/integrations/harnesses/ids";

const VALUES = {
  temperature: 0.2,
  maxTokens: 4096,
  contextLength: 120000,
  enableThinking: false,
  reasoningEffort: "high",
} as const;
type InferenceKey = keyof typeof VALUES;

function errorsFor(engine: Record<string, unknown>): { path: string; message: string }[] {
  const result = validateConfigShape({ configVersion: "0.9.0", engines: { e: engine } });
  return result.ok ? [] : result.errors;
}

const ROWS = HARNESS_ID_TABLE.flatMap((entry) =>
  (Object.keys(VALUES) as InferenceKey[]).map((key): [string, InferenceKey, boolean] => [
    entry.id,
    key,
    entry.inference.includes(key),
  ]),
);

describe("agent engine inference fields", () => {
  test.each(ROWS)("%s: %s", (platform, key, translated) => {
    const errors = errorsFor({ kind: "agent", platform, [key]: VALUES[key] });

    if (translated) {
      expect(errors).toEqual([]);
      return;
    }
    const entry = HARNESS_ID_TABLE.find((candidate) => candidate.id === platform);
    const carries =
      (entry?.inference.length ?? 0) > 0
        ? `the platform translates only ${entry?.inference.join(", ")}`
        : "the platform translates no inference fields";
    expect(errors).toEqual([
      { path: `engines.e.${key}`, message: `${key} is not valid on a ${platform} engine: ${carries}` },
    ]);
  });

  test("opencode, opencode-sdk and claude translate something, and the rest nothing", () => {
    const translating = HARNESS_ID_TABLE.filter((entry) => entry.inference.length > 0).map((entry) => entry.id);

    expect(translating.sort()).toEqual(["claude", "opencode", "opencode-sdk"]);
  });

  test("every field at once on opencode", () => {
    expect(errorsFor({ kind: "agent", platform: "opencode", ...VALUES })).toEqual([]);
  });

  test("a field of the wrong type is rejected, as on an LLM engine", () => {
    for (const bad of [{ temperature: "hot" }, { maxTokens: 0 }, { enableThinking: "no" }, { reasoningEffort: "" }]) {
      expect(errorsFor({ kind: "agent", platform: "opencode", ...bad })).not.toEqual([]);
    }
  });

  // These describe a connection or a wire format, which no agent platform has.
  test.each([
    ["provider", "openai"],
    ["endpoint", "https://example.test/v1/chat/completions"],
    ["apiKey", "$KEY"],
    ["apiKeyFile", "~/key"],
    ["concurrency", 2],
    ["extraParams", { seed: 1 }],
  ])("%s is still not valid on an agent engine", (key, value) => {
    expect(errorsFor({ kind: "agent", platform: "opencode", [key]: value })).toEqual([
      { path: `engines.e.${key}`, message: `${key} is not valid on an agent engine` },
    ]);
  });

  test("an LLM engine still takes every field", () => {
    expect(
      errorsFor({ kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "m", ...VALUES }),
    ).toEqual([]);
  });
});
