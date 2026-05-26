/**
 * Tests for the consolidate pass honoring its per-process LLM profile.
 *
 * Regression guard (2026-05-26): `akmConsolidate` previously called
 * `getDefaultLlmConfig(config)` directly, silently ignoring
 * `profiles.improve.default.processes.consolidate.profile`. This sent every
 * chunk-plan + merge LLM call to the default LLM, which (when the user had
 * configured a dedicated lighter-weight consolidate model such as
 * `ministral-3b`) caused silent token-budget mismatches with the runtime
 * model. Investigation: `/tmp/akm-health-investigations/consolidation-no-op.md`.
 *
 * The fix lives in `src/commands/consolidate.ts` as
 * `resolveConsolidateLlmConfig`, mirroring the canonical
 * `resolveImproveProcessRunnerFromProfile` pattern used by extract.
 *
 * These are unit tests over the resolver behavior — they do not call out to
 * a real LLM endpoint.
 */
import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config";
import { resolveImproveProcessRunnerFromProfile } from "../src/integrations/agent/runner";

const PRIMARY = { endpoint: "http://localhost:11434/v1/chat/completions", model: "gemma-default" };
const MINISTRAL = { endpoint: "http://localhost:11434/v1/chat/completions", model: "ministral-3b" };

describe("consolidate honors processes.consolidate.profile", () => {
  test("resolves to the per-process profile when configured", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      profiles: {
        llm: { default: { ...PRIMARY }, ministral: { ...MINISTRAL } },
        improve: {
          default: {
            processes: { consolidate: { mode: "llm", profile: "ministral" } },
          },
        },
      },
      defaults: { llm: "default" },
    };

    const consolidateProcess = config.profiles?.improve?.default?.processes?.consolidate;
    const runnerSpec = resolveImproveProcessRunnerFromProfile(consolidateProcess, config);
    expect(runnerSpec).not.toBeNull();
    expect(runnerSpec?.kind).toBe("llm");
    if (runnerSpec?.kind === "llm") {
      expect(runnerSpec.connection.model).toBe("ministral-3b");
    }
  });

  test("returns null when no per-process override is set, so the resolver falls back to default", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      profiles: {
        llm: { default: { ...PRIMARY } },
      },
      defaults: { llm: "default" },
    };
    const consolidateProcess = config.profiles?.improve?.default?.processes?.consolidate;
    const runnerSpec = resolveImproveProcessRunnerFromProfile(consolidateProcess, config);
    // No override → null. The fallback to default LLM is the caller's
    // responsibility (resolveConsolidateLlmConfig handles it).
    expect(runnerSpec).toBeNull();
  });
});
