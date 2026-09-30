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
  buildJudgePrompt,
  buildReflectJudgePrompt,
  runLessonQualityJudge,
  runReflectQualityJudge,
} from "../../../src/commands/improve/stage";
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

describe("runLessonQualityJudge — per-criterion scores (R16 / JUDGE2)", () => {
  test('new-shape {"scores": {...}} JSON parses to the correct average and exposes criteria', async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 4, nonRedundancy: 3, grounding: 5 }, reason: "solid" }),
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo((4 + 3) / 2, 9);
    expect(result.criteria).toEqual({ novelty: 4, nonRedundancy: 3, grounding: 5 });
  });

  test("JUDGE2: an unexpected extra key (e.g. dropped ACTIONABILITY) is ignored — not averaged, not validated", async () => {
    // A model still echoing the retired ACTIONABILITY criterion, or one wildly
    // out of range (99), must not change the score or fail the parse: only
    // the three expected keys (novelty, nonRedundancy, grounding) are read.
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 4, actionability: 99, nonRedundancy: 3, grounding: 5 }, reason: "solid" }),
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBeCloseTo((4 + 3) / 2, 9);
    expect(result.criteria).toEqual({ novelty: 4, nonRedundancy: 3, grounding: 5 });
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
      JSON.stringify({ scores: { novelty: 0, nonRedundancy: 4, grounding: 4 }, reason: "bad" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
    expect(result.criteria).toBeUndefined();
  });

  test("a criterion of 7 (out of range) routes to review exactly as a parse failure does today", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 7, nonRedundancy: 4, grounding: 4 }, reason: "bad" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("an empty scores object routes to review exactly as a parse failure does today", async () => {
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      // `scores` present but empty — no usable criteria at all.
      JSON.stringify({ scores: {}, reason: "bad" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
  });

  test("a partial scores object (missing criterion key) routes to review exactly as a parse failure does today", async () => {
    // Only `novelty` present — `nonRedundancy` is missing. A truncated or
    // partial judge response must not auto-average over whatever arrived.
    const result = await runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores: { novelty: 5 }, reason: "partial" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
    expect(result.criteria).toBeUndefined();
  });

  test("the review-needed and auto-reject thresholds (3.5 / 2.5) are unchanged for the averaged criteria score", async () => {
    const reviewBand = await runLessonQualityJudge(configWithLlm(), "body", "source", async () =>
      JSON.stringify({ scores: { novelty: 3, nonRedundancy: 3, grounding: 4 }, reason: "uncertain" }),
    );
    expect(reviewBand.pass).toBe(false);
    expect(reviewBand.reviewNeeded).toBe(true);
    expect(reviewBand.score).toBeCloseTo(3, 9);

    const rejectBand = await runLessonQualityJudge(configWithLlm(), "body", "source", async () =>
      JSON.stringify({ scores: { novelty: 2, nonRedundancy: 2, grounding: 4 }, reason: "weak" }),
    );
    expect(rejectBand.pass).toBe(false);
    expect(rejectBand.reviewNeeded).toBeUndefined();
    expect(rejectBand.score).toBeCloseTo(2, 9);
  });
});

// #999: distill minted lessons about an `akm show` failure (recorded as feedback)
// for memories on unrelated subjects. A lesson about a different subject than
// its source reads as novel and non-redundant, so the mean of those two alone
// passes it or lands it in the review band, where it became a pending proposal.
describe("runLessonQualityJudge — grounding rejects outright and is not averaged (#999)", () => {
  const judge = (scores: Record<string, number>, reason = "one sentence from the judge") =>
    runLessonQualityJudge(configWithLlm(), "some lesson body", "some source body", async () =>
      JSON.stringify({ scores, reason }),
    );

  test("grounding 1 rejects outright although novelty and non-redundancy alone would pass", async () => {
    const result = await judge(
      { novelty: 5, nonRedundancy: 5, grounding: 1 },
      "The lesson is about duplicate refs; the source is a performance runbook.",
    );

    expect(result.pass).toBe(false);
    expect(result.reviewNeeded).toBeUndefined();
    expect(result.score).toBeCloseTo(5, 9);
    expect(result.criteria).toEqual({ novelty: 5, nonRedundancy: 5, grounding: 1 });
    expect(result.reason).toContain("Off-subject for its source (grounding 1/5)");
    expect(result.reason).toContain("The lesson is about duplicate refs; the source is a performance runbook.");
  });

  test("grounding 2 rejects outright instead of routing the review band to review", async () => {
    const result = await judge({ novelty: 3, nonRedundancy: 3, grounding: 2 });

    expect(result.pass).toBe(false);
    expect(result.reviewNeeded).toBeUndefined();
    expect(result.reason).toContain("(grounding 2/5)");
  });

  test("grounding 3 is not a veto: the mean of novelty and non-redundancy decides", async () => {
    const passes = await judge({ novelty: 4, nonRedundancy: 4, grounding: 3 });
    expect(passes.pass).toBe(true);

    const review = await judge({ novelty: 3, nonRedundancy: 3, grounding: 3 });
    expect(review.pass).toBe(false);
    expect(review.reviewNeeded).toBe(true);
    expect(review.reason).toBe("one sentence from the judge");
  });

  test("grounding is not part of the mean, so the pass, review and reject bands are unchanged", async () => {
    const pass = await judge({ novelty: 4, nonRedundancy: 4, grounding: 5 });
    expect(pass.pass).toBe(true);
    expect(pass.score).toBeCloseTo(4, 9);

    // A fully grounded but redundant lesson stays rejected: grounding 5 does not lift 2.0 into the review band.
    const reject = await judge({ novelty: 2, nonRedundancy: 2, grounding: 5 });
    expect(reject.pass).toBe(false);
    expect(reject.reviewNeeded).toBeUndefined();
    expect(reject.score).toBeCloseTo(2, 9);
    expect(reject.reason).toBe("one sentence from the judge");
  });

  test("scores without grounding are a partial reply, routed to review like any other missing criterion", async () => {
    const result = await judge({ novelty: 5, nonRedundancy: 5 });

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
    expect(result.criteria).toBeUndefined();
  });

  test("the judge prompt defines the grounding criterion and asks for it in the reply", () => {
    const prompt = buildJudgePrompt("lesson body", "source body");

    expect(prompt).toContain("Score this lesson");
    expect(prompt).toContain("3. GROUNDING:");
    expect(prompt).toContain('"grounding": <1-5 integer>');
  });

  // The judge never sees the feedback a lesson is distilled from, and a lesson
  // that corrects its source (the source says port 8080, feedback says it
  // clashes, the lesson says use 8081) is on the source's subject. A
  // contradiction is not this criterion's to reject: the optional fidelity
  // check routes it to a human.
  test("the rubric reserves 1-2 for a different subject, so a lesson that corrects its source scores 3", () => {
    const prompt = buildJudgePrompt("lesson body", "source body");

    expect(prompt).toContain(
      "Score 1-2 only if it is about a different subject than the source; 3 if it is on the source's subject but goes beyond or corrects what the source says (it may draw on feedback you are not shown); 4-5 if the source supports it.",
    );
    expect(prompt).not.toMatch(/contradict/i);
  });

  // Distill generates from the first 3000 characters of the source body
  // (buildDistillPrompt). A judge that reads fewer would call a lesson drawn
  // from later in the source off-subject, and grounding can now reject.
  test("the judge reads the same 3000 characters of source the generator did", () => {
    const source = `${"a".repeat(2500)}INSIDE_WINDOW${"b".repeat(600)}BEYOND_WINDOW`;
    const prompt = buildJudgePrompt("lesson body", source);

    expect(prompt).toContain("INSIDE_WINDOW");
    expect(prompt).not.toContain("BEYOND_WINDOW");
  });

  test("the instruction to rate similar existing lessons lower names the criteria it applies to", () => {
    const prompt = buildJudgePrompt("lesson body", "source body", [{ ref: "lessons/other", content: "Other lesson." }]);

    expect(prompt).toContain("Rate NOVELTY and NON-REDUNDANCY lower if the proposed lesson is substantially similar");
  });

  test("grounding belongs to the lesson judge: a reflect verdict neither reads nor is vetoed by it", async () => {
    const result = await runReflectQualityJudge(configWithLlm(), "candidate content", "source content", [], async () =>
      JSON.stringify({
        scores: { feedbackAlignment: 4, preservation: 4, quality: 4, grounding: 1 },
        reason: "addresses feedback",
      }),
    );

    expect(result.pass).toBe(true);
    expect(result.criteria).toEqual({ feedbackAlignment: 4, preservation: 4, quality: 4 });
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

  test("a partial scores object (missing criterion key) routes to review, using its own key set", async () => {
    // Only `feedbackAlignment` present — `preservation` and `quality` are missing.
    const result = await runReflectQualityJudge(configWithLlm(), "candidate content", "source content", [], async () =>
      JSON.stringify({ scores: { feedbackAlignment: 5 }, reason: "partial" }),
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.reviewNeeded).toBe(true);
    expect(result.criteria).toBeUndefined();
  });
});

describe("runLessonQualityJudge / runReflectQualityJudge — responseSchema (JUDGE2)", () => {
  function configWithSchemaSupport(supportsJsonSchema: boolean): AkmConfig {
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
          supportsJsonSchema,
        },
      },
      defaults: { llmEngine: "default" },
    } as unknown as AkmConfig;
  }

  test("lesson judge sends a responseSchema with exactly its three expected keys when supportsJsonSchema: true", async () => {
    let receivedSchema: Record<string, unknown> | undefined;
    const result = await runLessonQualityJudge(
      configWithSchemaSupport(true),
      "some lesson body",
      "some source body",
      async (_connection, _messages, options) => {
        receivedSchema = options?.responseSchema;
        return JSON.stringify({ scores: { novelty: 4, nonRedundancy: 4, grounding: 4 }, reason: "ok" });
      },
    );

    expect(result.pass).toBe(true);
    expect(receivedSchema).toBeDefined();
    const scoresSchema = (
      receivedSchema as { properties: { scores: { required: string[]; properties: Record<string, unknown> } } }
    ).properties.scores;
    expect(scoresSchema.required).toEqual(["novelty", "nonRedundancy", "grounding"]);
    expect(Object.keys(scoresSchema.properties)).toEqual(["novelty", "nonRedundancy", "grounding"]);
  });

  test("lesson judge sends no responseSchema when the runner does not opt into supportsJsonSchema", async () => {
    let receivedSchema: Record<string, unknown> | undefined;
    let schemaKeyPresent = true;
    const result = await runLessonQualityJudge(
      configWithSchemaSupport(false),
      "some lesson body",
      "some source body",
      async (_connection, _messages, options) => {
        schemaKeyPresent = Boolean(options && Object.hasOwn(options, "responseSchema"));
        receivedSchema = options?.responseSchema;
        return JSON.stringify({ scores: { novelty: 4, nonRedundancy: 4, grounding: 4 }, reason: "ok" });
      },
    );

    expect(result.pass).toBe(true);
    expect(schemaKeyPresent).toBe(false);
    expect(receivedSchema).toBeUndefined();
  });

  test("reflect judge's responseSchema uses the reflect judge's own criteria keys", async () => {
    let receivedSchema: Record<string, unknown> | undefined;
    const result = await runReflectQualityJudge(
      configWithSchemaSupport(true),
      "candidate content",
      "source content",
      [],
      async (_connection, _messages, options) => {
        receivedSchema = options?.responseSchema;
        return JSON.stringify({
          scores: { feedbackAlignment: 4, preservation: 4, quality: 4 },
          reason: "ok",
        });
      },
    );

    expect(result.pass).toBe(true);
    const scoresSchema = (receivedSchema as { properties: { scores: { required: string[] } } }).properties.scores;
    expect(scoresSchema.required).toEqual(["feedbackAlignment", "preservation", "quality"]);
  });
});
