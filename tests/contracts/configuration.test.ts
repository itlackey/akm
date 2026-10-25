import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AkmConfigSchema } from "../../src/core/config/config-schema";
import { activeMarkdownDocs, readDoc, retiredExecutionExamples } from "./contract-helpers";

describe("current connection, harness and strategy configuration contract", () => {
  const repoRoot = path.resolve(import.meta.dir, "..", "..");

  test("accepts connections, harnesses and improve strategies", () => {
    expect(() =>
      AkmConfigSchema.parse({
        configVersion: "0.9.0",
        connections: { fast: { endpoint: "https://example.test/v1", models: { fast: "qwen3" } } },
        harnesses: { opencode: {} },
        improve: {
          strategy: "nightly",
          connection: "fast",
          strategies: { nightly: { processes: { reflect: {} } } },
        },
      }),
    ).not.toThrow();
  });

  test("retired profile-based execution configuration is an unknown key", () => {
    // `profiles` is an unknown key: warned about by the loader and ignored, never a schema error.
    expect(AkmConfigSchema.safeParse({ configVersion: "0.9.0", profiles: { llm: {} } }).success).toBe(true);
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

  test("active documentation does not use retired execution selectors", () => {
    const violations = activeMarkdownDocs().flatMap((docPath) =>
      retiredExecutionExamples(readDoc(docPath)).map((kind) => `${docPath}: ${kind}`),
    );
    expect(violations).toEqual([]);
  });

  test("active documentation scan covers public entry points and excludes historical and design trees", () => {
    const scanned = activeMarkdownDocs().map((docPath) => path.relative(repoRoot, docPath));
    // The static help-asset dir was emptied when its orphaned files were pruned
    // (nothing loaded them); the scan must mirror whatever exists — including
    // nothing — so tolerate the dir's absence.
    const helpRoot = path.join(repoRoot, "src", "assets", "help");
    const helpDocs = fs.existsSync(helpRoot)
      ? fs
          .readdirSync(helpRoot)
          .filter((name) => name.endsWith(".md"))
          .map((name) => path.join("src", "assets", "help", name))
      : [];

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
      "Configure `connections.fast.endpoint`, `improve.connection`, and `--connection fast`.",
      "## Retired Configuration",
      "`llm.endpoint`, `defaults.agent`, `--profile`, and `runner:` are retired.",
    ].join("\n");
    expect(retiredExecutionExamples(example)).toEqual([]);
  });
});
