// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #852 / #1091: a 0.9.1-shaped config using the documented
// `extraParams.reasoning_effort` workaround is older than the 0.9.15 floor.
// 0.10 does not lift it onto the first-class field; the load is refused and
// the error names the field to set. `akm migrate apply` under akm 0.9.x is
// what rewrites such a file. `parseAndValidateConfigText` is pure (no
// filesystem), so these run directly against it.
import { describe, expect, test } from "bun:test";
import { parseAndValidateConfigText } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";

function configWithEngine(engine: Record<string, unknown>): string {
  return JSON.stringify({
    configVersion: "0.9.0",
    engines: {
      default: {
        kind: "llm",
        endpoint: "https://example.com/v1/chat/completions",
        model: "test-model",
        ...engine,
      },
    },
  });
}

function expectThrows(text: string): string {
  try {
    parseAndValidateConfigText(text);
    throw new Error("expected parseAndValidateConfigText to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return String(err);
  }
}

describe("a pre-0.9.15 extraParams key that shadows a first-class engine field is refused, not lifted", () => {
  test.each([
    ["reasoning_effort", "none", "reasoningEffort"],
    ["temperature", 0.2, "temperature"],
    ["maxtokens", 512, "maxTokens"],
    ["enable_thinking", true, "enableThinking"],
  ])("extraParams.%s names engines.<name>.%s", (key, value, field) => {
    const message = expectThrows(configWithEngine({ extraParams: { [key]: value } }));
    expect(message).toContain("is protected by AKM");
    expect(message).toContain(`set engines.<name>.${field} instead`);
  });

  test("a protected key with no first-class equivalent is refused, and the error names the remedy", () => {
    const message = expectThrows(configWithEngine({ extraParams: { stream: true } }));
    expect(message).toContain("stream is protected by AKM");
    expect(message).toContain("AKM controls streaming internally");
  });
});
