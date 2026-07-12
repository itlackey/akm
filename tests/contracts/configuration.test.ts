import { describe, expect, test } from "bun:test";
import { AkmConfigSchema } from "../../src/core/config/config-schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import {
  activeMarkdownDocs,
  CONFIG_DOC_PATH,
  extractSection,
  PR_714_REPRO_PATH,
  readDoc,
  retiredExecutionExamples,
} from "./contract-helpers";

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

  test("active documentation examples do not use retired execution selectors", () => {
    const violations = activeMarkdownDocs().flatMap((docPath) =>
      retiredExecutionExamples(readDoc(docPath)).map((kind) => `${docPath}: ${kind}`),
    );
    expect(violations).toEqual([]);
  });

  test("retired execution example scan covers profile, runner, and defaults.agent forms", () => {
    const example = [
      "```yaml",
      "profile: reviewer",
      "runner: agent",
      "defaults:",
      "  agent: opencode",
      "```",
      "```json",
      '{"profiles": {}, "defaults": {"agent": "opencode"}}',
      "```",
    ].join("\n");
    expect(retiredExecutionExamples(example)).toEqual(["profile/runner", "defaults.agent"]);
  });

  test("PR 714 repro embeds valid engine configs and YAML v2 workflows", () => {
    const repro = readDoc(PR_714_REPRO_PATH);
    const configs = [...repro.matchAll(/config\.json" <<'EOF'\n([\s\S]*?)\nEOF/g)].map((match) => JSON.parse(match[1]));
    const workflows = [...repro.matchAll(/workflows\/[^"\n]+\.yaml" <<'EOF'\n([\s\S]*?)\nEOF/g)].map(
      (match) => match[1],
    );

    expect(configs).toHaveLength(2);
    expect(workflows).toHaveLength(7);
    for (const config of configs) expect(AkmConfigSchema.safeParse(config).success).toBe(true);
    for (const [index, workflow] of workflows.entries()) {
      expect(parseWorkflowProgram(workflow, { path: `pr-714-repro-${index}.yaml` }).ok).toBe(true);
    }
  });
});
