// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import {
  engineFingerprint,
  normalizeChatCompletionsEndpoint,
  upsertDetectedAgentEngine,
  upsertDetectedLlmEngine,
  verifyOpenAiCompatibleEndpoint,
} from "../../src/setup/detected-engines";
import { withEnv } from "../_helpers/sandbox";

const base = (): AkmConfig => ({ configVersion: "0.9.0", semanticSearchMode: "auto" });

describe("setup detected engine identity", () => {
  test("normalizes full endpoints and fingerprints by endpoint/platform", () => {
    expect(normalizeChatCompletionsEndpoint("http://localhost:11434")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(engineFingerprint({ kind: "llm", endpoint: "http://localhost:11434/v1", model: "m" })).toBe(
      "llm:http://localhost:11434/v1/chat/completions",
    );
    expect(engineFingerprint({ kind: "agent", platform: "claude" })).toBe("agent:claude");
  });

  test("reuses an endpoint fingerprint without changing user tuning or explicit default", () => {
    const config: AkmConfig = {
      ...base(),
      engines: {
        tuned: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "user-model",
          temperature: 0.7,
        },
        other: { kind: "agent", platform: "claude" },
      },
      defaults: { engine: "other", llmEngine: "tuned" },
    };
    const result = upsertDetectedLlmEngine(config, {
      provider: "provider",
      endpoint: "https://example.test/v1",
      model: "detected-model",
    });
    expect(result).toMatchObject({ name: "tuned", reused: true });
    expect(result.config.engines?.tuned).toEqual(config.engines?.tuned);
    expect(result.config.defaults?.engine).toBe("other");
  });

  test("selects a detected LLM as both defaults when no general default exists", () => {
    const result = upsertDetectedLlmEngine(base(), {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "m",
    });
    expect(result.config.defaults).toMatchObject({ engine: result.name, llmEngine: result.name });
  });

  test("promotes the existing LLM default when detecting a secondary LLM", () => {
    const config: AkmConfig = {
      ...base(),
      engines: { cloud: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "m" } },
      defaults: { llmEngine: "cloud" },
    };
    const result = upsertDetectedLlmEngine(config, {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "local-model",
    });
    expect(result.config.defaults).toMatchObject({ engine: "cloud", llmEngine: "cloud" });
  });

  test("uses the first numeric suffix when the preferred name is occupied by another engine kind", () => {
    const config: AkmConfig = {
      ...base(),
      engines: { local: { kind: "agent", platform: "claude" } },
    };
    const result = upsertDetectedLlmEngine(config, {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "m",
    });
    expect(result.name).toBe("local-2");
  });

  test("uses the first-free numeric suffix for same-kind collisions and finds it on rerun", () => {
    const config: AkmConfig = {
      ...base(),
      engines: { local: { kind: "llm", endpoint: "http://localhost:8000/v1", model: "other" } },
    };
    const first = upsertDetectedLlmEngine(config, {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "m",
    });
    expect(first.name).toBe("local-2");
    const second = upsertDetectedLlmEngine(first.config, {
      provider: "local",
      endpoint: "http://localhost:9000/v1/chat/completions",
      model: "changed",
    });
    expect(second).toMatchObject({ name: first.name, reused: true });
    expect(second.config.engines?.[first.name]).toEqual(first.config.engines?.[first.name]);
  });

  test("skips occupied numeric suffixes in order", () => {
    const result = upsertDetectedLlmEngine(
      {
        ...base(),
        engines: {
          local: { kind: "llm", endpoint: "http://localhost:7000/v1", model: "one" },
          "local-2": { kind: "llm", endpoint: "http://localhost:8000/v1", model: "two" },
        },
      },
      { provider: "local", endpoint: "http://localhost:9000/v1", model: "three" },
    );

    expect(result.name).toBe("local-3");
  });

  test("derives the same collision name regardless of unrelated engine insertion order", () => {
    const candidate = { provider: "local", endpoint: "http://localhost:9000/v1", model: "m" };
    const left = upsertDetectedLlmEngine(
      {
        ...base(),
        engines: {
          local: { kind: "llm", endpoint: "http://localhost:8000/v1", model: "other" },
          zed: { kind: "agent", platform: "opencode" },
        },
      },
      candidate,
    );
    const right = upsertDetectedLlmEngine(
      {
        ...base(),
        engines: {
          alpha: { kind: "agent", platform: "claude" },
          local: { kind: "llm", endpoint: "http://localhost:7000/v1", model: "other" },
        },
      },
      candidate,
    );
    expect(right.name).toBe(left.name);
  });

  test("chooses the same fingerprint match regardless of config insertion order", () => {
    const candidate = { provider: "local", endpoint: "http://localhost:9000/v1", model: "detected" };
    const first = upsertDetectedLlmEngine(
      {
        ...base(),
        engines: {
          zed: { kind: "llm", endpoint: candidate.endpoint, model: "z" },
          alpha: { kind: "llm", endpoint: candidate.endpoint, model: "a" },
        },
      },
      candidate,
    );
    expect(first).toMatchObject({ name: "alpha", reused: true });
  });

  test("agent reruns reuse canonical platform and do not replace another explicit default", () => {
    const config: AkmConfig = {
      ...base(),
      engines: {
        reviewer: { kind: "agent", platform: "claude", model: "custom" },
        primary: { kind: "agent", platform: "opencode" },
      },
      defaults: { engine: "primary" },
    };
    const result = upsertDetectedAgentEngine(config, "claude");
    expect(result).toMatchObject({ name: "reviewer", reused: true });
    expect(result.config.engines?.reviewer).toEqual(config.engines?.reviewer);
    expect(result.config.defaults?.engine).toBe("primary");
  });

  test("verification sends the exact bounded OpenAI-compatible request and keeps credentials ephemeral", async () => {
    let observed: RequestInit | undefined;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await withEnv({ TEST_SETUP_KEY: "sentinel" }, () =>
      verifyOpenAiCompatibleEndpoint(
        { endpoint: "https://example.test/v1", model: "m", apiKeyEnvVar: "TEST_SETUP_KEY" },
        fetchFn,
      ),
    );
    expect(result).toEqual({ ok: true, endpoint: "https://example.test/v1/chat/completions" });
    expect(observed?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer sentinel" });
    expect(JSON.parse(String(observed?.body))).toEqual({
      model: "m",
      messages: [{ role: "user", content: "Reply OK" }],
      max_tokens: 1,
      stream: false,
    });
  });
});
