// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Characterization test for `compressMemoryToDerivedMemory`
 * (src/llm/memory-infer.ts).
 *
 * Pins the CURRENT observable behavior of the function before any migration
 * onto a shared LLM-feature seam. The chat seam is injected via the
 * `_setChatCompletionForTests` swap-and-restore seam on `../../src/llm/client`
 * so `LlmCallError`, `parseEmbeddedJsonResponse`,
 * `isContextSizeError`, etc. stay real. `warn` is mocked (real module spread,
 * `warn` captured) so we can assert the exact log lines.
 *
 * Every branch of the function is covered:
 *   - valid payload         -> exact DerivedMemoryDraft return, no warn
 *   - empty body            -> undefined, no chat call, no warn
 *   - unparseable JSON       -> undefined + "invalid JSON response" warn
 *   - incomplete payload     -> undefined + "incomplete derived memory" warn
 *   - thrown context-size err-> undefined + generic "memory inference failed" warn
 *   - thrown provider_html   -> undefined + HTML warn + telemetry.htmlErrorCount bump
 *   - thrown generic error   -> undefined + generic "memory inference failed" warn
 *
 * NOTE: as of the un-migrated code, a thrown context-size error is NOT a
 * distinct branch — it falls through to the same generic `warn("memory
 * inference failed: ...")` path as any other thrown Error. This test pins that
 * fact so a migration that (accidentally or otherwise) special-cases it would
 * be caught.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AkmConfig, LlmConnectionConfig } from "../../src/core/config/config";

// ── Injected chat seam ───────────────────────────────────────────────────────
// `chatResponder` returns a raw string (the model body) or throws. Reset per
// test. `chatCalls` records how many times the seam was reached so the
// empty-body short-circuit can be asserted.
let chatResponder: (userContent: string) => string | Promise<string> = () => "";
let chatCalls = 0;

// ── Captured warn sink ───────────────────────────────────────────────────────
let warnCalls: string[] = [];
const realWarn = await import("../../src/core/warn");
mock.module("../../src/core/warn", () => ({
  ...realWarn,
  warn: (...args: unknown[]) => {
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
}));

// Import the implementation file directly so this characterization test keeps
// exercising the real logic even when sibling files stub `../src/llm/memory-infer`.
const { compressMemoryToDerivedMemory } = await import("../../src/llm/memory-infer-impl");
const { _setChatCompletionForTests, isContextSizeError, LlmCallError } = await import("../../src/llm/client");
const { overrideSeam } = await import("../_helpers/seams");

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Minimal config that opens the `memory_inference` gate. The gate default is
// `?? true`, so a config that is merely non-undefined is sufficient; we set the
// flag explicitly for clarity and robustness against a default flip.
const ENABLED_CONFIG = {
  profiles: { improve: { default: { processes: { memoryInference: { enabled: true } } } } },
} as unknown as AkmConfig;

const LLM_CONFIG = { timeoutMs: 5_000 } as unknown as LlmConnectionConfig;

function validPayload(): string {
  return JSON.stringify({
    title: "Derived title",
    description: "Derived description",
    content: "Derived content body",
    tags: ["alpha", "beta"],
    searchHints: ["hint-one", "hint-two"],
  });
}

beforeEach(() => {
  overrideSeam(_setChatCompletionForTests, async (_config, messages) => {
    chatCalls += 1;
    const user = messages.find((m) => m.role === "user");
    return chatResponder(user?.content ?? "");
  });
  chatResponder = () => "";
  chatCalls = 0;
  warnCalls = [];
});

afterEach(() => {
  chatResponder = () => "";
  chatCalls = 0;
  warnCalls = [];
});

// ── Branch coverage ──────────────────────────────────────────────────────────

describe("compressMemoryToDerivedMemory — characterization", () => {
  test("valid payload -> exact DerivedMemoryDraft, no warn", async () => {
    chatResponder = () => validPayload();

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "some memory body", undefined, ENABLED_CONFIG);

    expect(result).toEqual({
      title: "Derived title",
      description: "Derived description",
      tags: ["alpha", "beta"],
      searchHints: ["hint-one", "hint-two"],
      content: "Derived content body",
    });
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("trims/caps tags (>8) and searchHints (>6) to the documented limits", async () => {
    chatResponder = () =>
      JSON.stringify({
        title: "  Title  ",
        description: "  Desc  ",
        content: "  Body  ",
        tags: ["  t1 ", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"],
        searchHints: ["h1", "h2", "h3", "h4", "h5", "h6", "h7"],
      });

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toEqual({
      title: "Title",
      description: "Desc",
      content: "Body",
      tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
      searchHints: ["h1", "h2", "h3", "h4", "h5", "h6"],
    });
    expect(warnCalls).toEqual([]);
  });

  test("empty/whitespace body -> undefined, no chat call, no warn", async () => {
    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "   \n  ", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(chatCalls).toBe(0);
    expect(warnCalls).toEqual([]);
  });

  test("empty chat response -> undefined, no warn", async () => {
    chatResponder = () => "";

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("unparseable JSON -> undefined + 'invalid JSON response' warn", async () => {
    chatResponder = () => "this is not json at all";

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(warnCalls).toEqual(["memory inference: invalid JSON response from LLM; skipping memory."]);
  });

  test("incomplete payload (missing required field) -> undefined + 'incomplete' warn", async () => {
    // Valid JSON, parses fine, but `content` is empty and tags missing.
    chatResponder = () => JSON.stringify({ title: "T", description: "D", content: "", tags: [], searchHints: [] });

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(warnCalls).toEqual(["memory inference: incomplete derived memory payload from LLM; skipping memory."]);
  });

  test("thrown context-size error -> undefined + generic 'memory inference failed' warn (NOT a distinct branch)", async () => {
    const ctxMsg = "This model's maximum context length is 8192 tokens; your prompt exceeded that limit.";
    // Sanity: the real classifier recognizes this string as a context-size error.
    expect(isContextSizeError(ctxMsg)).toBe(true);

    chatResponder = () => {
      throw new LlmCallError(ctxMsg, "provider_error");
    };

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(warnCalls).toEqual([`memory inference failed: ${ctxMsg}`]);
  });

  test("thrown provider_html_error -> undefined + HTML warn + telemetry.htmlErrorCount bump", async () => {
    const htmlMsg = "provider returned an HTML document";
    chatResponder = () => {
      throw new LlmCallError(htmlMsg, "provider_html_error");
    };
    const telemetry = { htmlErrorCount: 2 };

    const result = await compressMemoryToDerivedMemory(
      LLM_CONFIG,
      "body",
      undefined,
      ENABLED_CONFIG,
      undefined,
      telemetry,
    );

    expect(result).toBeUndefined();
    expect(telemetry.htmlErrorCount).toBe(3);
    expect(warnCalls).toEqual([
      `memory inference: provider returned HTML instead of JSON; skipping memory: ${htmlMsg}`,
    ]);
  });

  test("provider_html_error with no telemetry sink -> warn only, no throw", async () => {
    const htmlMsg = "provider returned an HTML document";
    chatResponder = () => {
      throw new LlmCallError(htmlMsg, "provider_html_error");
    };

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(warnCalls).toEqual([
      `memory inference: provider returned HTML instead of JSON; skipping memory: ${htmlMsg}`,
    ]);
  });

  test("thrown generic error -> undefined + generic 'memory inference failed' warn", async () => {
    chatResponder = () => {
      throw new Error("connection refused");
    };

    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body", undefined, ENABLED_CONFIG);

    expect(result).toBeUndefined();
    expect(warnCalls).toEqual(["memory inference failed: connection refused"]);
  });

  test("feature gate disabled (no config) -> undefined, no chat call, no warn", async () => {
    chatResponder = () => validPayload();

    // No akmConfig => isLlmFeatureEnabled(undefined, ...) is false => fallback
    // (undefined) without ever running the inner fn.
    const result = await compressMemoryToDerivedMemory(LLM_CONFIG, "body");

    expect(result).toBeUndefined();
    expect(chatCalls).toBe(0);
    expect(warnCalls).toEqual([]);
  });
});
