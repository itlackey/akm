import type { AkmConfig } from "../../src/core/config/config";

const TEST_LLM_ENGINE = "default";

/**
 * Add a non-networked LLM selection for improve orchestration tests that inject
 * their model calls.
 *
 * This helper wires CONNECTIONS ONLY. It deliberately does not touch
 * `experimental.improveAutonomy`: an earlier revision granted autonomy here,
 * which silently ran every one of its ~20 caller suites — most of them testing
 * behaviour unrelated to the gated lanes — under a non-default config. A suite
 * that exercises consolidate/memory-inference/cleanup/contradiction opts in
 * visibly with {@link withImproveAutonomy} instead, so the grant is readable at
 * the suite that depends on it.
 */
export function withTestImproveLlm(config: AkmConfig): AkmConfig {
  return {
    ...config,
    connections: {
      [TEST_LLM_ENGINE]: {
        endpoint: "http://127.0.0.1:1/v1",
        models: { fast: "test-model", balanced: "test-model", reasoning: "test-model" },
      },
      ...config.connections,
    },
  };
}

/**
 * Opt a test config into `experimental.improveAutonomy` (D8).
 *
 * Use ONLY in suites that exercise the gated lanes — consolidate
 * merge/delete, memory-inference writes, the memory-cleanup and contradiction
 * passes, or triage `applyMode: "promote"`. Tests of the gate itself must NOT
 * use this: they need the shipped review-first default and build their configs
 * directly (`tests/improve-autonomy-gate.test.ts`,
 * `tests/improve-plan-autonomy-wiring.test.ts`).
 */
export function withImproveAutonomy(config: AkmConfig): AkmConfig {
  return {
    ...config,
    experimental: {
      improveAutonomy: true,
      ...config.experimental,
    },
  };
}
