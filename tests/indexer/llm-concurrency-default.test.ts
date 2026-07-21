// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pins the LLM-enrichment concurrency defaults (owner ruling 2026-07-21):
 * 2 for remote endpoints, 1 for local model servers and unset endpoints,
 * with an explicit `llm.concurrency` overriding both.
 */

import { describe, expect, test } from "bun:test";
import type { LlmConnectionConfig } from "../../src/core/config/config";
import { getDefaultLlmConcurrency } from "../../src/indexer/indexer";

function conn(endpoint: string, concurrency?: number): LlmConnectionConfig {
  return {
    provider: "openai-compatible",
    endpoint,
    model: "test-model",
    ...(concurrency !== undefined ? { concurrency } : {}),
  } as LlmConnectionConfig;
}

describe("getDefaultLlmConcurrency", () => {
  test("remote endpoints default to 2", () => {
    expect(getDefaultLlmConcurrency(conn("https://api.anthropic.com/v1/messages"))).toBe(2);
    expect(getDefaultLlmConcurrency(conn("https://api.example.com/v1/chat/completions"))).toBe(2);
  });

  test("local model servers default to 1", () => {
    expect(getDefaultLlmConcurrency(conn("http://localhost:11434/v1/chat/completions"))).toBe(1);
    expect(getDefaultLlmConcurrency(conn("http://127.0.0.1:1234/v1"))).toBe(1);
    expect(getDefaultLlmConcurrency(conn("http://[::1]:8080/v1"))).toBe(1);
    expect(getDefaultLlmConcurrency(conn("http://lmstudio.localhost/v1"))).toBe(1);
  });

  test("missing config or endpoint defaults to 1", () => {
    expect(getDefaultLlmConcurrency(undefined)).toBe(1);
    expect(getDefaultLlmConcurrency(conn(""))).toBe(1);
  });

  test("unparseable endpoint defaults to 1", () => {
    expect(getDefaultLlmConcurrency(conn("not a url"))).toBe(1);
  });

  test("explicit llm.concurrency overrides both defaults", () => {
    expect(getDefaultLlmConcurrency(conn("https://api.example.com/v1", 8))).toBe(8);
    expect(getDefaultLlmConcurrency(conn("http://localhost:11434/v1", 3))).toBe(3);
  });
});
