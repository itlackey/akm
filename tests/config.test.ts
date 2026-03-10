import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  loadConfig,
  saveConfig,
  updateConfig,
  DEFAULT_CONFIG,
  getConfigDir,
  getConfigPath,
} from "../src/config"

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-config-test-"))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function writeRawConfig(configPath: string, content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, content)
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalHome = process.env.HOME
const originalStashDir = process.env.AKM_STASH_DIR
let testConfigHome = ""

beforeEach(() => {
  testConfigHome = makeTmpDir()
  process.env.XDG_CONFIG_HOME = testConfigHome
})

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }

  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }

  if (originalStashDir === undefined) {
    delete process.env.AKM_STASH_DIR
  } else {
    process.env.AKM_STASH_DIR = originalStashDir
  }

  if (testConfigHome) {
    cleanup(testConfigHome)
    testConfigHome = ""
  }
})

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json under XDG_CONFIG_HOME", () => {
    expect(getConfigPath()).toBe(path.join(testConfigHome, "agentikit", "config.json"))
  })

  test("defaults to ~/.config/agentikit when XDG_CONFIG_HOME is unset", () => {
    const home = makeTmpDir()
    delete process.env.XDG_CONFIG_HOME
    process.env.HOME = home

    expect(getConfigPath()).toBe(path.join(home, ".config", "agentikit", "config.json"))

    cleanup(home)
  })

  test("uses APPDATA on Windows", () => {
    const appData = String.raw`C:\Users\alice\AppData\Roaming`
    expect(getConfigDir({ APPDATA: appData }, "win32")).toBe(path.join(appData, "agentikit"))
    expect(path.join(getConfigDir({ APPDATA: appData }, "win32"), "config.json")).toBe(
      path.join(appData, "agentikit", "config.json"),
    )
  })

  test("falls back to USERPROFILE AppData Roaming on Windows", () => {
    const userProfile = String.raw`C:\Users\alice`
    expect(getConfigDir({ USERPROFILE: userProfile }, "win32")).toBe(
      path.join(userProfile, "AppData", "Roaming", "agentikit"),
    )
  })

  test("throws on Windows when APPDATA and USERPROFILE are missing", () => {
    expect(() => getConfigDir({}, "win32")).toThrow(
      "Unable to determine config directory. Set APPDATA or USERPROFILE.",
    )
  })
})

// ── loadConfig ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  test("returns defaults when no config.json exists", () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  })

  test("loads config without requiring AKM_STASH_DIR", () => {
    delete process.env.AKM_STASH_DIR
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearch: false }))

    expect(loadConfig()).toEqual({ semanticSearch: false, mountedStashDirs: [] })
  })

  test("merges partial config with defaults", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearch: false }))
    const config = loadConfig()
    expect(config.semanticSearch).toBe(false)
    expect(config.mountedStashDirs).toEqual([])
  })

  test("handles corrupted JSON gracefully", () => {
    writeRawConfig(getConfigPath(), "not valid json {{{")
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  })

  test("handles non-object JSON gracefully", () => {
    writeRawConfig(getConfigPath(), '"just a string"')
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  })

  test("handles JSON array gracefully", () => {
    writeRawConfig(getConfigPath(), "[1, 2, 3]")
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  })

  test("drops unknown keys", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ semanticSearch: false, futureKey: "hello", anotherKey: 42 }),
    )
    const config = loadConfig()
    expect(config).toEqual({ semanticSearch: false, mountedStashDirs: [] })
    expect((config as Record<string, unknown>).futureKey).toBeUndefined()
    expect((config as Record<string, unknown>).anotherKey).toBeUndefined()
  })

  test("filters non-string entries from mountedStashDirs", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ mountedStashDirs: ["/valid", 123, null, "/also-valid"] }),
    )
    expect(loadConfig().mountedStashDirs).toEqual(["/valid", "/also-valid"])
  })

  test("ignores wrong types for known keys", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ semanticSearch: "yes", mountedStashDirs: "not-an-array" }),
    )
    const config = loadConfig()
    expect(config.semanticSearch).toBe(true)
    expect(config.mountedStashDirs).toEqual([])
  })

  test("ignores stash-root config.json files", () => {
    const stashDir = makeTmpDir()
    try {
      writeRawConfig(path.join(stashDir, "config.json"), JSON.stringify({ semanticSearch: false }))

      expect(loadConfig()).toEqual(DEFAULT_CONFIG)
      expect(fs.existsSync(getConfigPath())).toBe(false)
    } finally {
      cleanup(stashDir)
    }
  })
})

// ── saveConfig ──────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("writes formatted JSON to config.json", () => {
    const config = { semanticSearch: false, mountedStashDirs: ["/extra"] }
    saveConfig(config)
    const raw = fs.readFileSync(getConfigPath(), "utf8")
    expect(JSON.parse(raw)).toEqual(config)
    expect(raw).toContain("  ")
    expect(raw.endsWith("\n")).toBe(true)
  })

  test("roundtrips with loadConfig", () => {
    const config = { semanticSearch: false, mountedStashDirs: ["/a", "/b"] }
    saveConfig(config)
    expect(loadConfig()).toEqual(config)
  })
})

// ── updateConfig ────────────────────────────────────────────────────────────

describe("updateConfig", () => {
  test("merges partial update over existing config", () => {
    saveConfig({ semanticSearch: true, mountedStashDirs: ["/a"] })
    const updated = updateConfig({ semanticSearch: false })
    expect(updated.semanticSearch).toBe(false)
    expect(updated.mountedStashDirs).toEqual(["/a"])
    expect(loadConfig()).toEqual(updated)
  })

  test("creates config.json if it does not exist", () => {
    const updated = updateConfig({ semanticSearch: false })
    expect(updated.semanticSearch).toBe(false)
    expect(updated.mountedStashDirs).toEqual([])
    expect(fs.existsSync(getConfigPath())).toBe(true)
  })
})

// ── embedding config ────────────────────────────────────────────────────────

describe("embedding config", () => {
  test("loads embedding connection config", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        embedding: {
          endpoint: "http://localhost:11434/v1/embeddings",
          model: "nomic-embed-text",
        },
      }),
    )
    expect(loadConfig().embedding).toEqual({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    })
  })

  test("loads embedding config with apiKey", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        embedding: {
          endpoint: "https://api.openai.com/v1/embeddings",
          model: "text-embedding-3-small",
          apiKey: "sk-test123",
        },
      }),
    )
    expect(loadConfig().embedding?.apiKey).toBe("sk-test123")
  })

  test("loads embedding config with provider and dimension", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        embedding: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1/embeddings",
          model: "text-embedding-3-small",
          dimension: 384,
        },
      }),
    )
    expect(loadConfig().embedding).toEqual({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimension: 384,
    })
  })

  test("ignores invalid embedding config (missing model)", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ embedding: { endpoint: "http://localhost:11434" } }),
    )
    expect(loadConfig().embedding).toBeUndefined()
  })

  test("ignores invalid embedding config with non-integer dimension", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        embedding: {
          endpoint: "https://api.openai.com/v1/embeddings",
          model: "text-embedding-3-small",
          dimension: 384.5,
        },
      }),
    )
    expect(loadConfig().embedding).toBeUndefined()
  })

  test("ignores non-object embedding config", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ embedding: "not-an-object" }))
    expect(loadConfig().embedding).toBeUndefined()
  })

  test("defaults to no embedding config", () => {
    expect(loadConfig().embedding).toBeUndefined()
  })

  test("roundtrips embedding config via updateConfig", () => {
    const embeddingConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    }
    updateConfig({ embedding: embeddingConfig })
    expect(loadConfig().embedding).toEqual(embeddingConfig)
  })

  test("clears embedding config with undefined", () => {
    const embeddingConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    }
    updateConfig({ embedding: embeddingConfig })
    updateConfig({ embedding: undefined })
    expect(loadConfig().embedding).toBeUndefined()
  })
})

// ── llm config ──────────────────────────────────────────────────────────────

describe("llm config", () => {
  test("loads llm connection config", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        llm: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "llama3.2",
        },
      }),
    )
    expect(loadConfig().llm).toEqual({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    })
  })

  test("loads llm config with apiKey", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        llm: {
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4",
          apiKey: "sk-key",
        },
      }),
    )
    expect(loadConfig().llm?.apiKey).toBe("sk-key")
  })

  test("loads llm config with provider, temperature, and maxTokens", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        llm: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
          temperature: 0.6,
          maxTokens: 256,
        },
      }),
    )
    expect(loadConfig().llm).toEqual({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: 0.6,
      maxTokens: 256,
    })
  })

  test("ignores invalid llm config", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ llm: { endpoint: "http://localhost" } }))
    expect(loadConfig().llm).toBeUndefined()
  })

  test("ignores llm config with non-integer maxTokens", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        llm: {
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
          maxTokens: 256.5,
        },
      }),
    )
    expect(loadConfig().llm).toBeUndefined()
  })

  test("roundtrips llm config via updateConfig", () => {
    const llmConfig = {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    }
    updateConfig({ llm: llmConfig })
    expect(loadConfig().llm).toEqual(llmConfig)
  })
})

// ── stashDir config ──────────────────────────────────────────────────────────

describe("stashDir config", () => {
  test("loads stashDir from config.json", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ stashDir: "/home/user/my-stash" }),
    )
    expect(loadConfig().stashDir).toBe("/home/user/my-stash")
  })

  test("stashDir is undefined by default", () => {
    expect(loadConfig().stashDir).toBeUndefined()
  })

  test("roundtrips stashDir via updateConfig", () => {
    updateConfig({ stashDir: "/custom/stash" })
    expect(loadConfig().stashDir).toBe("/custom/stash")
  })

  test("saves and preserves stashDir", () => {
    const config = { semanticSearch: true, mountedStashDirs: [], stashDir: "/my/stash" }
    saveConfig(config)
    const raw = fs.readFileSync(getConfigPath(), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.stashDir).toBe("/my/stash")
    expect(loadConfig().stashDir).toBe("/my/stash")
  })

  test("ignores non-string stashDir", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ stashDir: 42 }),
    )
    expect(loadConfig().stashDir).toBeUndefined()
  })

  test("ignores empty stashDir", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ stashDir: "   " }),
    )
    expect(loadConfig().stashDir).toBeUndefined()
  })
})
