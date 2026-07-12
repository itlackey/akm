import type { AkmConfig } from "../../src/core/config/config";

const TEST_LLM_ENGINE = "test-improve-llm";

/** Add a non-networked LLM selection for improve orchestration tests that inject their model calls. */
export function withTestImproveLlm(config: AkmConfig): AkmConfig {
  return {
    ...config,
    engines: {
      [TEST_LLM_ENGINE]: {
        kind: "llm",
        endpoint: "http://127.0.0.1:1/v1/chat/completions",
        model: "test-model",
      },
      ...config.engines,
    },
    defaults: {
      llmEngine: TEST_LLM_ENGINE,
      ...config.defaults,
    },
  };
}
