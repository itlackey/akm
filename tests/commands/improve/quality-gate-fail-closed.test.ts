/**
 * 07 P0-2 — the LLM-as-judge quality gate must fail CLOSED.
 *
 * When the judge cannot render a verdict (no LLM configured, parse failure, or
 * timeout/error), minted content must be REJECTED, not passed through. An
 * unverifiable judge waving content into the stash is exactly the injection
 * surface this flip removes.
 */

import { describe, expect, test } from "bun:test";

import { runLessonQualityJudge } from "../../../src/commands/improve/distill/quality-gate";
import type { AkmConfig } from "../../../src/core/config/config";

function configWithLlm(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir: "/tmp/does-not-matter",
    sources: [],
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
      },
    },
    defaults: { llmEngine: "default" },
  } as unknown as AkmConfig;
}

function configWithoutLlm(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir: "/tmp/does-not-matter",
    sources: [],
    defaultWriteTarget: "stash",
    engines: {},
    defaults: {},
  } as unknown as AkmConfig;
}

describe("runLessonQualityJudge — fail-CLOSED (07 P0-2)", () => {
  test("parse failure → pass:false (score -1)", async () => {
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      // Non-JSON judge response → parse failure.
      async () => "this is not json at all",
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBeUndefined();
  });

  test("no LLM configured → pass:false (score -1)", async () => {
    const result = await runLessonQualityJudge(configWithoutLlm(), "some lesson body", "some source body", async () => {
      throw new Error("chat must not be called when no LLM is configured");
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
  });

  test("judge throws (timeout/error) → pass:false (score -1)", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () => {
      throw new Error("upstream boom");
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
  });

  test("real passing verdict still passes (score >= 3.5)", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ score: 4.5, reason: "adds new info" }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(4.5, 9);
  });
});
