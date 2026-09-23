/**
 * 07 P0-2 — the LLM-as-judge quality gate must fail CLOSED.
 *
 * When the judge cannot render a verdict (no LLM configured, parse failure, or
 * timeout/error), minted content must be REJECTED, not passed through. An
 * unverifiable judge waving content into the stash is exactly the injection
 * surface this flip removes.
 */

import { describe, expect, test } from "bun:test";

import {
  buildReflectJudgePrompt,
  runLessonQualityJudge,
  runReflectQualityJudge,
} from "../../../src/commands/improve/distill/quality-gate";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { withEnv } from "../../_helpers/sandbox";

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
  test("parse failure → pass:false, routed to review (score -1, reviewNeeded)", async () => {
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      // Non-JSON judge response → parse failure.
      async () => "this is not json at all",
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("no LLM configured → pass:false (score -1), not routed to review (nothing was generated yet)", async () => {
    const result = await runLessonQualityJudge(configWithoutLlm(), "some lesson body", "some source body", async () => {
      throw new Error("chat must not be called when no LLM is configured");
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBeUndefined();
  });

  test("judge throws (timeout/error) → pass:false, routed to review (score -1, reviewNeeded)", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () => {
      throw new Error("upstream boom");
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("missing required symbolic credential remains a hard config failure", async () => {
    const config = configWithLlm();
    config.engines = {
      default: {
        ...config.engines?.default,
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
        apiKey: "$AKM_QUALITY_REQUIRED_KEY",
      },
    };
    let chatCalls = 0;

    const failure = withEnv({ AKM_QUALITY_REQUIRED_KEY: undefined }, () =>
      runLessonQualityJudge(config, "some lesson body", "some source body", async () => {
        chatCalls += 1;
        return JSON.stringify({ score: 4, reason: "wrong" });
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toMatchObject({ code: "INVALID_CONFIG_FILE" });
    expect(chatCalls).toBe(0);
  });

  test("real passing verdict still passes (score >= 3.5)", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ score: 4.5, reason: "adds new info" }),
    );
    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(4.5, 9);
  });

  test("disables thinking for the JSON-only judge call", async () => {
    let enableThinking: boolean | undefined;
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      async (connection, _messages, options) => {
        // Resolved execution canonicalizes inference onto the lowered
        // connection; assert the same effective provider value.
        enableThinking = options?.enableThinking ?? connection.enableThinking;
        return JSON.stringify({ score: 4.5, reason: "adds new info" });
      },
    );

    expect(result.pass).toBe(true);
    expect(enableThinking).toBe(false);
  });

  test.each([
    "0",
    "5.1",
    "1e999",
  ])("an out-of-range or non-finite score routes to review instead of being rejected: %s", async (score) => {
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      async () => `{"score":${score},"reason":"invalid"}`,
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("forwards the shared signal and remaining timeout", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let receivedTimeout: number | null | undefined;
    const result = await runLessonQualityJudge(
      configWithLlm(),
      "some lesson body",
      "some source body",
      async (_config, _messages, options) => {
        receivedSignal = options?.signal;
        receivedTimeout = options?.timeoutMs;
        return JSON.stringify({ score: 4.5, reason: "bounded" });
      },
      { signal: controller.signal, timeoutMs: 1234 },
    );

    expect(result.pass).toBe(true);
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedTimeout).toBe(1234);
  });
});

describe("buildReflectJudgePrompt", () => {
  test("keeps late changed content in bounded diff context", () => {
    const source = `${"source line\n".repeat(400)}old ending`;
    const candidate = `${"source line\n".repeat(400)}LATE_CHANGED_MARKER`;
    const prompt = buildReflectJudgePrompt(candidate, source, []);

    expect(prompt).toContain("LATE_CHANGED_MARKER");
    expect(prompt).toContain("Changed region:");
    expect(prompt.length).toBeLessThan(25_000);
  });
});

describe("runLessonQualityJudge — pinned temperature (R13)", () => {
  test("the request carries temperature: 0 regardless of the runner's configured temperature", async () => {
    let receivedTemperature: number | undefined;
    // Simulate a runner resolved at a non-zero generation temperature (0.3):
    // the judge request must still pin 0, not inherit this.
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      stashDir: "/tmp/does-not-matter",
      sources: [],
      defaultWriteTarget: "stash",
      engines: {
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
          temperature: 0.3,
        },
      },
      defaults: { llmEngine: "default" },
    } as unknown as AkmConfig;
    const result = await runLessonQualityJudge(
      config,
      "some lesson body",
      "some source body",
      async (connection, _messages, options) => {
        receivedTemperature = options?.temperature ?? (connection as unknown as { temperature?: number }).temperature;
        return JSON.stringify({ score: 4.5, reason: "adds new info" });
      },
    );

    expect(result.pass).toBe(true);
    expect(receivedTemperature).toBe(0);
  });
});

describe("runLessonQualityJudge — per-criterion scores (R16)", () => {
  test('new-shape {"scores": {...}} JSON parses to the correct average and exposes criteria', async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 4, actionability: 5, nonRedundancy: 3 }, reason: "solid" }),
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo((4 + 5 + 3) / 3, 9);
    expect(result.criteria).toEqual({ novelty: 4, actionability: 5, nonRedundancy: 3 });
  });

  test('old-shape {"score": float} JSON still parses, with no criteria field', async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ score: 4.5, reason: "adds new info" }),
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo(4.5, 9);
    expect(result.criteria).toBeUndefined();
  });

  test("a criterion of 0 routes to review exactly as a parse failure does today", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 0, actionability: 4, nonRedundancy: 4 }, reason: "bad" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
    expect(result.criteria).toBeUndefined();
  });

  test("a criterion of 7 (out of range) routes to review exactly as a parse failure does today", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 7, actionability: 4, nonRedundancy: 4 }, reason: "bad" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("a missing criterion key routes to review exactly as a parse failure does today", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      // `scores` present but empty — no usable criteria at all.
      JSON.stringify({ scores: {}, reason: "bad" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("the review-needed and auto-reject thresholds (3.5 / 2.5) are unchanged for the averaged criteria score", async () => {
    const reviewBand = await runLessonQualityJudge(configWithLlm(), "body", "source", async () =>
      JSON.stringify({ scores: { novelty: 3, actionability: 3, nonRedundancy: 3 }, reason: "uncertain" }),
    );
    expect(reviewBand.pass).toBe(false);
    expect(reviewBand.reviewNeeded).toBe(true);
    expect(reviewBand.score).toBeCloseTo(3, 9);

    const rejectBand = await runLessonQualityJudge(configWithLlm(), "body", "source", async () =>
      JSON.stringify({ scores: { novelty: 2, actionability: 2, nonRedundancy: 2 }, reason: "weak" }),
    );
    expect(rejectBand.pass).toBe(false);
    expect(rejectBand.reviewNeeded).toBeUndefined();
    expect(rejectBand.score).toBeCloseTo(2, 9);
  });
});

describe("runReflectQualityJudge — per-criterion scores (R16)", () => {
  test("the reflect judge's new-shape criteria use its own criterion names", async () => {
    const result = await runReflectQualityJudge(configWithLlm(), "candidate content", "source content", [], async () =>
      JSON.stringify({
        scores: { feedbackAlignment: 4, preservation: 5, quality: 4 },
        reason: "addresses feedback",
      }),
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo((4 + 5 + 4) / 3, 9);
    expect(result.criteria).toEqual({ feedbackAlignment: 4, preservation: 5, quality: 4 });
  });
});
