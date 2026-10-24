import { inferenceWireFields } from "../../src/core/llm-inference";
import { DEFAULT_LLM_TIMEOUT_MS } from "../../src/integrations/agent/config";
import type { ConnectionRunner, RunnerSpec } from "../../src/integrations/agent/runner";
import type { ChatCompletionConfig } from "../../src/llm/client";

/** Build symbolic runner material for transport-focused tests without adding a runtime adapter. */
export function testLlmRunner(config: ChatCompletionConfig, name = "test-llm"): ConnectionRunner {
  if (config.apiKey !== undefined) throw new TypeError("test runners must not contain materialized credentials");
  return {
    kind: "connection",
    name,
    endpoint: config.endpoint,
    model: config.model,
    request: { ...config.request, ...inferenceWireFields(config) },
    ...(config.contextLength !== undefined ? { contextLength: config.contextLength } : {}),
    timeoutMs: Object.hasOwn(config, "timeoutMs") ? (config.timeoutMs ?? null) : DEFAULT_LLM_TIMEOUT_MS,
  };
}

/** Narrow a resolved runner to the connection kind, failing the test when it is a harness or none. */
export function asLlmRunner(runner: RunnerSpec | null | undefined): ConnectionRunner {
  if (runner?.kind !== "connection") throw new Error(`expected a connection runner, got ${runner?.kind ?? "none"}`);
  return runner;
}
