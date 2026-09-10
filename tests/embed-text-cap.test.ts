// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: the per-document embedding cap (`embedding.maxInputTokens`,
 * default 512) truncates the embedded text to its head instead of skipping
 * the whole document — this pins the pure truncation helper in isolation
 * from the materializer that calls it (tests/materialize-embeddings-cap.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { capEmbeddingText, DEFAULT_MAX_INPUT_TOKENS, estimateTokenCount } from "../src/llm/embedders/remote";

describe("DEFAULT_MAX_INPUT_TOKENS", () => {
  test("is 512", () => {
    expect(DEFAULT_MAX_INPUT_TOKENS).toBe(512);
  });
});

describe("capEmbeddingText", () => {
  test("leaves text under the cap unchanged", () => {
    const result = capEmbeddingText("short text", 512);
    expect(result).toEqual({ text: "short text", truncated: false });
  });

  test("leaves text exactly at the cap unchanged", () => {
    const text = "x".repeat(2048); // estimateTokenCount = 512
    expect(estimateTokenCount(text)).toBe(512);
    const result = capEmbeddingText(text, 512);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  test("truncates a 2000-token entry to its head instead of skipping it", () => {
    const text = "x".repeat(8000); // estimateTokenCount = 2000
    const result = capEmbeddingText(text, 512);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.text).toBe(text.slice(0, result.text.length));
    // The truncated head itself must fit the cap.
    expect(estimateTokenCount(result.text)).toBeLessThanOrEqual(512);
  });

  test("empty text stays empty and is not reported as truncated", () => {
    const result = capEmbeddingText("", 512);
    expect(result).toEqual({ text: "", truncated: false });
  });

  test("never splits a UTF-16 surrogate pair at the cut boundary", () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16. Pad so the cut boundary
    // would otherwise land exactly between its two code units.
    const emoji = "\u{1F600}"; // 2 UTF-16 code units
    const padLen = 512 * 4 - 1; // cap's char budget minus 1, so the pair straddles the cut
    const text = "x".repeat(padLen) + emoji + "y".repeat(100);
    const result = capEmbeddingText(text, 512);
    expect(result.truncated).toBe(true);
    // A valid string never contains a lone surrogate.
    expect(result.text).toBe(Array.from(result.text).join(""));
    for (let i = 0; i < result.text.length; i++) {
      const code = result.text.charCodeAt(i);
      const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
      if (isLowSurrogate) {
        // Must be paired with a preceding high surrogate, never dangling.
        const prev = result.text.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });
});
