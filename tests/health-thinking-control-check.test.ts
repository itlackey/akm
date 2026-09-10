import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import type { LlmUsageAggregate, LlmUsageStageAggregate } from "../src/commands/health/types";

// #949: `thinking-control` is a passive advisory — it never issues a chat
// completion of its own (a cold local model must not be woken just to check
// it). It re-reads the reasoningTokens figure the window's llm_usage
// aggregate already carries per engine (client.ts already warns to stderr on
// every real call where this happens) and surfaces it as a structured
// akm health finding. The check is a pure projection of
// ctx.thinkingOffEngines / ctx.llmUsage, so we drive it directly.

const check = HEALTH_CHECKS.find((c) => c.name === "thinking-control");

function stageAggregate(overrides: Partial<LlmUsageStageAggregate> = {}): LlmUsageStageAggregate {
  return {
    calls: 0,
    totalDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    failures: 0,
    ...overrides,
  };
}

function usageAggregate(byEngine: Record<string, LlmUsageStageAggregate>): LlmUsageAggregate {
  const totals = Object.values(byEngine).reduce(
    (acc, entry) => ({
      calls: acc.calls + entry.calls,
      totalDurationMs: acc.totalDurationMs + entry.totalDurationMs,
      promptTokens: acc.promptTokens + entry.promptTokens,
      completionTokens: acc.completionTokens + entry.completionTokens,
      totalTokens: acc.totalTokens + entry.totalTokens,
      reasoningTokens: acc.reasoningTokens + entry.reasoningTokens,
      failures: acc.failures + entry.failures,
    }),
    stageAggregate(),
  );
  return { ...totals, byStage: {}, byProcess: {}, byEngine };
}

function run(thinkingOffEngines: string[], llmUsage: LlmUsageAggregate, since = "2024-01-01T00:00:00.000Z") {
  if (!check) throw new Error("thinking-control check not registered");
  return check.run({ thinkingOffEngines, llmUsage, since } as unknown as HealthCheckContext);
}

describe("thinking-control check (#949)", () => {
  test("is registered as an advisory check", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("advisory");
  });

  test("is registered before the #950/#953 trailing advisories (order is load-bearing)", () => {
    const names = HEALTH_CHECKS.map((c) => c.name);
    const thinkingControlIndex = names.indexOf("thinking-control");
    expect(thinkingControlIndex).toBeGreaterThanOrEqual(0);
    expect(names.slice(thinkingControlIndex)).toEqual([
      "thinking-control",
      "cli-version",
      "engine-last-used",
      "scheduler-binary",
    ]);
  });

  test("unknown when no configured engine sets enableThinking: false", () => {
    const r = run([], usageAggregate({}));
    expect(r.status).toBe("unknown");
    expect(r.evidence?.engines).toEqual([]);
  });

  test("unknown for an engine with no calls recorded in the window", () => {
    const r = run(["local"], usageAggregate({}));
    expect(r.status).toBe("unknown");
  });

  test("pass when the configured engine's calls carried zero reasoning tokens", () => {
    const r = run(["local"], usageAggregate({ local: stageAggregate({ calls: 4, reasoningTokens: 0 }) }));
    expect(r.status).toBe("pass");
    expect(r.message).toContain("local");
  });

  test("warn and name the engine when reasoning tokens leaked through despite enableThinking: false", () => {
    const r = run(["local"], usageAggregate({ local: stageAggregate({ calls: 4, reasoningTokens: 17 }) }));
    expect(r.status).toBe("warn");
    expect(r.message).toContain('LLM engine "local"');
    expect(r.message).toContain("17 reasoning tokens");
    expect(r.message).toContain("since 2024-01-01T00:00:00.000Z");
    expect(r.message).toContain("enableThinking: false");
    expect(r.message.toLowerCase()).toContain("gateway");
  });

  test("warn wins even when a second thinking-off engine passes", () => {
    const r = run(
      ["gateway-a", "direct-b"],
      usageAggregate({
        "gateway-a": stageAggregate({ calls: 2, reasoningTokens: 5 }),
        "direct-b": stageAggregate({ calls: 2, reasoningTokens: 0 }),
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.message).toContain('"gateway-a"');
  });

  test("never issues a chat completion — it is a pure projection of the passed-in context", () => {
    // No engine had zero calls: the aggregate is entirely synthetic, no LLM
    // client or network seam is imported or invoked by this test at all.
    const r = run(["local"], usageAggregate({ local: stageAggregate({ calls: 1, reasoningTokens: 0 }) }));
    expect(r.status).toBe("pass");
  });
});
