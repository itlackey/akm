import { describe, expect, test } from "bun:test";
import type { AgentikitConfig } from "../src/config";
import { getConfigValue, listConfig, parseConfigValue, setConfigValue, unsetConfigValue } from "../src/config-cli";

describe("config CLI helpers", () => {
  test("listConfig shows null for unconfigured embedding and llm", () => {
    const config = listConfig({ semanticSearch: true, searchPaths: [] });
    expect(config.embedding).toBeNull();
    expect(config.llm).toBeNull();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
  });

  test("parseConfigValue supports output config keys", () => {
    expect(parseConfigValue("output.format", "yaml")).toEqual({ output: { format: "yaml" } });
    expect(parseConfigValue("output.detail", "full")).toEqual({ output: { detail: "full" } });
  });

  test("parseConfigValue supports embedding JSON with dimensions", () => {
    expect(
      parseConfigValue(
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384}',
      ),
    ).toEqual({
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
        dimension: 384,
      },
    });
  });

  test("parseConfigValue supports llm JSON with sampling fields", () => {
    expect(
      parseConfigValue(
        "llm",
        '{"endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-4o-mini","temperature":0.6,"maxTokens":300}',
      ),
    ).toEqual({
      llm: {
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o-mini",
        temperature: 0.6,
        maxTokens: 300,
      },
    });
  });

  test("setConfigValue sets embedding via JSON", () => {
    const base: AgentikitConfig = { semanticSearch: true, searchPaths: [] };
    const updated = setConfigValue(
      base,
      "embedding",
      '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}',
    );
    expect(updated.embedding).toEqual({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
  });

  test("setConfigValue sets llm via JSON", () => {
    const base: AgentikitConfig = { semanticSearch: true, searchPaths: [] };
    const updated = setConfigValue(
      base,
      "llm",
      '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2","temperature":0.3}',
    );
    expect(updated.llm).toEqual({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      temperature: 0.3,
    });
  });

  test("getConfigValue returns null for unconfigured embedding/llm", () => {
    const base: AgentikitConfig = { semanticSearch: true, searchPaths: [] };
    expect(getConfigValue(base, "embedding")).toBeNull();
    expect(getConfigValue(base, "llm")).toBeNull();
  });

  test("getConfigValue returns configured embedding/llm objects", () => {
    const base: AgentikitConfig = {
      semanticSearch: true,
      searchPaths: [],
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
        temperature: 0.3,
      },
    };
    expect(getConfigValue(base, "embedding")).toEqual(base.embedding);
    expect(getConfigValue(base, "llm")).toEqual(base.llm);
  });

  test("unsetConfigValue clears embedding and llm", () => {
    const base: AgentikitConfig = {
      semanticSearch: true,
      searchPaths: [],
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3.2",
      },
    };
    const noEmbed = unsetConfigValue(base, "embedding");
    expect(noEmbed.embedding).toBeUndefined();

    const noLlm = unsetConfigValue(base, "llm");
    expect(noLlm.llm).toBeUndefined();
  });

  test("setConfigValue merges output format and detail", () => {
    const base: AgentikitConfig = { semanticSearch: true, searchPaths: [] };
    const withFormat = setConfigValue(base, "output.format", "text");
    const withDetail = setConfigValue(withFormat, "output.detail", "full");

    expect(withDetail.output).toEqual({ format: "text", detail: "full" });
  });

  test("getConfigValue reads output keys", () => {
    const base: AgentikitConfig = {
      semanticSearch: true,
      searchPaths: [],
      output: { format: "yaml", detail: "normal" },
    };
    expect(getConfigValue(base, "output.format")).toBe("yaml");
    expect(getConfigValue(base, "output.detail")).toBe("normal");
  });

  test("unsetConfigValue clears individual output keys", () => {
    const base: AgentikitConfig = {
      semanticSearch: true,
      searchPaths: [],
      output: { format: "yaml", detail: "normal" },
    };
    expect(unsetConfigValue(base, "output.format").output).toEqual({ detail: "normal" });
    expect(unsetConfigValue(base, "output.detail").output).toEqual({ format: "yaml" });
  });

  test("setConfigValue rejects unknown keys", () => {
    const base: AgentikitConfig = { semanticSearch: true, searchPaths: [] };
    expect(() => setConfigValue(base, "embedding.provider", "ollama")).toThrow("Unknown config key");
    expect(() => setConfigValue(base, "llm.temperature", "0.5")).toThrow("Unknown config key");
  });

  test("parseConfigValue rejects non-integer embedding dimension in JSON", () => {
    expect(() =>
      parseConfigValue(
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384.5}',
      ),
    ).toThrow("expected a positive integer");
  });

  test("parseConfigValue rejects invalid output values", () => {
    expect(() => parseConfigValue("output.format", "xml")).toThrow("expected one of json|yaml|text");
    expect(() => parseConfigValue("output.detail", "max")).toThrow("expected one of brief|normal|full");
  });
});
