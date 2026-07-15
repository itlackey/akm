// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the pure helpers extracted from the improve command family
 * (src/commands/improve/shared.ts). These replace byte-identical duplication
 * that previously lived inline across recombine/procedural/loop-stages/improve.
 * They are pure functions with no I/O, so they are trivially testable — that
 * is the point of the extraction.
 */

import { describe, expect, test } from "bun:test";
import { errMessage, refSlug, resolveImproveLlmFn } from "../src/commands/improve/shared";
import type { AkmConfig } from "../src/core/config/config";

describe("errMessage", () => {
  test("returns the .message of an Error", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });
  test("stringifies a non-Error primitive", () => {
    expect(errMessage("plain")).toBe("plain");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
  });
  test("stringifies a plain object", () => {
    expect(errMessage({ a: 1 })).toBe("[object Object]");
  });
});

describe("refSlug", () => {
  test("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(refSlug("lesson:Foo Bar!")).toBe("lesson-foo-bar-");
  });
  test("truncates to 60 characters", () => {
    const long = `lesson:${"a".repeat(200)}`;
    expect(refSlug(long).length).toBe(60);
  });
  test("leaves an already-slug-safe ref only lowercased", () => {
    expect(refSlug("lesson-abc123")).toBe("lesson-abc123");
  });
});

describe("resolveImproveLlmFn", () => {
  test("returns undefined when no LLM is configured", () => {
    const config = {} as AkmConfig;
    const fn = resolveImproveLlmFn(config, {
      processKey: "procedural",
      systemPrompt: "sys",
      tag: "[procedural]",
    });
    expect(fn).toBeUndefined();
  });

  test("returns a callable when defaults.llmEngine exists", () => {
    const config = {
      engines: { default: { kind: "llm", endpoint: "http://localhost:1234", model: "m" } },
      defaults: { llmEngine: "default" },
    } as unknown as AkmConfig;
    const fn = resolveImproveLlmFn(config, {
      processKey: "procedural",
      systemPrompt: "sys",
      tag: "[procedural]",
    });
    expect(typeof fn).toBe("function");
  });
});
