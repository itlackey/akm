import { resolveImproveExecution } from "../../src/commands/improve/execution";
import type { AkmConfig } from "../../src/core/config/config";
import { SHIPPED_ALIAS } from "../../src/core/config/model-aliases";
import type { RunnerSpec } from "../../src/integrations/agent/runner";

/**
 * Give a memory-inference pass the runner `akm improve` would: resolved for `memoryInference` from `improve.*` and
 * the default connection, `null` when nothing resolves. The pass makes no model call without one; it does not read
 * the config to find where to run.
 */
export function withImproveRunner<T extends { config: AkmConfig; llmRunner?: RunnerSpec | null }>(
  ctx: T,
): T & { llmRunner: RunnerSpec | null } {
  if (Object.hasOwn(ctx, "llmRunner")) return ctx as T & { llmRunner: RunnerSpec | null };
  const resolved = resolveImproveExecution({
    config: ctx.config,
    processName: "memoryInference",
    alias: SHIPPED_ALIAS.improve,
  });
  return { ...ctx, llmRunner: resolved?.runner ?? null };
}
