// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CHARACTERIZATION test for `extractGraphFromBody` (the single-asset graph
 * extractor in `src/llm/graph-extract.ts`).
 *
 * Pins the CURRENT observable behavior of the function before the planned
 * migration to the shared LLM-feature seam. Every branch of the function body
 * is covered by injecting a fake chat/LLM seam (a local Bun HTTP server that
 * faithfully drives the REAL `chatCompletion` transport and the REAL
 * classification ladder — context-overflow / provider_html_error / generic):
 *
 *   1. valid payload            -> exact return value + filtered* telemetry bumps
 *   2. empty/invalid JSON       -> exact fallback + exact warn + failureCount bump
 *   3. thrown context-size err  -> context_limit fallback + warn + failureCount bump
 *   4. thrown provider_html_err -> llm_error fallback + warn + htmlErrorCount bump
 *   5. thrown generic error     -> llm_error fallback + warn + failureCount bump
 *
 * The real `../src/llm/client` transport is exercised against a local Bun HTTP
 * server (no `mock.module`, which leaks across files under newer Bun). The
 * server returns queued responses; a queued entry may set a non-2xx status and
 * an HTML body so the real client throws the typed `LlmCallError` the branch
 * under test classifies.
 *
 * NOTE: `extractGraphFromBody` does NOT throw on failure — it returns an empty
 * extraction and logs via `warn()`. We observe `warn()` by spying on
 * `console.warn` (see `src/core/warn.ts` -> `warn()` calls `console.warn`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { LlmConnectionConfig } from "../src/core/config/config";
import { isQuiet, setQuiet } from "../src/core/warn";

// ── Local LLM server (fake chat/LLM seam) ────────────────────────────────────

interface QueuedResponse {
  /** HTTP status; defaults to 200. A status >= 500 with an HTML body yields a
   * provider_html_error; a non-2xx status with a context-phrase body that the
   * client surfaces in err.message yields a context-size classification. */
  status?: number;
  /** Raw response body. For 2xx this is the OpenAI-compatible JSON envelope
   * unless `raw` is set; for non-2xx it is the error body verbatim. */
  body: string;
  contentType?: string;
}

let chatCallCount = 0;
const responseQueue: QueuedResponse[] = [];

/** Wrap an assistant content string in the OpenAI chat-completions envelope. */
function chatEnvelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    chatCallCount++;
    await request.json().catch(() => ({}));
    const next = responseQueue.shift();
    if (!next) {
      return new Response(chatEnvelope(""), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(next.body, {
      status: next.status ?? 200,
      headers: { "Content-Type": next.contentType ?? "application/json" },
    });
  },
});

const { extractGraphFromBody } = await import("../src/llm/graph-extract");

// ── Shared fixtures ──────────────────────────────────────────────────────────

const SAMPLE_LLM: LlmConnectionConfig = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
  // Keep the timeout small but non-zero; no test path relies on timing.
  timeoutMs: 5000,
};

// graph_extraction defaults to enabled when the feature key is absent.
const AKM_CFG = {
  semanticSearchMode: "auto" as const,
  profiles: { llm: { default: { ...SAMPLE_LLM } } },
  defaults: { llm: "default" },
};

let warnSpy: ReturnType<typeof spyOn>;
// The test runner enables quiet globally, which makes warn() skip console.warn.
// Disable quiet for these tests so warn() is observable, then restore.
const priorQuiet = isQuiet();

beforeEach(() => {
  chatCallCount = 0;
  responseQueue.length = 0;
  setQuiet(false);
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

afterAll(() => {
  setQuiet(priorQuiet);
  llmServer.stop(true);
});

/** Collect all warn() messages emitted during the call as joined strings. */
function warnMessages(): string[] {
  return warnSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" "));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractGraphFromBody — characterization (current behavior)", () => {
  test("1. valid payload -> exact return value + filtered* telemetry bumps", async () => {
    // entities: one valid, one generic ("system" is in GENERIC_ENTITIES) -> filtered.
    // relations: one valid; one with a generic type ("mentions") -> filtered;
    //            one low-confidence -> filtered.
    const telemetry: Record<string, number> = {};
    responseQueue.push({
      body: chatEnvelope(
        JSON.stringify({
          entities: ["ServiceA", "ServiceB", "system"],
          relations: [
            { from: "ServiceA", to: "ServiceB", type: "uses", confidence: 0.9 },
            { from: "ServiceA", to: "ServiceB", type: "mentions" },
            { from: "ServiceB", to: "ServiceA", type: "owns", confidence: 0.2 },
          ],
          confidence: 0.8,
        }),
      ),
    });

    const result = await extractGraphFromBody(SAMPLE_LLM, "ServiceA uses ServiceB.", undefined, AKM_CFG, undefined, {
      telemetry,
    });

    expect(result).toEqual({
      entities: ["ServiceA", "ServiceB"],
      relations: [{ from: "ServiceA", to: "ServiceB", type: "uses", confidence: 0.9 }],
      status: "extracted",
      reason: "none",
      filteredGenericEntities: 1,
      filteredInvalidRelations: 1,
      filteredLowConfidenceRelations: 1,
      confidence: 0.8,
    });
    expect(chatCallCount).toBe(1);

    // Telemetry: filtered* counters mirror the extraction; no failureCount on success.
    expect(telemetry.filteredGenericEntities).toBe(1);
    expect(telemetry.filteredInvalidRelations).toBe(1);
    expect(telemetry.filteredLowConfidenceRelations).toBe(1);
    expect(telemetry.failureCount ?? 0).toBe(0);
    expect(telemetry.htmlErrorCount ?? 0).toBe(0);

    // No warn on the happy path.
    expect(warnMessages()).toEqual([]);
  });

  test("2. empty/invalid JSON -> invalid_json/failed fallback + exact warn + failureCount", async () => {
    const telemetry: Record<string, number> = {};
    // Body has no extractable JSON object -> parseEmbeddedJsonResponse returns null.
    responseQueue.push({ body: chatEnvelope("Sorry, I cannot help with that.") });

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha uses Beta.", undefined, AKM_CFG, undefined, {
      telemetry,
    });

    expect(result).toEqual({
      entities: [],
      relations: [],
      status: "failed",
      reason: "invalid_json",
    });
    expect(chatCallCount).toBe(1);
    expect(telemetry.failureCount).toBe(1);

    // Exact warn message for the invalid-JSON branch.
    expect(warnMessages()).toContain("graph extraction: invalid JSON response from LLM; skipping asset.");
  });

  test("3. thrown context-size error -> context_limit/failed fallback + warn + failureCount", async () => {
    const telemetry: Record<string, number> = {};
    // A 500 whose body is a genuine provider context-overflow phrasing. The real
    // client surfaces it as a provider_error LlmCallError whose .message contains
    // the phrase, which isContextSizeError() classifies as context-overflow.
    responseQueue.push({
      status: 500,
      body: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens",
      contentType: "text/plain",
    });

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha uses Beta.", undefined, AKM_CFG, undefined, {
      telemetry,
    });

    expect(result).toEqual({
      entities: [],
      relations: [],
      status: "failed",
      reason: "context_limit",
    });
    // Context-overflow errors are NOT retried -> exactly one call.
    expect(chatCallCount).toBe(1);
    expect(telemetry.failureCount).toBe(1);
    expect(telemetry.htmlErrorCount ?? 0).toBe(0);

    const msgs = warnMessages();
    expect(msgs.some((m) => m.includes("graph extraction: context size exceeded for asset"))).toBe(true);
  });

  test("4. thrown provider_html_error -> llm_error/failed fallback + warn + htmlErrorCount", async () => {
    const telemetry: Record<string, number> = {};
    // A 5xx HTML body -> the real client throws LlmCallError("provider_html_error").
    responseQueue.push({
      status: 503,
      body: "<!DOCTYPE html><html><head><title>LM Studio</title></head><body>Service starting</body></html>",
      contentType: "text/html",
    });

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha uses Beta.", undefined, AKM_CFG, undefined, {
      telemetry,
    });

    expect(result).toEqual({
      entities: [],
      relations: [],
      status: "failed",
      reason: "llm_error",
    });
    // provider_html_error is NOT retryable -> exactly one call.
    expect(chatCallCount).toBe(1);
    // The html-error branch bumps htmlErrorCount, NOT failureCount.
    expect(telemetry.htmlErrorCount).toBe(1);
    expect(telemetry.failureCount ?? 0).toBe(0);

    const msgs = warnMessages();
    expect(msgs.some((m) => m.includes("graph extraction: provider returned HTML instead of JSON for asset"))).toBe(
      true,
    );
  });

  test("5. thrown generic error -> llm_error/failed fallback + warn + failureCount", async () => {
    const telemetry: Record<string, number> = {};
    // A 400 (client) error -> provider_error LlmCallError, NOT context-size, NOT
    // html, NOT retryable (4xx) -> the generic `else` branch.
    responseQueue.push({
      status: 400,
      body: JSON.stringify({ error: { message: "bad request: unknown model" } }),
    });

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha uses Beta.", undefined, AKM_CFG, undefined, {
      telemetry,
    });

    expect(result).toEqual({
      entities: [],
      relations: [],
      status: "failed",
      reason: "llm_error",
    });
    expect(chatCallCount).toBe(1);
    expect(telemetry.failureCount).toBe(1);
    expect(telemetry.htmlErrorCount ?? 0).toBe(0);

    const msgs = warnMessages();
    expect(msgs.some((m) => m.includes("graph extraction failed for asset"))).toBe(true);
  });

  test("empty/whitespace body short-circuits with no LLM call and empty result", async () => {
    const result = await extractGraphFromBody(SAMPLE_LLM, "   \n\t  ", undefined, AKM_CFG);
    expect(result).toEqual({ entities: [], relations: [] });
    expect(chatCallCount).toBe(0);
    expect(warnMessages()).toEqual([]);
  });
});
