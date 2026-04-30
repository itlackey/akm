import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  getConfigDir,
  getConfigPath,
  loadConfig,
  loadUserConfig,
  resetConfigCache,
  saveConfig,
  updateConfig,
} from "../src/core/config";
import { ConfigError } from "../src/core/errors";

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
const originalCwd = process.cwd();
let testConfigHome = "";

beforeEach(() => {
  testConfigHome = makeTmpDir();
  process.env.XDG_CONFIG_HOME = testConfigHome;
  process.chdir(originalCwd);
  resetConfigCache();
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

  process.chdir(originalCwd);
  resetConfigCache();
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
    expect(config.sources).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
    expect(config.registries).toEqual(DEFAULT_CONFIG.registries);
  });

  test("merges partial config with defaults", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "off" }));
    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("off");
    expect(config.sources).toBeUndefined();
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
    expect(config.sources).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
    expect(config.registries).toEqual(DEFAULT_CONFIG.registries);
    expect((config as unknown as Record<string, unknown>).futureKey).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).anotherKey).toBeUndefined();
  });

  test("ignores wrong types for known keys", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "yes", sources: "not-an-array" }));
    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("auto");
    expect(config.sources).toBeUndefined();
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

  test("ignores legacy semanticSearch boolean (compat shim retired)", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearch: false }));
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

  test("merges ancestor project config files on top of user config", () => {
    const workspaceRoot = makeTmpDir();
    const nestedProjectDir = path.join(workspaceRoot, "apps", "demo");
    try {
      fs.mkdirSync(nestedProjectDir, { recursive: true });
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          semanticSearchMode: "auto",
          output: { format: "text" },
          sources: [{ type: "filesystem", path: "/user-stash" }],
        }),
      );
      writeRawConfig(
        path.join(workspaceRoot, ".akm", "config.json"),
        JSON.stringify({
          output: { detail: "full" },
          sources: [{ type: "filesystem", path: "/workspace-stash" }],
        }),
      );
      writeRawConfig(
        path.join(workspaceRoot, "apps", ".akm", "config.json"),
        JSON.stringify({
          semanticSearchMode: "off",
          sources: [{ type: "filesystem", path: "/apps-stash" }],
        }),
      );

      process.chdir(nestedProjectDir);

      expect(loadConfig()).toEqual({
        ...DEFAULT_CONFIG,
        semanticSearchMode: "off",
        output: { format: "text", detail: "full" },
        sources: [
          { type: "filesystem", path: "/user-stash" },
          { type: "filesystem", path: "/workspace-stash" },
          { type: "filesystem", path: "/apps-stash" },
        ],
      });
    } finally {
      cleanup(workspaceRoot);
    }
  });

  test("project config can replace inherited sources while keeping project sources", () => {
    const projectDir = makeTmpDir();
    try {
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          semanticSearchMode: "auto",
          sources: [{ type: "filesystem", path: "/user-stash" }],
        }),
      );
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({
          stashInheritance: "replace",
          sources: [{ type: "filesystem", path: "/project-stash" }],
        }),
      );

      process.chdir(projectDir);

      expect(loadConfig().sources).toEqual([{ type: "filesystem", path: "/project-stash" }]);
    } finally {
      cleanup(projectDir);
    }
  });

  test("project config can replace inherited sources without defining replacements", () => {
    const projectDir = makeTmpDir();
    try {
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          semanticSearchMode: "auto",
          sources: [{ type: "filesystem", path: "/user-stash" }],
        }),
      );
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({
          stashInheritance: "replace",
        }),
      );

      process.chdir(projectDir);

      expect(loadConfig().sources).toEqual([]);
    } finally {
      cleanup(projectDir);
    }
  });

  test("throws ConfigError when config contains an openviking-typed source", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        sources: [{ type: "openviking", url: "https://ov.example.com", name: "my-ov" }],
      }),
    );
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow("openviking is not supported in akm v1");
    expect(() => loadConfig()).toThrow("docs/migration/v1.md");
  });

  test("throws ConfigError with INVALID_CONFIG_FILE code for openviking source", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        sources: [{ type: "openviking", url: "https://ov.example.com", name: "my-ov" }],
      }),
    );
    try {
      loadConfig();
      throw new Error("Expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("INVALID_CONFIG_FILE");
    }
  });

  test("ConfigError for openviking source carries actionable hint with source name", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        sources: [{ type: "openviking", url: "https://ov.example.com", name: "my-ov" }],
      }),
    );
    try {
      loadConfig();
      throw new Error("Expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const hint = (err as ConfigError).hint();
      expect(hint).toBeDefined();
      // QA #38: hint now uses real commands (akm remove, not akm config sources remove)
      expect(hint).toContain("my-ov");
      expect(hint).toContain("akm remove");
    }
  });

  test("recomputes merged config when cwd changes", () => {
    const firstProject = makeTmpDir();
    const secondProject = makeTmpDir();
    try {
      writeRawConfig(
        path.join(firstProject, ".akm", "config.json"),
        JSON.stringify({ sources: [{ type: "filesystem", path: "/first-project-stash" }] }),
      );
      writeRawConfig(
        path.join(secondProject, ".akm", "config.json"),
        JSON.stringify({ sources: [{ type: "filesystem", path: "/second-project-stash" }] }),
      );

      process.chdir(firstProject);
      expect(loadConfig().sources).toEqual([{ type: "filesystem", path: "/first-project-stash" }]);

      // Intentionally do not reset the cache here; loadConfig() should notice
      // the cwd change because the discovered project config path set changes.
      process.chdir(secondProject);
      expect(loadConfig().sources).toEqual([{ type: "filesystem", path: "/second-project-stash" }]);
    } finally {
      cleanup(firstProject);
      cleanup(secondProject);
    }
  });
});

// ── saveConfig ──────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("writes formatted JSON to config.json", () => {
    const config = { semanticSearchMode: "off" as const, sources: [{ type: "filesystem" as const, path: "/extra" }] };
    saveConfig(config);
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    expect(JSON.parse(raw)).toEqual(config);
    expect(raw).toContain("  ");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("roundtrips with loadConfig", () => {
    const config = {
      semanticSearchMode: "off" as const,
      sources: [
        { type: "filesystem" as const, path: "/a" },
        { type: "filesystem" as const, path: "/b" },
      ],
    };
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.semanticSearchMode).toBe("off");
    expect(loaded.sources).toEqual([
      { type: "filesystem", path: "/a" },
      { type: "filesystem", path: "/b" },
    ]);
    expect(loaded.output).toEqual({ format: "json", detail: "brief" });
  });

  test("roundtrips output config", () => {
    const config = {
      semanticSearchMode: "off" as const,
      sources: [{ type: "filesystem" as const, path: "/a" }],
      output: { format: "yaml" as const, detail: "full" as const },
    };
    saveConfig(config);
    expect(loadConfig().output).toEqual(config.output);
  });
});

// ── updateConfig ────────────────────────────────────────────────────────────

describe("updateConfig", () => {
  test("merges partial update over existing config", () => {
    saveConfig({ semanticSearchMode: "auto", sources: [{ type: "filesystem", path: "/a" }] });
    const updated = updateConfig({ semanticSearchMode: "off" });
    expect(updated.semanticSearchMode).toBe("off");
    expect(updated.sources).toEqual([{ type: "filesystem", path: "/a" }]);
    expect(loadConfig()).toEqual(updated);
  });

  test("creates config.json if it does not exist", () => {
    const updated = updateConfig({ semanticSearchMode: "off" });
    expect(updated.semanticSearchMode).toBe("off");
    expect(updated.sources).toBeUndefined();
    expect(updated.output).toEqual({ format: "json", detail: "brief" });
    expect(fs.existsSync(getConfigPath())).toBe(true);
  });

  test("writes only user config when project config is present", () => {
    const projectDir = makeTmpDir();
    try {
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({ sources: [{ type: "filesystem", path: "/project-stash" }] }),
      );

      process.chdir(projectDir);
      updateConfig({ semanticSearchMode: "off" });

      expect(loadConfig().sources).toEqual([{ type: "filesystem", path: "/project-stash" }]);
      expect(loadUserConfig().sources).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8"))).not.toHaveProperty("stashes");
      expect(loadUserConfig().semanticSearchMode).toBe("off");
    } finally {
      cleanup(projectDir);
    }
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

  test("accepts llm config with endpoint and empty model (subkey-set partial)", () => {
    // After QA #36, `akm config set llm.endpoint <url>` persists a partial
    // llm config with `model: ""`. The loader must accept this so the value
    // round-trips; downstream callers decide if it's usable.
    writeRawConfig(getConfigPath(), JSON.stringify({ llm: { endpoint: "http://localhost" } }));
    expect(loadConfig().llm).toEqual({ endpoint: "http://localhost", model: "" });
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
