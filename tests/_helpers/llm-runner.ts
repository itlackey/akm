import type { LlmConnectionConfig } from "../../src/core/config/config-types";
import type { LlmRunner, RunnerSpec } from "../../src/integrations/agent/runner";
import type { ChatCompletionConfig } from "../../src/llm/client";

/** Build symbolic runner material for transport-focused tests without adding a runtime adapter. */
export function testLlmRunner(config: ChatCompletionConfig, engine = config.provider ?? "test-llm"): LlmRunner {
  if (config.apiKey !== undefined) throw new TypeError("test runners must not contain materialized credentials");
  const connection = { ...config };
  delete connection.timeoutMs;
  return {
    kind: "llm",
    engine,
    connection: connection as LlmConnectionConfig,
    ...(Object.hasOwn(config, "timeoutMs") ? { timeoutMs: config.timeoutMs ?? null } : {}),
  };
}

/** Narrow a resolved runner to the llm kind, failing the test when it is another kind or none. */
export function asLlmRunner(runner: RunnerSpec | null | undefined): LlmRunner {
  if (runner?.kind !== "llm") throw new Error(`expected an llm runner, got ${runner?.kind ?? "none"}`);
  return runner;
}
