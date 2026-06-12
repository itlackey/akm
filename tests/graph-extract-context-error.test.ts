// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for {@link isContextSizeError} (#496).
 *
 * The predicate must distinguish genuine provider context-limit errors from
 * model prose that merely mentions "context size" / "context length". Models
 * like gemma-4-e4b emit narration containing those phrases, which previously
 * produced false-positive `context_limit` reclassifications.
 */

import { describe, expect, test } from "bun:test";
import { isContextSizeError } from "../src/llm/graph-extract";

describe("isContextSizeError", () => {
  test("returns false for gemma-style prose without token/overflow evidence", () => {
    expect(isContextSizeError("blame the context size of the document")).toBe(false);
    expect(isContextSizeError("context length of the response was fine")).toBe(false);
    expect(isContextSizeError("I considered the context window of the situation")).toBe(false);
  });

  test("returns true for genuine provider overflow phrasings", () => {
    expect(
      isContextSizeError("This model's maximum context length is 8192 tokens, however you requested 9000 tokens"),
    ).toBe(true);
    expect(isContextSizeError("prompt too long")).toBe(true);
    expect(isContextSizeError("context size exceeded")).toBe(true);
    expect(isContextSizeError("input exceeds context window of 4096 tokens")).toBe(true);
  });

  test("returns false when no context keyword is present", () => {
    expect(isContextSizeError("some unrelated 4096 tokens message")).toBe(false);
    expect(isContextSizeError("request failed with status 500")).toBe(false);
  });
});
