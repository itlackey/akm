import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, getConfigDir, getConfigPath, loadConfig, saveConfig, updateConfig } from "../src/config";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-config-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeRawConfig(configPath: string, content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content);
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testConfigHome = "";

beforeEach(() => {
  testConfigHome = makeTmpDir();
  process.env.XDG_CONFIG_HOME = testConfigHome;
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalStashDir;
  }

  if (testConfigHome) {
    cleanup(testConfigHome);
    testConfigHome = "";
  }
});

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json under XDG_CONFIG_HOME", () => {
    expect(getConfigPath()).toBe(path.join(testConfigHome, "akm", "config.json"));
  });

  test("defaults to ~/.config/akm when XDG_CONFIG_HOME is unset", () => {
    const home = makeTmpDir();
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;

    expect(getConfigPath()).toBe(path.join(home, ".config", "akm", "config.json"));

    cleanup(home);
  });

  test("uses APPDATA on Windows", () => {
    const appData = String.raw`C:\Users\alice\AppData\Roaming`;
    expect(getConfigDir({ APPDATA: appData }, "win32")).toBe(path.join(appData, "akm"));
    expect(path.join(getConfigDir({ APPDATA: appData }, "win32"), "config.json")).toBe(
      path.join(appData, "akm", "config.json"),
    );
  });

  test("falls back to USERPROFILE AppData Roaming on Windows", () => {
    const userProfile = String.raw`C:\Users\alice`;
    expect(getConfigDir({ USERPROFILE: userProfile }, "win32")).toBe(
      path.join(userProfile, "AppData", "Roaming", "akm"),
    );
  });

  test("throws on Windows when APPDATA and USERPROFILE are missing", () => {
    expect(() => getConfigDir({}, "win32")).toThrow(
      "Unable to determine config directory. Set APPDATA or USERPROFILE.",
    );
  });
});

// ── loadConfig ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  test("returns defaults when no config.json exists", () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  test("loads config without requiring AKM_STASH_DIR", () => {
    delete process.env.AKM_STASH_DIR;
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "off" }));

    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("off");
    expect(config.stashes).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
    expect(config.registries).toEqual(DEFAULT_CONFIG.registries);
  });

  test("merges partial config with defaults", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "off" }));
    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("off");
    expect(config.stashes).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
  });

  test("handles corrupted JSON gracefully", () => {
    writeRawConfig(getConfigPath(), "not valid json {{{");
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  test("handles non-object JSON gracefully", () => {
    writeRawConfig(getConfigPath(), '"just a string"');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  test("handles JSON array gracefully", () => {
    writeRawConfig(getConfigPath(), "[1, 2, 3]");
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  test("drops unknown keys", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "off", futureKey: "hello", anotherKey: 42 }));
    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("off");
    expect(config.stashes).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
    expect(config.registries).toEqual(DEFAULT_CONFIG.registries);
    expect((config as unknown as Record<string, unknown>).futureKey).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).anotherKey).toBeUndefined();
  });

  test("converts legacy searchPaths into stashes with type filesystem", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ searchPaths: ["/valid", 123, null, "/also-valid"] }));
    const config = loadConfig();
    expect(config.stashes).toEqual([
      { type: "filesystem", path: "/valid" },
      { type: "filesystem", path: "/also-valid" },
    ]);
  });

  test("ignores wrong types for known keys", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "yes", searchPaths: "not-an-array" }));
    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("auto");
    expect(config.stashes).toBeUndefined();
  });

  test("coerces boolean true to 'auto' for semanticSearchMode", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: true }));
    expect(loadConfig().semanticSearchMode).toBe("auto");
  });

  test("coerces boolean false to 'off' for semanticSearchMode", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: false }));
    expect(loadConfig().semanticSearchMode).toBe("off");
  });

  test("passes through string 'auto' for semanticSearchMode", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "auto" }));
    expect(loadConfig().semanticSearchMode).toBe("auto");
  });

  test("passes through string 'off' for semanticSearchMode", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "off" }));
    expect(loadConfig().semanticSearchMode).toBe("off");
  });

  test("falls back to 'auto' for invalid semanticSearchMode values", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: 42 }));
    expect(loadConfig().semanticSearchMode).toBe("auto");
  });

  test("ignores stash-root config.json files", () => {
    const stashDir = makeTmpDir();
    try {
      writeRawConfig(path.join(stashDir, "config.json"), JSON.stringify({ semanticSearchMode: "off" }));

      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
      expect(fs.existsSync(getConfigPath())).toBe(false);
    } finally {
      cleanup(stashDir);
    }
  });
});

// ── saveConfig ──────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("writes formatted JSON to config.json", () => {
    const config = { semanticSearchMode: "off" as const, stashes: [{ type: "filesystem" as const, path: "/extra" }] };
    saveConfig(config);
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    expect(JSON.parse(raw)).toEqual(config);
    expect(raw).toContain("  ");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("roundtrips with loadConfig", () => {
    const config = {
      semanticSearchMode: "off" as const,
      stashes: [
        { type: "filesystem" as const, path: "/a" },
        { type: "filesystem" as const, path: "/b" },
      ],
    };
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.semanticSearchMode).toBe("off");
    expect(loaded.stashes).toEqual([
      { type: "filesystem", path: "/a" },
      { type: "filesystem", path: "/b" },
    ]);
    expect(loaded.output).toEqual({ format: "json", detail: "brief" });
  });

  test("roundtrips output config", () => {
    const config = {
      semanticSearchMode: "off" as const,
      stashes: [{ type: "filesystem" as const, path: "/a" }],
      output: { format: "yaml" as const, detail: "full" as const },
    };
    saveConfig(config);
    expect(loadConfig().output).toEqual(config.output);
  });
});

// ── updateConfig ────────────────────────────────────────────────────────────

describe("updateConfig", () => {
  test("merges partial update over existing config", () => {
    saveConfig({ semanticSearchMode: "auto", stashes: [{ type: "filesystem", path: "/a" }] });
    const updated = updateConfig({ semanticSearchMode: "off" });
    expect(updated.semanticSearchMode).toBe("off");
    expect(updated.stashes).toEqual([{ type: "filesystem", path: "/a" }]);
    expect(loadConfig()).toEqual(updated);
  });

  test("creates config.json if it does not exist", () => {
    const updated = updateConfig({ semanticSearchMode: "off" });
    expect(updated.semanticSearchMode).toBe("off");
    expect(updated.stashes).toBeUndefined();
    expect(updated.output).toEqual({ format: "json", detail: "brief" });
    expect(fs.existsSync(getConfigPath())).toBe(true);
  });
});

describe("output config", () => {
  test("loads valid output config", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ output: { format: "text", detail: "full" } }));
    expect(loadConfig().output).toEqual({ format: "text", detail: "full" });
  });

  test("ignores invalid output config values", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ output: { format: "xml", detail: "max" } }));
    expect(loadConfig().output).toEqual({ format: "json", detail: "brief" });
  });
});

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
    );
    expect(loadConfig().embedding).toEqual({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
  });

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
    );
    expect(loadConfig().embedding?.apiKey).toBe("sk-test123");
  });

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
    );
    expect(loadConfig().embedding).toEqual({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimension: 384,
    });
  });

  test("ignores invalid embedding config (missing model)", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ embedding: { endpoint: "http://localhost:11434" } }));
    expect(loadConfig().embedding).toBeUndefined();
  });

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
    );
    expect(loadConfig().embedding).toBeUndefined();
  });

  test("ignores non-object embedding config", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ embedding: "not-an-object" }));
    expect(loadConfig().embedding).toBeUndefined();
  });

  test("defaults to no embedding config", () => {
    expect(loadConfig().embedding).toBeUndefined();
  });

  test("roundtrips embedding config via updateConfig", () => {
    const embeddingConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    };
    updateConfig({ embedding: embeddingConfig });
    expect(loadConfig().embedding).toEqual(embeddingConfig);
  });

  test("clears embedding config with undefined", () => {
    const embeddingConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    };
    updateConfig({ embedding: embeddingConfig });
    updateConfig({ embedding: undefined });
    expect(loadConfig().embedding).toBeUndefined();
  });
});

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
    );
    expect(loadConfig().llm).toEqual({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    });
  });

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
    );
    expect(loadConfig().llm?.apiKey).toBe("sk-key");
  });

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
    );
    expect(loadConfig().llm).toEqual({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: 0.6,
      maxTokens: 256,
    });
  });

  test("ignores invalid llm config", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ llm: { endpoint: "http://localhost" } }));
    expect(loadConfig().llm).toBeUndefined();
  });

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
    );
    expect(loadConfig().llm).toBeUndefined();
  });

  test("roundtrips llm config via updateConfig", () => {
    const llmConfig = {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    };
    updateConfig({ llm: llmConfig });
    expect(loadConfig().llm).toEqual(llmConfig);
  });
});

// ── stashDir config ──────────────────────────────────────────────────────────

describe("stashDir config", () => {
  test("loads stashDir from config.json", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ stashDir: "/home/user/my-stash" }));
    expect(loadConfig().stashDir).toBe("/home/user/my-stash");
  });

  test("stashDir is undefined by default", () => {
    expect(loadConfig().stashDir).toBeUndefined();
  });

  test("roundtrips stashDir via updateConfig", () => {
    updateConfig({ stashDir: "/custom/stash" });
    expect(loadConfig().stashDir).toBe("/custom/stash");
  });

  test("saves and preserves stashDir", () => {
    const config = { semanticSearchMode: "auto" as const, stashDir: "/my/stash" };
    saveConfig(config);
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.stashDir).toBe("/my/stash");
    expect(loadConfig().stashDir).toBe("/my/stash");
  });

  test("ignores non-string stashDir", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ stashDir: 42 }));
    expect(loadConfig().stashDir).toBeUndefined();
  });

  test("ignores empty stashDir", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ stashDir: "   " }));
    expect(loadConfig().stashDir).toBeUndefined();
  });
});
