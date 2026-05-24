import { describe, expect, test } from "bun:test";
import {
  getConfigValue,
  listConfig,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
} from "../src/commands/config-cli";
import type { AkmConfig } from "../src/core/config";

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
    expect(parseConfigValue("security.installAudit.registryAllowlist", '["npm","github.com"]')).toEqual({
      security: { installAudit: { registryAllowlist: ["npm", "github.com"] } },
    });
    expect(
      parseConfigValue(
        "security.installAudit.allowedFindings",
        '[{"id":"prompt-reveal-hidden-secrets","ref":"github:owner/repo","path":"skills/review/SKILL.md","reason":"false positive"}]',
      ),
    ).toEqual({
      security: {
        installAudit: {
          allowedFindings: [
            {
              id: "prompt-reveal-hidden-secrets",
              ref: "github:owner/repo",
              path: "skills/review/SKILL.md",
              reason: "false positive",
            },
          ],
        },
      },
    });
  });

  test("parseConfigValue still accepts registryWhitelist as a legacy alias", () => {
    expect(parseConfigValue("security.installAudit.registryWhitelist", '["npm"]')).toEqual({
      security: { installAudit: { registryAllowlist: ["npm"] } },
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
      profiles: {
        llm: {
          default: {
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-4o-mini",
            temperature: 0.6,
            maxTokens: 300,
          },
        },
      },
      defaults: { llm: "default" },
    });
  });

  test("parseConfigValue rejects llm JSON with endpoint and omitted model", () => {
    // Post-rewrite: profile shape is enforced. Setting the whole llm block
    // requires the full required shape; partial setup must use subkey paths.
    expect(() => parseConfigValue("llm", '{"endpoint":"http://localhost:11434/v1/chat/completions"}')).toThrow(
      /model.*Required/,
    );
  });

  test("parseConfigValue rejects writable website sources through config CLI", () => {
    expect(() =>
      parseConfigValue("sources", '[{"type":"website","url":"https://example.com","writable":true}]'),
    ).toThrow("writable: true is only supported on filesystem and git sources");
  });

  test("parseConfigValue rejects writable npm sources through config CLI", () => {
    expect(() => parseConfigValue("sources", '[{"type":"npm","path":"left-pad","writable":true}]')).toThrow(
      "writable: true is only supported on filesystem and git sources",
    );
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

  test("setConfigValue sets llm via JSON (writes to profiles.llm.default)", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
    const updated = setConfigValue(
      base,
      "llm",
      '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2","temperature":0.3}',
    );
    expect(updated.profiles?.llm?.default).toMatchObject({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      temperature: 0.3,
    });
    expect(updated.defaults?.llm).toBe("default");
  });

  test("getConfigValue returns null for unconfigured embedding/llm", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
    expect(getConfigValue(base, "embedding")).toBeNull();
    expect(getConfigValue(base, "llm")).toBeNull();
  });

  test("getConfigValue returns configured embedding/llm objects", () => {
    const llm = {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      temperature: 0.3,
    };
    const base: AkmConfig = {
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      profiles: { llm: { default: llm } },
      defaults: { llm: "default" },
    };
    expect(getConfigValue(base, "embedding")).toEqual(base.embedding);
    expect(getConfigValue(base, "llm")).toEqual(llm);
  });

  test("set/get/unset support install audit config keys", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
    const configured = setConfigValue(base, "security.installAudit.enabled", "true");
    const withWhitelist = setConfigValue(configured, "security.installAudit.registryAllowlist", '["npm","github.com"]');
    const withAllowedFindings = setConfigValue(
      withWhitelist,
      "security.installAudit.allowedFindings",
      '[{"id":"bundled-package-directory","path":"venv"}]',
    );

    expect(getConfigValue(withAllowedFindings, "security.installAudit.enabled")).toBe(true);
    expect(getConfigValue(withAllowedFindings, "security.installAudit.registryAllowlist")).toEqual([
      "npm",
      "github.com",
    ]);
    expect(getConfigValue(withAllowedFindings, "security.installAudit.allowedFindings")).toEqual([
      { id: "bundled-package-directory", path: "venv" },
    ]);
    expect(unsetConfigValue(withAllowedFindings, "security.installAudit.registryAllowlist").security).toEqual({
      installAudit: { enabled: true, allowedFindings: [{ id: "bundled-package-directory", path: "venv" }] },
    });
    expect(unsetConfigValue(withAllowedFindings, "security.installAudit.allowedFindings").security).toEqual({
      installAudit: { enabled: true, registryAllowlist: ["npm", "github.com"] },
    });
  });

  test("unsetConfigValue clears embedding and llm", () => {
    const base: AkmConfig = {
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      profiles: {
        llm: { default: { endpoint: "http://localhost:11434/v1/chat/completions", model: "llama3.2" } },
      },
      defaults: { llm: "default" },
    };
    const noEmbed = unsetConfigValue(base, "embedding");
    expect(noEmbed.embedding).toBeUndefined();

    const noLlm = unsetConfigValue(base, "llm");
    expect(noLlm.profiles?.llm?.default).toBeUndefined();
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

  test("setConfigValue accepts previously hand-listed sub-keys now that the schema is the source of truth (#455)", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
    const withProvider = setConfigValue(base, "embedding.provider", "ollama");
    expect(withProvider.embedding?.provider).toBe("ollama");
    const withTemp = setConfigValue(base, "llm.temperature", "0.5");
    expect(withTemp.profiles?.llm?.default?.temperature).toBe(0.5);
  });

  test("setConfigValue rejects keys not in the schema", () => {
    const base: AkmConfig = { semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "totally.unknown.path", "x")).toThrow("Unknown config key");
  });

  test("parseConfigValue rejects non-integer embedding dimension in JSON", () => {
    expect(() =>
      parseConfigValue(
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384.5}',
      ),
    ).toThrow(/Expected integer/);
  });

  test("parseConfigValue rejects invalid output values", () => {
    expect(() => parseConfigValue("output.format", "xml")).toThrow(/Expected 'json' \| 'yaml' \| 'text'/);
    expect(() => parseConfigValue("output.detail", "max")).toThrow(/Expected 'brief' \| 'normal' \| 'full'/);
  });

  test("parseConfigValue rejects invalid install audit values", () => {
    expect(() => parseConfigValue("security.installAudit.enabled", "yes")).toThrow(/expected true or false/);
    expect(() => parseConfigValue("security.installAudit.registryAllowlist", '{"npm":true}')).toThrow(/Expected array/);
    expect(() => parseConfigValue("security.installAudit.allowedFindings", '{"id":"x"}')).toThrow(/Expected array/);
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
