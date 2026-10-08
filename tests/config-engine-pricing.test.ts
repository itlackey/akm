// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `engines.<name>.pricing` is the optional per-million-token price `akm metrics`
 * turns into a cost estimate. Both engine kinds take it; prices are
 * non-negative finite numbers and the currency is a non-empty string.
 */

import { describe, expect, test } from "bun:test";
import { validateConfigShape } from "../src/core/config/config-schema";

const LLM = { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "m" };
const AGENT = { kind: "agent", platform: "claude" };

function errorsFor(engine: Record<string, unknown>): { path: string; message: string }[] {
  const result = validateConfigShape({ configVersion: "0.9.0", engines: { e: engine } });
  return result.ok ? [] : result.errors;
}

describe("engines.<name>.pricing", () => {
  test.each([
    ["llm", LLM],
    ["agent", AGENT],
  ])("a %s engine accepts input and output prices with an optional currency", (_kind, engine) => {
    expect(errorsFor({ ...engine, pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 } })).toEqual([]);
    expect(errorsFor({ ...engine, pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: "EUR" } })).toEqual([]);
  });

  // The engine is a union of the llm and agent shapes, so a bad field is reported
  // against the engine as a whole rather than the field.
  test.each([
    { inputPerMillion: -1, outputPerMillion: 1 },
    { inputPerMillion: 1, outputPerMillion: Number.POSITIVE_INFINITY },
    { inputPerMillion: 1 },
    { outputPerMillion: 1 },
    { inputPerMillion: 1, outputPerMillion: 1, currency: "" },
  ])("rejects %j", (pricing) => {
    expect(errorsFor({ ...LLM, pricing })).not.toEqual([]);
    expect(errorsFor({ ...AGENT, pricing })).not.toEqual([]);
  });
});
