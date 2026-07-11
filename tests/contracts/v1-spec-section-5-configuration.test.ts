import { describe, expect, test } from "bun:test";
import { AkmConfigSchema } from "../../src/core/config/config-schema";
import { CONFIG_DOC_PATH, extractSection, readDoc } from "./spec-helpers";

describe("current engine and strategy configuration contract", () => {
  const docs = readDoc(CONFIG_DOC_PATH);

  test("accepts named LLM/agent engines and improve strategies", () => {
    expect(() =>
      AkmConfigSchema.parse({
        configVersion: "0.9.0",
        engines: {
          fast: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "qwen3" },
          reviewer: { kind: "agent", platform: "opencode" },
        },
        defaults: { engine: "reviewer", llmEngine: "fast", improveStrategy: "nightly" },
        improve: { strategies: { nightly: { engine: "fast", processes: { reflect: {} } } } },
      }),
    ).not.toThrow();
  });

  test("rejects retired profile-based execution configuration", () => {
    expect(AkmConfigSchema.safeParse({ profiles: { llm: {} } }).success).toBe(false);
    expect(AkmConfigSchema.safeParse({ defaults: { agent: "reviewer" } }).success).toBe(false);
  });

  test("rejects writable cache-backed website and npm sources", () => {
    expect(
      AkmConfigSchema.safeParse({
        sources: [{ type: "website", name: "docs", url: "https://example.test", writable: true }],
      }).success,
    ).toBe(false);
    expect(
      AkmConfigSchema.safeParse({ sources: [{ type: "npm", name: "pkg", package: "example", writable: true }] })
        .success,
    ).toBe(false);
  });

  test("current docs define engines, strategies, and retired profile keys", () => {
    expect(extractSection(docs, "## Engines")).toContain("`engines` is the only public execution map");
    expect(extractSection(docs, "## Strategies")).toContain("improve.strategies");
    expect(extractSection(docs, "## Retired Configuration")).toContain("`profiles`");
  });
});
