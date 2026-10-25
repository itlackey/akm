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

const lab = (port: number, model = "m") => ({
  endpoint: `http://localhost:${port}/v1`,
  models: { fast: model },
});

describe("setup detected engine identity", () => {
  test("normalizes full endpoints and fingerprints by endpoint/platform", () => {
    expect(normalizeChatCompletionsEndpoint("http://localhost:11434")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(engineFingerprint({ kind: "connection", connection: lab(11434) })).toBe(
      "llm:http://localhost:11434/v1/chat/completions",
    );
    expect(engineFingerprint({ kind: "harness", name: "claude", harness: {} })).toBe("agent:claude");
    expect(engineFingerprint({ kind: "harness", name: "reviewer", harness: { platform: "claude" } })).toBe(
      "agent:claude",
    );
  });

  test("reuses an endpoint fingerprint without changing user tuning or the other entries", () => {
    const config: AkmConfig = {
      ...base(),
      connections: {
        tuned: {
          endpoint: "https://example.test/v1/chat/completions",
          models: { fast: "user-model" },
          temperature: 0.7,
        },
      },
      harnesses: { other: { platform: "claude" } },
    };
    const result = upsertDetectedLlmEngine(config, {
      provider: "provider",
      endpoint: "https://example.test/v1",
      model: "detected-model",
    });
    expect(result).toMatchObject({ name: "tuned", reused: true });
    expect(result.config.connections?.tuned).toEqual(config.connections?.tuned);
    expect(result.config.harnesses).toEqual(config.harnesses);
  });

  test("the first detected connection is named default and carries the model under every standard alias", () => {
    const result = upsertDetectedLlmEngine(base(), {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "m",
      apiKeyEnvVar: "LOCAL_KEY",
    });
    expect(result).toMatchObject({ name: "default", reused: false });
    expect(result.config.connections).toEqual({
      default: {
        endpoint: "http://localhost:9000/v1/chat/completions",
        models: { fast: "m", balanced: "m", reasoning: "m" },
        apiKey: "$LOCAL_KEY",
      },
    });
  });

  test("a second detected connection is named for its provider and the existing default stays", () => {
    const config: AkmConfig = {
      ...base(),
      connections: { default: { endpoint: "https://example.test/v1/chat/completions", models: { fast: "m" } } },
    };
    const result = upsertDetectedLlmEngine(config, {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "local-model",
    });
    expect(result.name).toBe("local");
    expect(result.config.connections?.default).toEqual(config.connections?.default);
  });

  test("a harness with the preferred name does not occupy it: connections and harnesses are separate maps", () => {
    const config: AkmConfig = {
      ...base(),
      connections: { default: lab(8000) },
      harnesses: { local: { platform: "claude" } },
    };
    const result = upsertDetectedLlmEngine(config, {
      provider: "local",
      endpoint: "http://localhost:9000/v1",
      model: "m",
    });
    expect(result.name).toBe("local");
  });

  test("uses the first-free numeric suffix for collisions and finds it on rerun", () => {
    const config: AkmConfig = { ...base(), connections: { local: lab(8000, "other") } };
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
    expect(second.config.connections?.[first.name]).toEqual(first.config.connections?.[first.name]);
  });

  test("skips occupied numeric suffixes in order", () => {
    const result = upsertDetectedLlmEngine(
      { ...base(), connections: { local: lab(7000, "one"), "local-2": lab(8000, "two") } },
      { provider: "local", endpoint: "http://localhost:9000/v1", model: "three" },
    );

    expect(result.name).toBe("local-3");
  });

  test("derives the same collision name regardless of connection insertion order", () => {
    const candidate = { provider: "local", endpoint: "http://localhost:9000/v1", model: "m" };
    const left = upsertDetectedLlmEngine(
      { ...base(), connections: { local: lab(8000, "other"), zed: lab(7000) } },
      candidate,
    );
    const right = upsertDetectedLlmEngine(
      { ...base(), connections: { zed: lab(7000), local: lab(8000, "other") } },
      candidate,
    );
    expect(right.name).toBe(left.name);
  });

  test("chooses the same fingerprint match regardless of config insertion order", () => {
    const candidate = { provider: "local", endpoint: "http://localhost:9000/v1", model: "detected" };
    const first = upsertDetectedLlmEngine(
      { ...base(), connections: { zed: lab(9000, "z"), alpha: lab(9000, "a") } },
      candidate,
    );
    expect(first).toMatchObject({ name: "alpha", reused: true });
  });

  test("a detected harness is named for its platform and carries no platform key of its own", () => {
    const result = upsertDetectedAgentEngine(base(), "claude");
    expect(result).toMatchObject({ name: "claude", reused: false });
    expect(result.config.harnesses).toEqual({ claude: {} });
  });

  test("a detected harness whose platform name is taken by another platform gets a numbered name", () => {
    const config: AkmConfig = { ...base(), harnesses: { claude: { platform: "codex" } } };
    const result = upsertDetectedAgentEngine(config, "claude");
    expect(result.name).toBe("claude-2");
    expect(result.config.harnesses?.["claude-2"]).toEqual({ platform: "claude" });
  });

  test("agent reruns reuse the canonical platform and leave the other harnesses alone", () => {
    const config: AkmConfig = {
      ...base(),
      harnesses: {
        reviewer: { platform: "claude", bin: "/opt/claude" },
        primary: { platform: "opencode" },
      },
    };
    const result = upsertDetectedAgentEngine(config, "claude");
    expect(result).toMatchObject({ name: "reviewer", reused: true });
    expect(result.config.harnesses).toEqual(config.harnesses);
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
