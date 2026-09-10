// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A3 (index-units): the provider's own window/slot limits, read from
 * llama.cpp (`/props`, `/tokenize`) or Ollama (`/api/show`) rather than
 * guessed from config. All network I/O is mocked via `withMockedFetch`
 * (AGENTS.md) — no real socket is opened, so this is a pure unit test.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EmbeddingConnectionConfig } from "../../../src/core/config/config";
import { HEALTH_PROBE_TIMEOUT_MS } from "../../../src/llm/client";
import {
  _resetProviderLimitsCacheForTests,
  CHARS_PER_TOKEN_TAIL,
  DEFAULT_WINDOW_TOKENS,
  probeProviderLimits,
  UNIT_HEADER_MARGIN_TOKENS,
  unitMaxChars,
} from "../../../src/llm/embedders/provider-limits";
import { withMockedFetch } from "../../_helpers/sandbox";

beforeEach(() => {
  _resetProviderLimitsCacheForTests();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function baseConfig(overrides: Partial<EmbeddingConnectionConfig> = {}): EmbeddingConnectionConfig {
  return {
    endpoint: "http://127.0.0.1:8080/v1/embeddings",
    model: "test-embed-model",
    ...overrides,
  } as EmbeddingConnectionConfig;
}

describe("probeProviderLimits: llama.cpp shape", () => {
  test("reads window/slots from /props and calibrates charsPerToken when /tokenize is present", async () => {
    const tokenizeCalls: string[] = [];
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async (url, init) => {
        if (url.endsWith("/props")) {
          return jsonResponse({ default_generation_settings: { n_ctx: 4096 }, total_slots: 4 });
        }
        if (url.endsWith("/tokenize")) {
          const body = JSON.parse(String(init?.body)) as { content: string };
          tokenizeCalls.push(body.content);
          return jsonResponse({ tokens: new Array(Math.max(1, Math.round(body.content.length / 3))).fill(0) });
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );

    expect(limits.source).toBe("llama.cpp");
    expect(limits.windowTokens).toBe(4096);
    expect(limits.slots).toBe(4);
    // The presence check plus one tokenize call per CALIBRATION_SHAPES entry (8).
    expect(tokenizeCalls.length).toBe(9);
  });

  test("calibrates charsPerToken as the 1st-percentile (densest) ratio across the calibration shapes", async () => {
    const observedRatios: number[] = [];
    let tokenizeCallIndex = 0;
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async (url, init) => {
        if (url.endsWith("/props")) {
          return jsonResponse({ default_generation_settings: { n_ctx: 4096 }, total_slots: 2 });
        }
        if (url.endsWith("/tokenize")) {
          tokenizeCallIndex += 1;
          const body = JSON.parse(String(init?.body)) as { content: string };
          if (tokenizeCallIndex === 1) {
            // The presence check — excluded from calibration.
            return jsonResponse({ tokens: [0] });
          }
          const tokenCount = Math.max(1, Math.round(body.content.length / (2 + (tokenizeCallIndex % 5))));
          observedRatios.push(body.content.length / tokenCount);
          return jsonResponse({ tokens: new Array(tokenCount).fill(0) });
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );

    // One tokenize call per CALIBRATION_SHAPES entry (8), the presence check excluded.
    expect(observedRatios.length).toBe(8);
    const expectedRatio = Math.min(...observedRatios);
    expect(limits.charsPerToken).toBeCloseTo(expectedRatio, 6);
  });

  test("falls back to CHARS_PER_TOKEN_TAIL when /tokenize is absent", async () => {
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async (url) => {
        if (url.endsWith("/props")) {
          return jsonResponse({ default_generation_settings: { n_ctx: 4096 }, total_slots: 2 });
        }
        if (url.endsWith("/tokenize")) {
          return jsonResponse({ error: "not found" }, 404);
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );
    expect(limits.source).toBe("llama.cpp");
    expect(limits.charsPerToken).toBe(CHARS_PER_TOKEN_TAIL);
  });

  test("config.concurrency overrides the probed slot count", async () => {
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig({ concurrency: 9 })),
      async (url) => {
        if (url.endsWith("/props")) {
          return jsonResponse({ default_generation_settings: { n_ctx: 4096 }, total_slots: 4 });
        }
        if (url.endsWith("/tokenize")) return jsonResponse({}, 404);
        throw new Error(`unexpected url: ${url}`);
      },
    );
    expect(limits.slots).toBe(9);
  });
});

describe("probeProviderLimits: Ollama shape", () => {
  test("reads the arch-prefixed context_length from POST /api/show and reports 1 slot", async () => {
    const limits = await withMockedFetch(
      () =>
        probeProviderLimits(
          baseConfig({ endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text" }),
        ),
      async (url, init) => {
        if (url.endsWith("/props")) return jsonResponse({}, 404);
        if (url.endsWith("/api/show")) {
          const body = JSON.parse(String(init?.body)) as { model: string };
          expect(body.model).toBe("nomic-embed-text");
          return jsonResponse({
            model_info: { "nomic-bert.context_length": 2048, "nomic-bert.embedding_length": 768 },
          });
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );
    expect(limits.source).toBe("ollama");
    expect(limits.windowTokens).toBe(2048);
    expect(limits.slots).toBe(1);
    expect(limits.charsPerToken).toBe(CHARS_PER_TOKEN_TAIL);
  });

  test("config.concurrency overrides Ollama's fixed 1-slot default", async () => {
    const limits = await withMockedFetch(
      () =>
        probeProviderLimits(
          baseConfig({ endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "m", concurrency: 3 }),
        ),
      async (url) => {
        if (url.endsWith("/props")) return jsonResponse({}, 404);
        if (url.endsWith("/api/show")) return jsonResponse({ model_info: { "llama.context_length": 8192 } });
        throw new Error(`unexpected url: ${url}`);
      },
    );
    expect(limits.slots).toBe(3);
  });
});

describe("probeProviderLimits: default fallback", () => {
  test("no endpoint configured (local-only embedder) never touches the network", async () => {
    const limits = await probeProviderLimits(
      baseConfig({ endpoint: undefined, model: undefined, localModel: "local" }),
    );
    expect(limits.source).toBe("default");
    expect(limits.windowTokens).toBe(DEFAULT_WINDOW_TOKENS);
    expect(limits.slots).toBe(1);
    expect(limits.charsPerToken).toBe(CHARS_PER_TOKEN_TAIL);
  });

  test("an OpenAI-compatible / gateway endpoint that answers neither /props nor /api/show falls back to default", async () => {
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async () => jsonResponse({ error: "not found" }, 404),
    );
    expect(limits.source).toBe("default");
    expect(limits.windowTokens).toBe(DEFAULT_WINDOW_TOKENS);
    expect(limits.slots).toBe(1);
  });

  test("a failed probe (network error) never throws and falls back to default", async () => {
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async () => {
        throw new Error("ECONNREFUSED");
      },
    );
    expect(limits.source).toBe("default");
    expect(limits.windowTokens).toBe(DEFAULT_WINDOW_TOKENS);
  });

  test("an unparseable endpoint never throws and falls back to default without any fetch", async () => {
    let fetchCalled = false;
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig({ endpoint: "not a url" })),
      async () => {
        fetchCalled = true;
        return jsonResponse({});
      },
    );
    expect(fetchCalled).toBe(false);
    expect(limits.source).toBe("default");
  });

  test("config.concurrency overrides the default 1-slot fallback", async () => {
    const limits = await probeProviderLimits(baseConfig({ endpoint: undefined, model: undefined, concurrency: 5 }));
    expect(limits.slots).toBe(5);
  });
});

describe("probeProviderLimits: timeout reuse (#914)", () => {
  let timeoutSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    timeoutSpy?.mockRestore();
    timeoutSpy = undefined;
  });

  test("bounds probe requests by the shared health-probe timeout constant when config.timeoutMs is unset", async () => {
    timeoutSpy = spyOn(AbortSignal, "timeout");
    await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async () => jsonResponse({}, 404),
    );
    expect(timeoutSpy).toHaveBeenCalled();
    for (const call of timeoutSpy.mock.calls) {
      expect(call[0]).toBe(HEALTH_PROBE_TIMEOUT_MS);
    }
  });

  test("config.timeoutMs overrides the shared default for the probe", async () => {
    timeoutSpy = spyOn(AbortSignal, "timeout");
    await withMockedFetch(
      () => probeProviderLimits(baseConfig({ timeoutMs: 42 })),
      async () => jsonResponse({}, 404),
    );
    expect(timeoutSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of timeoutSpy.mock.calls) {
      expect(call[0]).toBe(42);
    }
  });
});

describe("probeProviderLimits: per-process memoisation (R3)", () => {
  test("two calls with the same config make one set of HTTP requests", async () => {
    let fetchCalls = 0;
    const { first, second } = await withMockedFetch(
      async () => {
        const firstLimits = await probeProviderLimits(baseConfig());
        const secondLimits = await probeProviderLimits(baseConfig());
        return { first: firstLimits, second: secondLimits };
      },
      async (url) => {
        fetchCalls++;
        if (url.endsWith("/props")) {
          return jsonResponse({ default_generation_settings: { n_ctx: 4096 }, total_slots: 2 });
        }
        if (url.endsWith("/tokenize")) {
          return jsonResponse({ tokens: [1, 2, 3] });
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );
    // /props once, plus the /tokenize presence check and 8 calibration
    // samples once each — NOT doubled for the second call.
    expect(fetchCalls).toBe(10);
    expect(second).toEqual(first);
  });
});

describe("unitMaxChars", () => {
  test("floors (windowTokens - UNIT_HEADER_MARGIN_TOKENS) * charsPerToken", () => {
    const chars = unitMaxChars({ windowTokens: 4096, slots: 1, source: "default", charsPerToken: 4 });
    expect(chars).toBe(Math.floor((4096 - UNIT_HEADER_MARGIN_TOKENS) * 4));
  });

  test("uses the provider's own calibrated ratio, not the fallback constant, when both differ", () => {
    const chars = unitMaxChars({ windowTokens: 8192, slots: 1, source: "llama.cpp", charsPerToken: 3.1 });
    expect(chars).toBe(Math.floor((8192 - UNIT_HEADER_MARGIN_TOKENS) * 3.1));
    expect(chars).not.toBe(Math.floor((8192 - UNIT_HEADER_MARGIN_TOKENS) * CHARS_PER_TOKEN_TAIL));
  });

  test("never returns a negative bound for a tiny window", () => {
    const chars = unitMaxChars({ windowTokens: 1, slots: 1, source: "default", charsPerToken: CHARS_PER_TOKEN_TAIL });
    expect(chars).toBeGreaterThanOrEqual(0);
  });
});

describe("probeProviderLimits: implausible window is rejected, not passed through (F1)", () => {
  // Previously this exact windowTokens:1 shape was asserted "accepted" by a
  // unitMaxChars-level test: unitMaxChars(1) floors to 0 without going
  // negative, but 0 is exactly the value that makes deriveUnits throw
  // RangeError downstream — so "not negative" was true but not actually
  // safe. The real fix belongs in the probe, not in unitMaxChars, so the
  // regression coverage moves here: a window this small must never reach a
  // caller at all.
  test("a probed llama.cpp window too small to clear its own header margin falls back to the default window instead of crashing deriveUnits downstream", async () => {
    const limits = await withMockedFetch(
      () => probeProviderLimits(baseConfig()),
      async (url) => {
        if (url.endsWith("/props")) {
          return jsonResponse({ default_generation_settings: { n_ctx: 1 }, total_slots: 2 });
        }
        if (url.endsWith("/tokenize")) return jsonResponse({}, 404);
        throw new Error(`unexpected url: ${url}`);
      },
    );
    expect(limits.source).toBe("default");
    expect(limits.windowTokens).toBe(DEFAULT_WINDOW_TOKENS);
    expect(unitMaxChars(limits)).toBeGreaterThan(0);
  });

  test("a probed Ollama window exactly at the header margin (zero room for real text) falls back to the default window", async () => {
    const limits = await withMockedFetch(
      () =>
        probeProviderLimits(
          baseConfig({ endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text" }),
        ),
      async (url) => {
        if (url.endsWith("/props")) return jsonResponse({}, 404);
        if (url.endsWith("/api/show")) {
          return jsonResponse({ model_info: { "nomic-bert.context_length": UNIT_HEADER_MARGIN_TOKENS } });
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );
    expect(limits.source).toBe("default");
    expect(limits.windowTokens).toBe(DEFAULT_WINDOW_TOKENS);
  });
});
