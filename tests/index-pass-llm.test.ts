import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../src/core/config";
import { getConfigPath, loadUserConfig, resetConfigCache } from "../src/core/config";
import { ConfigError } from "../src/core/errors";
import { resolveIndexPassLLM } from "../src/llm/index-passes";

// Tests for #208 — unified `akm.llm` config across all index-time passes.

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-index-pass-llm-"));
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let tmpHome = "";

beforeEach(() => {
  tmpHome = makeTmpDir();
  process.env.XDG_CONFIG_HOME = tmpHome;
  resetConfigCache();
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = "";
  }
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

  test("returns the shared akm.llm by default for any pass", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM },
    };
    expect(resolveIndexPassLLM("enrichment", config)).toEqual(SAMPLE_LLM);
    // A future pass plugs in for free — same default, no per-pass wiring.
    expect(resolveIndexPassLLM("memory", config)).toEqual(SAMPLE_LLM);
    expect(resolveIndexPassLLM("graph", config)).toEqual(SAMPLE_LLM);
  });

  test("per-pass `llm: false` opts that pass out, leaving siblings intact", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM },
      index: {
        enrichment: { llm: false },
        graph: { llm: true },
      },
    };
    expect(resolveIndexPassLLM("enrichment", config)).toBeUndefined();
    expect(resolveIndexPassLLM("graph", config)).toEqual(SAMPLE_LLM);
    // Pass not mentioned at all still defaults to akm.llm.
    expect(resolveIndexPassLLM("memory", config)).toEqual(SAMPLE_LLM);
  });

  test("per-pass `llm: true` is equivalent to default", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM },
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
