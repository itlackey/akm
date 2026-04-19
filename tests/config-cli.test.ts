import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/config";
import { getConfigValue, listConfig, parseConfigValue, setConfigValue, unsetConfigValue } from "../src/config-cli";

describe("config CLI helpers", () => {
  test("listConfig omits unconfigured embedding and llm", () => {
    const config = listConfig({ semanticSearchMode: "auto" });
    expect(config.embedding).toBeUndefined();
    expect(config.llm).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
  });

  test("parseConfigValue supports output config keys", () => {
    expect(parseConfigValue("output.format", "yaml")).toEqual({ output: { format: "yaml" } });
    expect(parseConfigValue("output.detail", "full")).toEqual({ output: { detail: "full" } });
  });

  test("parseConfigValue supports install audit config keys", () => {
    expect(parseConfigValue("security.installAudit.enabled", "false")).toEqual({
      security: { installAudit: { enabled: false } },
    });
    expect(parseConfigValue("security.installAudit.registryWhitelist", '["npm","github.com"]')).toEqual({
      security: { installAudit: { registryWhitelist: ["npm", "github.com"] } },
    });
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
    const base: AkmConfig = { semanticSearchMode: "auto" };
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
    const base: AkmConfig = { semanticSearchMode: "auto" };
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
    const base: AkmConfig = { semanticSearchMode: "auto" };
    expect(getConfigValue(base, "embedding")).toBeNull();
    expect(getConfigValue(base, "llm")).toBeNull();
  });

  test("getConfigValue returns configured embedding/llm objects", () => {
    const base: AkmConfig = {
      semanticSearchMode: "auto",
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

  test("set/get/unset support install audit config keys", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
    const configured = setConfigValue(base, "security.installAudit.enabled", "true");
    const withWhitelist = setConfigValue(configured, "security.installAudit.registryWhitelist", '["npm","github.com"]');

    expect(getConfigValue(withWhitelist, "security.installAudit.enabled")).toBe(true);
    expect(getConfigValue(withWhitelist, "security.installAudit.registryWhitelist")).toEqual(["npm", "github.com"]);
    expect(unsetConfigValue(withWhitelist, "security.installAudit.registryWhitelist").security).toEqual({
      installAudit: { enabled: true },
    });
  });

  test("unsetConfigValue clears embedding and llm", () => {
    const base: AkmConfig = {
      semanticSearchMode: "auto",
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
    const base: AkmConfig = { semanticSearchMode: "auto" };
    const withFormat = setConfigValue(base, "output.format", "text");
    const withDetail = setConfigValue(withFormat, "output.detail", "full");

    expect(withDetail.output).toEqual({ format: "text", detail: "full" });
  });

  test("getConfigValue reads output keys", () => {
    const base: AkmConfig = {
      semanticSearchMode: "auto",
      output: { format: "yaml", detail: "normal" },
    };
    expect(getConfigValue(base, "output.format")).toBe("yaml");
    expect(getConfigValue(base, "output.detail")).toBe("normal");
  });

  test("unsetConfigValue clears individual output keys", () => {
    const base: AkmConfig = {
      semanticSearchMode: "auto",
      output: { format: "yaml", detail: "normal" },
    };
    expect(unsetConfigValue(base, "output.format").output).toEqual({ detail: "normal" });
    expect(unsetConfigValue(base, "output.detail").output).toEqual({ format: "yaml" });
  });

  test("setConfigValue rejects unknown keys", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
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

  test("parseConfigValue rejects invalid install audit values", () => {
    expect(() => parseConfigValue("security.installAudit.enabled", "yes")).toThrow("expected true or false");
    expect(() => parseConfigValue("security.installAudit.registryWhitelist", '{"npm":true}')).toThrow(
      "expected a JSON array of strings",
    );
  });

  test("parseConfigValue coerces 'true' to 'auto' for semanticSearchMode", () => {
    const result = parseConfigValue("semanticSearchMode", "true");
    expect(result).toEqual({ semanticSearchMode: "auto" });
  });

  test("parseConfigValue coerces 'false' to 'off' for semanticSearchMode", () => {
    const result = parseConfigValue("semanticSearchMode", "false");
    expect(result).toEqual({ semanticSearchMode: "off" });
  });

  test("parseConfigValue accepts 'auto' for semanticSearchMode", () => {
    const result = parseConfigValue("semanticSearchMode", "auto");
    expect(result).toEqual({ semanticSearchMode: "auto" });
  });

  test("parseConfigValue accepts 'off' for semanticSearchMode", () => {
    const result = parseConfigValue("semanticSearchMode", "off");
    expect(result).toEqual({ semanticSearchMode: "off" });
  });

  test("parseConfigValue rejects invalid semanticSearchMode", () => {
    expect(() => parseConfigValue("semanticSearchMode", "yes")).toThrow("Invalid value for semanticSearchMode");
  });
});
