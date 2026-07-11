import { describe, expect, test } from "bun:test";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import { ARCHITECTURE_PATH, extractSection, readDoc } from "./spec-helpers";

// Current execution boundary invariants:
//   * In-tree LLM helpers are bounded, single-shot, stateless — no shells,
//     no long-running processes, no caches keyed on prior responses.
//   * Agent engines lower to either the CLI spawn runner or the embedded SDK
//     runner; callers dispatch only through RunnerSpec.

describe("current engine and runtime boundary", () => {
  const section = extractSection(readDoc(ARCHITECTURE_PATH), "## Engine Boundary");
  const config = {
    engines: {
      fast: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "qwen3" },
      reviewer: { kind: "agent" as const, platform: "opencode" },
      sdk: { kind: "agent" as const, platform: "opencode-sdk", llmEngine: "fast" },
    },
    defaults: { engine: "reviewer", llmEngine: "fast" },
  };

  test("current architecture defines named engines and RunnerSpec lowering", () => {
    expect(section).toContain("named `engines`");
    expect(section).toContain("RunnerSpec");
    expect(section).toContain("executeRunner()");
  });

  test("in-tree LLM calls remain bounded, single-shot, and stateless", () => {
    expect(section).toMatch(/bounded/i);
    expect(section).toMatch(/single-shot/i);
    expect(section).toMatch(/stateless/i);
  });

  test("runtime lowers LLM, spawned agent, and SDK engines distinctly", () => {
    expect(resolveEngine("fast", config).kind).toBe("llm");
    expect(resolveEngine("reviewer", config).kind).toBe("agent");
    expect(resolveEngine("sdk", config).kind).toBe("sdk");
  });

  test("an explicit missing engine fails instead of falling through", () => {
    expect(() => resolveEngine("missing", config)).toThrow('Engine "missing" is not configured');
  });
});
