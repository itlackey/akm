import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config";
import { loadUserConfig, resetConfigCache } from "../src/core/config";
import { ConfigError } from "../src/core/errors";
import { getConfigPath } from "../src/core/paths";
import { resolveIndexPassLLM } from "../src/llm/index-passes";
import { type Cleanup, sandboxXdgConfigHome } from "./_helpers/sandbox";

// Tests for #208 — unified `akm.llm` config across all index-time passes.

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cfgResult = sandboxXdgConfigHome();
  envCleanup = cfgResult.cleanup;
  resetConfigCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  resetConfigCache();
});

function writeUserConfig(raw: object): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
}

const SAMPLE_LLM = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

describe("resolveIndexPassLLM", () => {
  test("returns undefined when no top-level llm is configured", () => {
    const config: AkmConfig = { semanticSearchMode: "auto" };
    expect(resolveIndexPassLLM("enrichment", config)).toBeUndefined();
    expect(resolveIndexPassLLM("graph", config)).toBeUndefined();
  });

  test("returns the default profile by default for any pass", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      profiles: { llm: { default: { ...SAMPLE_LLM } } },
      defaults: { llm: "default" },
    };
    expect(resolveIndexPassLLM("enrichment", config)).toEqual(SAMPLE_LLM);
    expect(resolveIndexPassLLM("memory", config)).toEqual(SAMPLE_LLM);
    expect(resolveIndexPassLLM("graph", config)).toEqual(SAMPLE_LLM);
  });

  test("per-pass `llm: false` opts that pass out, leaving siblings intact", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      profiles: { llm: { default: { ...SAMPLE_LLM } } },
      defaults: { llm: "default" },
      index: {
        enrichment: { llm: false },
        graph: { llm: true },
      },
    };
    expect(resolveIndexPassLLM("enrichment", config)).toBeUndefined();
    expect(resolveIndexPassLLM("graph", config)).toEqual(SAMPLE_LLM);
    expect(resolveIndexPassLLM("memory", config)).toEqual(SAMPLE_LLM);
  });

  test("per-pass `llm: true` is equivalent to default", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      profiles: { llm: { default: { ...SAMPLE_LLM } } },
      defaults: { llm: "default" },
      index: { enrichment: { llm: true } },
    };
    expect(resolveIndexPassLLM("enrichment", config)).toEqual(SAMPLE_LLM);
  });
});

describe("config loader: `index` block parsing", () => {
  test("loads valid `index.<pass>.llm` boolean values", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: {
        enrichment: { llm: false },
        graph: { llm: true },
      },
    });
    const config = loadUserConfig();
    expect(config.index).toEqual({
      enrichment: { llm: false },
      graph: { llm: true },
    });
  });

  test("loads graphExtractionIncludeTypes for graph pass", async () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: {
        graph: { llm: true, graphExtractionIncludeTypes: ["memory", "command"] },
      },
    });
    const config = loadUserConfig();
    const { getIndexPassConfig } = await import("../src/core/config");
    expect(getIndexPassConfig(config.index, "graph")?.graphExtractionIncludeTypes).toEqual(["memory", "command"]);
  });

  test("rejects per-pass provider configuration (duplicate provider path)", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: {
        enrichment: {
          endpoint: "http://other-host/v1/chat/completions",
          model: "other-model",
        },
      },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
    try {
      loadUserConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("INVALID_CONFIG_FILE");
      expect((err as Error).message).toContain("Duplicate LLM provider configuration");
      expect((err as Error).message).toContain("index.enrichment.endpoint");
    }
  });

  test("rejects per-pass `provider`, `apiKey`, `temperature`, etc.", () => {
    for (const key of ["provider", "apiKey", "temperature", "maxTokens", "baseUrl", "capabilities"]) {
      writeUserConfig({
        llm: SAMPLE_LLM,
        index: { enrichment: { [key]: "anything" } },
      });
      resetConfigCache();
      expect(() => loadUserConfig()).toThrow(/Duplicate LLM provider configuration/);
    }
  });

  test("rejects non-boolean `llm` value under a pass", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: { enrichment: { llm: "off" } },
    });
    expect(() => loadUserConfig()).toThrow(/expected a boolean/);
  });

  test("rejects unknown keys under a pass entry", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: { enrichment: { foo: true } },
    });
    expect(() => loadUserConfig()).toThrow(/Unknown key `index\.enrichment\.foo`/);
  });

  test("rejects invalid graphExtractionIncludeTypes values", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: { graph: { graphExtractionIncludeTypes: ["memory", "bogus-type"] } },
    });
    expect(() => loadUserConfig()).toThrow(/unsupported type/);
  });

  test("rejects array-shaped `index` block", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid runtime input
      index: [{ llm: false }] as any,
    });
    expect(() => loadUserConfig()).toThrow(/expected an object keyed by pass name/);
  });

  test("rejects non-object pass entry", () => {
    writeUserConfig({
      llm: SAMPLE_LLM,
      index: { enrichment: false },
    });
    expect(() => loadUserConfig()).toThrow(/expected an object like/);
  });

  test("missing `index` block is fine", () => {
    writeUserConfig({ llm: SAMPLE_LLM });
    const config = loadUserConfig();
    expect(config.index).toBeUndefined();
    expect(resolveIndexPassLLM("enrichment", config)).toEqual(SAMPLE_LLM);
  });
});
