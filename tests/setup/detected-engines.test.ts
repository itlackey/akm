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

  test("uses stable numeric collision suffixes and finds the suffix on rerun", () => {
    const config: AkmConfig = {
      ...base(),
      engines: { local: { kind: "agent", platform: "claude" } },
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
    expect(second).toMatchObject({ name: "local-2", reused: true });
    expect(second.config.engines?.["local-2"]).toEqual(first.config.engines?.["local-2"]);
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
