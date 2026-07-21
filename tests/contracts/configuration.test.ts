import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
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
  const repoRoot = path.resolve(import.meta.dir, "..", "..");

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

  test("rejects writable cache-backed website and npm bundles (#37: sources key itself is retired)", () => {
    expect(
      AkmConfigSchema.safeParse({
        bundles: { docs: { website: { url: "https://example.test" }, writable: true } },
      }).success,
    ).toBe(false);
    expect(AkmConfigSchema.safeParse({ bundles: { pkg: { npm: "example", writable: true } } }).success).toBe(false);
    // And the retired source-shape keys are rejected outright.
    expect(AkmConfigSchema.safeParse({ sources: [] }).success).toBe(false);
    expect(AkmConfigSchema.safeParse({ stashDir: "/tmp/x" }).success).toBe(false);
    expect(AkmConfigSchema.safeParse({ installed: [] }).success).toBe(false);
  });

  test("current docs define engines, strategies, and retired profile keys", () => {
    expect(extractSection(docs, "## Engines")).toContain("`engines` is the only public execution map");
    expect(extractSection(docs, "## Strategies")).toContain("improve.strategies");
    expect(extractSection(docs, "## Retired Configuration")).toContain("`profiles`");
  });

  test("active documentation does not use retired execution selectors", () => {
    const violations = activeMarkdownDocs().flatMap((docPath) =>
      retiredExecutionExamples(readDoc(docPath)).map((kind) => `${docPath}: ${kind}`),
    );
    expect(violations).toEqual([]);
  });

  test("active documentation scan covers public entry points and excludes historical and design trees", () => {
    const scanned = activeMarkdownDocs().map((docPath) => path.relative(repoRoot, docPath));
    const helpDocs = fs
      .readdirSync(path.join(repoRoot, "src", "assets", "help"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join("src", "assets", "help", name));

    expect(scanned).toEqual(
      expect.arrayContaining(["README.md", path.join(".github", "README.npm.md"), "SECURITY.md", "STABILITY.md"]),
    );
    expect(scanned.filter((docPath) => docPath.startsWith(path.join("src", "assets", "help")))).toEqual(
      helpDocs.sort(),
    );
    expect(
      scanned.filter((docPath) =>
        /(^|[\\/])docs[\\/](?:archive|design|historical|incidents|migration|posts|reviews)(?:[\\/]|$)/.test(docPath),
      ),
    ).toEqual([]);
  });

  test("retired execution scan covers prose, inline, CLI, JSON, and fenced forms", () => {
    const example = [
      "Configure `llm.endpoint` before running the command.",
      "The default remains `defaults.agent`.",
      "Run `akm wiki ingest docs --profile reviewer`.",
      "runner: sdk",
      "```yaml",
      "profile: reviewer",
      "akm workflow run --runner sdk",
      "defaults:",
      "  agent: opencode",
      "```",
      "```json",
      '{"profiles": {}, "defaults": {"agent": "opencode"}}',
      "```",
    ].join("\n");
    expect(retiredExecutionExamples(example)).toEqual(["profile/runner", "defaults.agent", "llm.endpoint"]);
  });

  test("retired execution scan ignores ordinary words, current selectors, and explicit retirement sections", () => {
    const example = [
      "Use your shell profile with the workflow runner.",
      "Configure `engines.fast.endpoint`, `defaults.engine`, and `--engine fast`.",
      "## Retired Configuration",
      "`llm.endpoint`, `defaults.agent`, `--profile`, and `runner:` are retired.",
    ].join("\n");
    expect(retiredExecutionExamples(example)).toEqual([]);
    expect(retiredExecutionExamples(extractSection(docs, "## Retired Configuration"))).toEqual([]);
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
