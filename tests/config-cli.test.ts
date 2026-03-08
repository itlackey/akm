import { describe, expect, test } from "bun:test"
import { EMBEDDING_DIM } from "../src/db"
import type { AgentikitConfig } from "../src/config"
import {
  getConfigValue,
  listConfig,
  listProviders,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
  useProvider,
} from "../src/config-cli"

describe("config CLI helpers", () => {
  test("listConfig shows effective local embedding and disabled llm defaults", () => {
    const config = listConfig({ semanticSearch: true, additionalStashDirs: [] })
    expect(config.embedding).toMatchObject({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      dimension: EMBEDDING_DIM,
    })
    expect(config.llm).toMatchObject({
      provider: "disabled",
    })
  })

  test("parseConfigValue supports embedding dimensions and llm sampling fields", () => {
    expect(parseConfigValue(
      "embedding",
      '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384}',
    )).toEqual({
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
        dimension: 384,
      },
    })

    expect(parseConfigValue(
      "llm",
      '{"endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-4o-mini","temperature":0.6,"maxTokens":300}',
    )).toEqual({
      llm: {
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o-mini",
        temperature: 0.6,
        maxTokens: 300,
      },
    })
  })

  test("useProvider seeds config with provider defaults", () => {
    const base: AgentikitConfig = { semanticSearch: true, additionalStashDirs: [] }
    const updated = useProvider(base, "embedding", "openai")
    expect(updated.embedding).toMatchObject({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimension: EMBEDDING_DIM,
    })
  })

  test("setConfigValue updates nested llm settings after provider selection", () => {
    const base: AgentikitConfig = { semanticSearch: true, additionalStashDirs: [] }
    const enabled = useProvider(base, "llm", "ollama")
    const updated = setConfigValue(enabled, "llm.temperature", "0.9")
    expect(updated.llm).toMatchObject({
      provider: "ollama",
      temperature: 0.9,
    })
    expect(getConfigValue(updated, "llm.temperature")).toBe(0.9)
  })

  test("unsetConfigValue removes optional keys without removing provider config", () => {
    const base: AgentikitConfig = {
      semanticSearch: true,
      additionalStashDirs: [],
      llm: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o-mini",
        temperature: 0.4,
        maxTokens: 128,
        apiKey: "secret",
      },
    }
    const updated = unsetConfigValue(base, "llm.apiKey")
    expect(updated.llm?.apiKey).toBeUndefined()
    expect(getConfigValue(updated, "llm.apiKey")).toBeUndefined()
  })

  test("listProviders marks the current provider", () => {
    const config: AgentikitConfig = {
      semanticSearch: true,
      additionalStashDirs: [],
      embedding: {
        provider: "ollama",
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      },
    }
    const providers = listProviders("embedding", config)
    expect(providers.find((provider) => provider.name === "ollama")).toMatchObject({ current: true })
    expect(providers.find((provider) => provider.name === "openai")).toMatchObject({ current: false })
    expect(providers.find((provider) => provider.name === "ollama")).toMatchObject({ dimension: EMBEDDING_DIM })
  })

  test("setConfigValue rejects non-canonical positive integers", () => {
    const base: AgentikitConfig = {
      semanticSearch: true,
      additionalStashDirs: [],
      embedding: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      llm: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o-mini",
      },
    }

    expect(() => setConfigValue(base, "embedding.dimension", "256.5")).toThrow("expected a positive integer")
    expect(() => setConfigValue(base, "llm.maxTokens", "1e3")).toThrow("expected a positive integer")
    expect(() => setConfigValue(base, "llm.maxTokens", "0384")).toThrow("expected a positive integer")
    expect(() => parseConfigValue(
      "embedding",
      '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384.5}',
    )).toThrow("expected a positive integer")
  })
})
