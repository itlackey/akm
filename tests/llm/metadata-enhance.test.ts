// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Characterization test for `enhanceMetadata` (src/llm/metadata-enhance.ts).
 *
 * Pins the CURRENT observable behavior of the function BEFORE any migration
 * onto a shared LLM-feature seam. The chat seam is injected by mocking the
 * `chatCompletion` export of `../../src/llm/client` while spreading the rest of
 * the real module so `LlmCallError`, `parseJsonResponse`, `isContextSizeError`,
 * etc. stay real. `warn`/`warnVerbose` are mocked (real module spread, calls
 * captured) so we can prove the EXACT (empty) warn behavior.
 *
 * IMPORTANT behavioral fact this test pins (and that distinguishes
 * `enhanceMetadata` from its siblings like `compressMemoryToDerivedMemory`):
 * `enhanceMetadata`'s inner `runLlm` has NO try/catch, NO warn calls, and NO
 * telemetry bumps. Therefore:
 *   - It NEVER calls warn() on ANY path (parse failure or thrown error).
 *   - It NEVER bumps any telemetry counter (no telemetry sink is threaded).
 *   - context-size / provider_html_error / generic errors are NOT distinct
 *     branches — they are all handled identically by the surrounding control
 *     flow (propagate when ungated, swallow to `{}` when gated+enabled).
 * A migration that (accidentally or otherwise) adds a warn, a telemetry bump,
 * or special-cases an error type would change observable behavior and is
 * caught here.
 *
 * Gated vs ungated semantics (the two control-flow paths in the function):
 *   - akmConfig === undefined  -> gate BYPASSED: runLlm runs unconditionally,
 *                                 errors PROPAGATE to the caller.
 *   - akmConfig present, gate enabled  -> tryLlmFeature runs runLlm and
 *                                 SWALLOWS any throw to `{}` (no warn/telemetry).
 *   - akmConfig present, gate disabled -> runLlm never runs (chat NOT called),
 *                                 returns `{}`.
 *
 * Every branch is covered below.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AkmConfig, LlmConnectionConfig } from "../../src/core/config/config";
import type { StashEntry } from "../../src/indexer/passes/metadata";

// ── Injected chat seam ───────────────────────────────────────────────────────
// `chatResponder` returns a raw string (the model body) or throws. Reset per
// test. `chatCalls` records how many times the seam was reached so the
// gate-disabled short-circuit can be asserted.
let chatResponder: (userContent: string) => string | Promise<string> = () => "";
let chatCalls = 0;

const realClient = await import("../../src/llm/client");
mock.module("../../src/llm/client", () => ({
  ...realClient,
  chatCompletion: async (_conn: unknown, messages: Array<{ role: string; content: string }>): Promise<string> => {
    chatCalls += 1;
    const user = messages.find((m) => m.role === "user");
    return chatResponder(user?.content ?? "");
  },
}));

// ── Captured warn sinks ──────────────────────────────────────────────────────
// enhanceMetadata does not import warn at all today, but we capture both warn
// and warnVerbose so the "never warns" assertion is robust against a migration
// that introduces a warn through any path.
let warnCalls: string[] = [];
const realWarn = await import("../../src/core/warn");
mock.module("../../src/core/warn", () => ({
  ...realWarn,
  warn: (...args: unknown[]) => {
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  warnVerbose: (...args: unknown[]) => {
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
}));

// Import AFTER the mocks so the module under test binds the stubbed deps.
const { enhanceMetadata } = await import("../../src/llm/metadata-enhance");
const { LlmCallError } = realClient;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LLM_CONFIG = { endpoint: "http://localhost:0", model: "test-model", timeoutMs: 5_000 } as LlmConnectionConfig;

// Opens the `metadata_enhance` gate. The gate reads `index.metadataEnhance.enabled`
// with default `?? false`, so the flag MUST be set explicitly to enable.
const ENABLED_CONFIG = {
  index: { metadataEnhance: { enabled: true } },
} as unknown as AkmConfig;

// A config object that is present but with the gate DISABLED.
const DISABLED_CONFIG = {
  index: { metadataEnhance: { enabled: false } },
} as unknown as AkmConfig;

const ENTRY: StashEntry = { name: "build-image", type: "script", description: "build image" };

function validPayload(): string {
  return JSON.stringify({
    description: "Builds Docker images from Dockerfiles",
    searchHints: ["build a docker image", "create container image", "package application"],
    tags: ["docker", "container", "build", "image"],
  });
}

beforeEach(() => {
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

describe("enhanceMetadata — characterization", () => {
  // ----- valid payload -----
  test("valid payload (ungated) -> exact EnhancedMetadata return, no warn", async () => {
    chatResponder = () => validPayload();

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY);

    expect(result).toEqual({
      description: "Builds Docker images from Dockerfiles",
      searchHints: ["build a docker image", "create container image", "package application"],
      tags: ["docker", "container", "build", "image"],
    });
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("valid payload (gated, enabled) -> exact EnhancedMetadata return, no warn", async () => {
    chatResponder = () => validPayload();

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY, undefined, undefined, ENABLED_CONFIG);

    expect(result).toEqual({
      description: "Builds Docker images from Dockerfiles",
      searchHints: ["build a docker image", "create container image", "package application"],
      tags: ["docker", "container", "build", "image"],
    });
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("caps searchHints at 8 and tags at 10; filters non-strings/blanks", async () => {
    chatResponder = () =>
      JSON.stringify({
        searchHints: ["a", 123, null, "b", "", "   ", "c", "d", "e", "f", "g", "h", "i", "j"],
        tags: ["good", false, "  ", "fine", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"],
      });

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY);

    // searchHints: blanks/non-strings filtered first, then sliced to 8.
    expect(result.searchHints).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    // tags: blanks/non-strings filtered first, then sliced to 10.
    expect(result.tags).toEqual(["good", "fine", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
    expect(result.description).toBeUndefined();
    expect(warnCalls).toEqual([]);
  });

  test("empty-string description is dropped (truthiness guard)", async () => {
    chatResponder = () => JSON.stringify({ description: "" });

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY);

    expect(result).toEqual({});
    expect(warnCalls).toEqual([]);
  });

  // ----- empty / invalid JSON -> {} fallback, NO warn -----
  test("unparseable response -> {} fallback, NO warn (ungated)", async () => {
    chatResponder = () => "This is not JSON at all";

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY);

    expect(result).toEqual({});
    expect(chatCalls).toBe(1);
    // Pins that enhanceMetadata does NOT warn on parse failure (unlike siblings).
    expect(warnCalls).toEqual([]);
  });

  test("empty chat body -> {} fallback, NO warn", async () => {
    chatResponder = () => "";

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY);

    expect(result).toEqual({});
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  // ----- thrown errors, UNGATED -> propagate identically, NO warn/telemetry -----
  test("thrown context-size error (ungated) -> PROPAGATES, no warn", async () => {
    const ctxMsg = "This model's maximum context length is 8192 tokens; your prompt exceeded that limit.";
    // Sanity: the real classifier recognizes this as a context-size error.
    expect(realClient.isContextSizeError(ctxMsg)).toBe(true);

    chatResponder = () => {
      throw new LlmCallError(ctxMsg, "provider_error");
    };

    await expect(enhanceMetadata(LLM_CONFIG, ENTRY)).rejects.toThrow(ctxMsg);
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("thrown provider_html_error (ungated) -> PROPAGATES, no warn, no telemetry", async () => {
    const htmlMsg = "LLM provider returned HTML instead of JSON";
    chatResponder = () => {
      throw new LlmCallError(htmlMsg, "provider_html_error");
    };

    await expect(enhanceMetadata(LLM_CONFIG, ENTRY)).rejects.toThrow(htmlMsg);
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("thrown generic error (ungated) -> PROPAGATES, no warn", async () => {
    chatResponder = () => {
      throw new Error("connection refused");
    };

    await expect(enhanceMetadata(LLM_CONFIG, ENTRY)).rejects.toThrow("connection refused");
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  // ----- thrown errors, GATED+ENABLED -> swallow to {} identically, NO warn -----
  test("thrown context-size error (gated, enabled) -> swallowed to {}, no warn", async () => {
    const ctxMsg = "This model's maximum context length is 8192 tokens; your prompt exceeded that limit.";
    chatResponder = () => {
      throw new LlmCallError(ctxMsg, "provider_error");
    };

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY, undefined, undefined, ENABLED_CONFIG);

    expect(result).toEqual({});
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("thrown provider_html_error (gated, enabled) -> swallowed to {}, no warn, no telemetry", async () => {
    chatResponder = () => {
      throw new LlmCallError("LLM provider returned HTML instead of JSON", "provider_html_error");
    };

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY, undefined, undefined, ENABLED_CONFIG);

    expect(result).toEqual({});
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  test("thrown generic error (gated, enabled) -> swallowed to {}, no warn", async () => {
    chatResponder = () => {
      throw new Error("connection refused");
    };

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY, undefined, undefined, ENABLED_CONFIG);

    expect(result).toEqual({});
    expect(chatCalls).toBe(1);
    expect(warnCalls).toEqual([]);
  });

  // ----- gate disabled -> chat never runs -----
  test("gate disabled -> {} fallback, chat NOT called, no warn", async () => {
    chatResponder = () => validPayload();

    const result = await enhanceMetadata(LLM_CONFIG, ENTRY, undefined, undefined, DISABLED_CONFIG);

    expect(result).toEqual({});
    expect(chatCalls).toBe(0);
    expect(warnCalls).toEqual([]);
  });

  // ----- prompt threading: fileContent is truncated at 4000 chars -----
  test("fileContent over 4000 chars is truncated with a marker in the user prompt", async () => {
    let seenUser = "";
    chatResponder = (user) => {
      seenUser = user;
      return validPayload();
    };
    const big = "x".repeat(5000);

    await enhanceMetadata(LLM_CONFIG, ENTRY, big);

    expect(seenUser).toContain("... (truncated)");
    expect(seenUser).toContain("x".repeat(4000));
    expect(seenUser).not.toContain("x".repeat(4001));
    expect(warnCalls).toEqual([]);
  });
});
