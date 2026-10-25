// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A harness takes no connection or inference of its own: inference for opencode
 * belongs in opencode's own config, and an improve process's `llm` overlay carries
 * it into model work. A key a harness does not read is warned about once and
 * ignored; it never fails the load.
 */

import { describe, expect, test } from "bun:test";
import { parseAndValidateConfigText } from "../src/core/config/config";
import { validateConfigShape } from "../src/core/config/config-schema";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";

function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    run();
  } finally {
    _setWarnSinkForTests(undefined);
  }
  return warnings;
}

test.each([
  "endpoint",
  "apiKey",
  "temperature",
  "maxTokens",
  "contextLength",
  "reasoning_effort",
])("%s is not read by a harness: the load warns once and ignores it", (key) => {
  const text = JSON.stringify({ configVersion: "0.9.0", harnesses: { opencode: { [key]: "x" } } });
  const warnings = captureWarnings(() => {
    expect(() => parseAndValidateConfigText(text)).not.toThrow();
  });
  expect(warnings.filter((w) => w.includes(`harnesses.opencode.${key}`) && w.includes("ignored"))).toHaveLength(1);
});

// `agent` names the harness's default native agent, so it needs a platform that can run one.
describe("a harness's default agent", () => {
  const configWith = (platform: string, agent: string) => ({
    configVersion: "0.9.0" as const,
    semanticSearchMode: "off" as const,
    harnesses: { h: { platform: platform as "claude", agent } },
  });

  test.each(["opencode", "claude"])("is used on %s", (platform) => {
    const runner = resolveTarget({ config: configWith(platform, "akm-workflow"), layers: [] });
    expect(runner).toMatchObject({ kind: "harness", agent: "akm-workflow" });
  });

  test("is rejected by the schema when empty", () => {
    expect(validateConfigShape(configWith("opencode", "")).ok).toBe(false);
  });

  test("is warned about once and ignored on a harness with no native agent selector", () => {
    const warnings = captureWarnings(() => {
      const runner = resolveTarget({ config: configWith("codex", "x"), layers: [] });
      expect(runner).not.toHaveProperty("agent");
    });
    expect(warnings.some((w) => w.includes('Harness "h"') && w.includes("no native agents"))).toBe(true);
  });
});

describe("a harness's models", () => {
  const configWith = (models: unknown) => ({
    configVersion: "0.9.0" as const,
    semanticSearchMode: "off" as const,
    harnesses: { claude: { models } },
  });

  test("map an alias to a model name", () => {
    expect(validateConfigShape(configWith({ fast: "claude-haiku-4-5" })).ok).toBe(true);
  });

  test("take no request fields: an entry that is an object is refused", () => {
    expect(validateConfigShape(configWith({ fast: { model: "claude-haiku-4-5", temperature: 0.2 } })).ok).toBe(false);
  });
});
