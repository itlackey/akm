import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  getConfigReadOnlyReason,
  loadConfig,
  loadUserConfig,
  resetConfigCache,
  saveConfig,
  updateConfig,
} from "../src/core/config";
import { ConfigError } from "../src/core/errors";
import { getCacheDir, getConfigDir, getConfigPath } from "../src/core/paths";

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
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalHome = process.env.HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
const originalCwd = process.cwd();
let testConfigHome = "";
let testCacheHome = "";
let testDataHome = "";
let testStateHome = "";

beforeEach(() => {
  testConfigHome = makeTmpDir();
  testCacheHome = makeTmpDir();
  testDataHome = makeTmpDir();
  testStateHome = makeTmpDir();
  process.env.XDG_CONFIG_HOME = testConfigHome;
  process.env.XDG_CACHE_HOME = testCacheHome;
  process.env.XDG_DATA_HOME = testDataHome;
  process.env.XDG_STATE_HOME = testStateHome;
  process.chdir(originalCwd);
  resetConfigCache();
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }

  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }

  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }

  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
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

  if (testCacheHome) {
    cleanup(testCacheHome);
    testCacheHome = "";
  }

  if (testDataHome) {
    cleanup(testDataHome);
    testDataHome = "";
  }

  if (testStateHome) {
    cleanup(testStateHome);
    testStateHome = "";
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
    // Defense against CI environments where AKM_STASH_DIR is inherited
    // from outer test isolation: if it points at a transient path,
    // getConfigDir's isolation rule fires and overrides the HOME-based
    // fallback this test is verifying. See
    // docs/technical/incidents/2026-05-23-setup-clobbers-user-config.md.
    delete process.env.AKM_STASH_DIR;
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

  test("throws ConfigError on corrupted JSON (#458)", () => {
    writeRawConfig(getConfigPath(), "not valid json {{{");
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/Failed to parse config JSON/);
  });

  test("throws ConfigError on non-object root (#458)", () => {
    writeRawConfig(getConfigPath(), '"just a string"');
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/must contain a JSON object/);
  });

  test("throws ConfigError on JSON array root (#458)", () => {
    writeRawConfig(getConfigPath(), "[1, 2, 3]");
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/must contain a JSON object/);
  });

  test("returns DEFAULT_CONFIG when file does not exist (legitimate cold start)", () => {
    // Sanity: cold-start case is preserved. Only malformed CONTENT throws.
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

  test("throws ConfigError when config contains legacy stashes[]", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        stashes: [{ type: "filesystem", path: "/legacy-stash" }],
      }),
    );

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow("legacy `stashes[]` config key");
  });

  test("throws ConfigError when installed npm entry is marked writable", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        installed: [
          {
            id: "npm:left-pad",
            source: "npm",
            ref: "npm:left-pad",
            artifactUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
            stashRoot: "/tmp/left-pad",
            cacheDir: "/tmp/cache",
            installedAt: "2026-05-01T00:00:00.000Z",
            writable: true,
          },
        ],
      }),
    );

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow("writable: true is only supported on filesystem and git sources");
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

  test("emits a one-time deprecation warning when discovering a project-level config (#457)", () => {
    const projectDir = makeTmpDir();
    try {
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({ sources: [{ type: "filesystem", path: "/project-stash" }] }),
      );

      const messages: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        messages.push(args.map(String).join(" "));
      };
      try {
        process.chdir(projectDir);
        loadConfig();
      } finally {
        console.warn = originalWarn;
      }
      // The warning fires at least once and mentions the config path + 0.9.0
      expect(messages.some((m) => m.includes("DEPRECATED") && m.includes("project-level"))).toBe(true);
      expect(messages.some((m) => m.includes("0.9.0"))).toBe(true);
    } finally {
      cleanup(projectDir);
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

  test("backs up the previous config in cache before overwrite", () => {
    saveConfig({ semanticSearchMode: "off" });
    saveConfig({ semanticSearchMode: "auto", output: { format: "yaml", detail: "full" } });

    const backupDir = path.join(getCacheDir(), "config-backups");
    const latestPath = path.join(backupDir, "config.latest.json");

    expect(fs.existsSync(latestPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(latestPath, "utf8"))).toEqual({ semanticSearchMode: "off" });

    const backups = fs.readdirSync(backupDir).filter((name) => name.startsWith("config-") && name.endsWith(".json"));
    expect(backups.length).toBeGreaterThan(0);
  });

  test("prunes config backups to the 5 most-recent (#459)", () => {
    // 10 saves → 10 distinct backup timestamps (but at most 5 should remain).
    for (let i = 0; i < 10; i++) {
      saveConfig({ semanticSearchMode: i % 2 === 0 ? "off" : "auto" });
      // The timestamp is ISO-second-resolution; introduce a small delay so
      // each backup gets a unique filename. mtimeMs is what we sort on.
      const target = Date.now() + 10;
      while (Date.now() < target) {
        /* spin briefly */
      }
    }

    const backupDir = path.join(getCacheDir(), "config-backups");
    const timestamped = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith("config-") && name.endsWith(".json") && name !== "config.latest.json");
    expect(timestamped.length).toBeLessThanOrEqual(5);
    // config.latest.json is always preserved
    expect(fs.existsSync(path.join(backupDir, "config.latest.json"))).toBe(true);
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
    const cfg = loadConfig();
    expect(cfg.profiles?.llm?.default).toMatchObject({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    });
    expect(cfg.defaults?.llm).toBe("default");
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
    expect(loadConfig().profiles?.llm?.default?.apiKey).toBe("sk-key");
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
    expect(loadConfig().profiles?.llm?.default).toMatchObject({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: 0.6,
      maxTokens: 256,
    });
  });

  test("warns when llm endpoint does not end in /chat/completions", () => {
    const originalWarn = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      writeRawConfig(getConfigPath(), JSON.stringify({ llm: { endpoint: "http://localhost/v1", model: "gpt-4" } }));
      loadConfig();
      expect(messages.some((msg) => msg.includes("/chat/completions"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("accepts llm config with endpoint and empty model (subkey-set partial)", () => {
    // After QA #36, `akm config set llm.endpoint <url>` persists a partial
    // llm config with `model: ""`. The loader must accept this so the value
    // round-trips; downstream callers decide if it's usable.
    writeRawConfig(getConfigPath(), JSON.stringify({ llm: { endpoint: "http://localhost" } }));
    expect(loadConfig().profiles?.llm?.default).toMatchObject({ endpoint: "http://localhost", model: "" });
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
    expect(loadConfig().profiles?.llm?.default).toBeUndefined();
  });

  test("roundtrips llm config via updateConfig profiles.llm", () => {
    const llmConfig = {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    };
    updateConfig({
      profiles: { llm: { default: llmConfig } },
      defaults: { llm: "default" },
    });
    expect(loadConfig().profiles?.llm?.default).toMatchObject(llmConfig);
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

// ── search config ────────────────────────────────────────────────────────────

describe("search config", () => {
  test("loads search.graphBoost values", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        search: {
          minScore: 0.15,
          graphBoost: {
            directBoostPerEntity: 0.2,
            directBoostCap: 0.6,
            hopBoostPerEntity: 0.08,
            hopBoostCap: 0.24,
            maxHops: 2,
            confidenceMode: "multiply",
            confidenceWeight: 0.4,
          },
        },
      }),
    );

    expect(loadConfig().search).toEqual({
      minScore: 0.15,
      graphBoost: {
        directBoostPerEntity: 0.2,
        directBoostCap: 0.6,
        hopBoostPerEntity: 0.08,
        hopBoostCap: 0.24,
        maxHops: 2,
        confidenceMode: "multiply",
        confidenceWeight: 0.4,
      },
    });
  });

  test("loads search.graphBoost confidence mode and caps confidenceWeight at 1", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        search: {
          graphBoost: {
            confidenceMode: "blend",
            confidenceWeight: 99,
          },
        },
      }),
    );

    expect(loadConfig().search?.graphBoost).toEqual({
      confidenceMode: "blend",
      confidenceWeight: 1,
    });
  });

  test("caps search.graphBoost.maxHops at conservative hard limit", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ search: { graphBoost: { maxHops: 99 } } }));
    expect(loadConfig().search?.graphBoost?.maxHops).toBe(3);
  });

  test("warns and ignores unknown search and search.graphBoost keys", () => {
    const originalWarn = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          search: {
            minScore: 0.2,
            unsupportedTopLevel: true,
            graphBoost: {
              maxHops: 2,
              unsupportedNested: "x",
            },
          },
        }),
      );

      const loaded = loadConfig();
      expect(loaded.search?.minScore).toBe(0.2);
      expect(loaded.search?.graphBoost?.maxHops).toBe(2);
      expect(messages.some((m) => m.includes('Ignoring unknown search key "unsupportedTopLevel"'))).toBe(true);
      expect(messages.some((m) => m.includes('Ignoring unknown search.graphBoost key "unsupportedNested"'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("v2 config shape parsing", () => {
  test("parses configVersion", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: 2 }));
    const loaded = loadConfig();
    expect(loaded.configVersion).toBe(2);
  });

  test("parses profiles.llm with supportsJsonSchema", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: 2,
        profiles: {
          llm: {
            "openai-mini": {
              endpoint: "https://api.openai.com/v1/chat/completions",
              model: "gpt-4o-mini",
              temperature: 0.3,
              supportsJsonSchema: true,
            },
          },
        },
      }),
    );
    const loaded = loadConfig();
    expect(loaded.profiles?.llm?.["openai-mini"]?.model).toBe("gpt-4o-mini");
    expect(loaded.profiles?.llm?.["openai-mini"]?.supportsJsonSchema).toBe(true);
  });

  test("parses profiles.agent with platform field", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: 2,
        profiles: {
          agent: {
            "opencode-default": { platform: "opencode", bin: "opencode", args: ["run"] },
            "opencode-sdk": { platform: "opencode-sdk", workspace: "/tmp", model: "claude-3" },
          },
        },
      }),
    );
    const loaded = loadConfig();
    expect(loaded.profiles?.agent?.["opencode-default"]?.platform).toBe("opencode");
    expect(loaded.profiles?.agent?.["opencode-sdk"]?.platform).toBe("opencode-sdk");
    expect(loaded.profiles?.agent?.["opencode-sdk"]?.model).toBe("claude-3");
  });

  test("warns and skips agent profile with invalid platform", () => {
    const messages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          profiles: { agent: { bad: { platform: "invalid-platform" } } },
        }),
      );
      const loaded = loadConfig();
      expect(loaded.profiles?.agent?.bad).toBeUndefined();
      expect(messages.some((m) => m.includes("platform"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("parses defaults.llm, defaults.agent, defaults.improve", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: 2,
        defaults: {
          llm: "openai-mini",
          agent: "opencode-default",
          improve: "my-custom-profile",
        },
      }),
    );
    const loaded = loadConfig();
    expect(loaded.defaults?.llm).toBe("openai-mini");
    expect(loaded.defaults?.agent).toBe("opencode-default");
    expect(loaded.defaults?.improve).toBe("my-custom-profile");
  });

  test("migrates legacy features.improve to profiles.improve.default.processes", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        features: {
          improve: {
            reflect: { mode: "llm", profile: "openai-mini", timeoutMs: 60000 },
            memory_consolidation: false,
            feedback_distillation: true,
          },
        },
      }),
    );
    const loaded = loadConfig();
    const processes = loaded.profiles?.improve?.default?.processes;
    expect(processes?.reflect?.mode).toBe("llm");
    expect(processes?.reflect?.timeoutMs).toBe(60000);
    expect(processes?.consolidate?.enabled).toBe(false);
    expect(processes?.feedbackDistillation?.enabled).toBe(true);
  });

  test("migrates legacy features.index and features.search into new shape", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        features: {
          index: { memory_inference: true, graph_extraction: { profile: "openai-mini" }, metadata_enhance: false },
          search: { curate_rerank: true },
        },
      }),
    );
    const loaded = loadConfig();
    expect(loaded.profiles?.improve?.default?.processes?.memoryInference?.enabled).toBe(true);
    expect(loaded.index?.metadataEnhance?.enabled).toBe(false);
    expect(loaded.search?.curateRerank?.enabled).toBe(true);
  });

  test("sanitizeConfigForWrite strips apiKey from profiles.llm entries", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: 2,
        profiles: {
          llm: {
            myprofile: {
              endpoint: "https://api.openai.com/v1/chat/completions",
              model: "gpt-4o",
              apiKey: "sk-secret",
            },
          },
        },
      }),
    );
    const loaded = loadConfig();
    saveConfig(loaded);
    // Re-read from disk to verify apiKey was stripped
    const saved = JSON.parse(require("node:fs").readFileSync(getConfigPath(), "utf8"));
    expect(saved.profiles?.llm?.myprofile?.apiKey).toBeUndefined();
    expect(saved.profiles?.llm?.myprofile?.model).toBe("gpt-4o");
  });
});

// ── Auto-migration hook ──────────────────────────────────────────────────────

describe("auto-migration in loadConfig", () => {
  const originalNoAutoMigrate = process.env.AKM_NO_AUTO_MIGRATE;

  afterEach(() => {
    // Restore env after each test
    if (originalNoAutoMigrate === undefined) {
      delete process.env.AKM_NO_AUTO_MIGRATE;
    } else {
      process.env.AKM_NO_AUTO_MIGRATE = originalNoAutoMigrate;
    }
    resetConfigCache();
  });

  test("auto-migrates a v1 config file (missing configVersion) and rewrites it to disk", () => {
    delete process.env.AKM_NO_AUTO_MIGRATE;

    const configPath = getConfigPath();
    // Write a pre-0.8.0 config: has llm.features block, no configVersion
    const v1Config = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { memory_inference: true },
      },
    };
    writeRawConfig(configPath, JSON.stringify(v1Config));

    // loadConfig triggers auto-migration
    const loaded = loadConfig();

    // In-memory config should reflect the migrated shape
    expect(loaded.profiles?.llm?.default?.endpoint).toBe("http://localhost:11434");

    // The file on disk should have been rewritten with configVersion
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk.configVersion).toBe("0.8.0");
    expect(onDisk.llm).toBeUndefined();
    expect(onDisk.profiles?.llm?.default?.endpoint).toBe("http://localhost:11434");

    // A backup should have been created in the cache dir
    const backupDir = path.join(getCacheDir(), "config-backups");
    const backupFiles = fs.readdirSync(backupDir);
    expect(backupFiles.length).toBeGreaterThan(0);
  });

  test("does NOT rewrite the config file when AKM_NO_AUTO_MIGRATE=1", () => {
    process.env.AKM_NO_AUTO_MIGRATE = "1";

    const configPath = getConfigPath();
    const v1Config = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { memory_inference: true },
      },
    };
    writeRawConfig(configPath, JSON.stringify(v1Config));

    // loadConfig should NOT rewrite the file
    loadConfig();

    const onDisk = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(onDisk);
    // File should still match v1 shape — no configVersion written
    expect(parsed.configVersion).toBeUndefined();
    expect(parsed.llm?.features?.memory_inference).toBe(true);
  });

  test("does not crash or backup when config file is already at 0.8.0", () => {
    delete process.env.AKM_NO_AUTO_MIGRATE;

    const configPath = getConfigPath();
    const currentConfig = {
      configVersion: "0.8.0",
      profiles: { llm: { default: { endpoint: "http://localhost:11434", model: "qwen3" } } },
      defaults: { llm: "default" },
    };
    writeRawConfig(configPath, JSON.stringify(currentConfig));

    const loaded = loadConfig();
    expect(loaded.configVersion).toBe("0.8.0");

    // No backup should be created since nothing needed migrating
    const backupDir = path.join(getCacheDir(), "config-backups");
    const backupFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(backupFiles.length).toBe(0);
  });

  test("auto-migration is applied in-memory even when AKM_NO_AUTO_MIGRATE=1", () => {
    process.env.AKM_NO_AUTO_MIGRATE = "1";

    const configPath = getConfigPath();
    const v1Config = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { graph_extraction: false },
      },
    };
    writeRawConfig(configPath, JSON.stringify(v1Config));

    // The LLM endpoint should still be available even though migration was suppressed
    const loaded = loadConfig();
    expect(loaded.profiles?.llm?.default?.endpoint).toBe("http://localhost:11434");
  });

  test("throws ConfigError when migrated write fails (no infinite re-run loop) (#461)", () => {
    delete process.env.AKM_NO_AUTO_MIGRATE;

    const configPath = getConfigPath();
    const v1Config = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { memory_inference: true },
      },
    };
    writeRawConfig(configPath, JSON.stringify(v1Config));

    // Simulate write failure by making the config directory read-only just
    // after the initial read but before the migration write. The simplest way
    // is to make the config FILE read-only AND chmod the dir to drop write
    // permission so the atomic rename can't replace it.
    const configDir = path.dirname(configPath);
    fs.chmodSync(configDir, 0o555);
    try {
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/Failed to write migrated config/);
    } finally {
      // Restore so cleanup() can rm -rf the tmp dir.
      fs.chmodSync(configDir, 0o755);
    }
  });
});

// ── Newer-than-binary config guard (Fix 2 / migration safety) ──────────────

describe("newer-than-binary config guard", () => {
  const originalForceDowngrade = process.env.AKM_FORCE_DOWNGRADE_CONFIG;

  afterEach(() => {
    if (originalForceDowngrade === undefined) {
      delete process.env.AKM_FORCE_DOWNGRADE_CONFIG;
    } else {
      process.env.AKM_FORCE_DOWNGRADE_CONFIG = originalForceDowngrade;
    }
  });

  test("loadConfig reads a newer-than-binary config successfully", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.99.0",
        semanticSearchMode: "off",
        // Field the older binary does not know about — must be silently dropped
        // on read (existing behaviour) but preserved on disk.
        unknownFutureField: { foo: "bar" },
      }),
    );

    const loaded = loadConfig();
    expect(loaded.semanticSearchMode).toBe("off");
    // Disk bytes must be untouched (no auto-migration of a newer config).
    const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(onDisk.configVersion).toBe("0.99.0");
    expect(onDisk.unknownFutureField).toEqual({ foo: "bar" });
    // Read-only reason is recorded for diagnostics.
    expect(getConfigReadOnlyReason()?.foundVersion).toBe("0.99.0");
  });

  test("saveConfig throws when the loaded config is newer than the binary", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.99.0", semanticSearchMode: "off" }));
    const loaded = loadConfig();

    expect(() => saveConfig({ ...loaded, semanticSearchMode: "auto" })).toThrow(ConfigError);
    expect(() => saveConfig({ ...loaded, semanticSearchMode: "auto" })).toThrow(
      /config v0\.99\.0 .* is newer than this binary .* refusing to write/,
    );
    expect(() => saveConfig({ ...loaded, semanticSearchMode: "auto" })).toThrow(/AKM_FORCE_DOWNGRADE_CONFIG=1/);
  });

  test("AKM_FORCE_DOWNGRADE_CONFIG=1 lets the write proceed", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.99.0",
        semanticSearchMode: "off",
        unknownFutureField: { foo: "bar" },
      }),
    );
    const loaded = loadConfig();

    process.env.AKM_FORCE_DOWNGRADE_CONFIG = "1";
    expect(() => saveConfig({ ...loaded, semanticSearchMode: "auto" })).not.toThrow();

    // The unknown future field was stripped by sanitizeConfigForWrite as the
    // user explicitly opted in to a downgrade.
    const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(onDisk.unknownFutureField).toBeUndefined();
    expect(onDisk.semanticSearchMode).toBe("auto");
  });

  test("maybeAutoMigrateConfigFile does not rewrite a newer config", () => {
    const newerConfig = {
      configVersion: "0.99.0",
      // legacy llm.features key that WOULD normally trigger an auto-migration
      llm: { endpoint: "http://localhost", model: "qwen3", features: { graph_extraction: false } },
    };
    const original = JSON.stringify(newerConfig, null, 2);
    writeRawConfig(getConfigPath(), original);
    const mtimeBefore = fs.statSync(getConfigPath()).mtimeMs;

    loadConfig();

    const onDisk = fs.readFileSync(getConfigPath(), "utf8");
    expect(onDisk).toBe(`${JSON.stringify(newerConfig, null, 2)}`);
    // No write occurred — file bytes unchanged.
    const mtimeAfter = fs.statSync(getConfigPath()).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  test("project config with newer version triggers the same guard", () => {
    const projectDir = makeTmpDir();
    try {
      // User config at current version — safe on its own.
      writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.8.0" }));
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({ configVersion: "0.99.0", semanticSearchMode: "off" }),
      );

      process.chdir(projectDir);

      // Reading still works.
      const loaded = loadConfig();
      expect(loaded.semanticSearchMode).toBe("off");
      // …but saveConfig is blocked because a project layer was newer.
      expect(() => saveConfig(loaded)).toThrow(/is newer than this binary/);
    } finally {
      cleanup(projectDir);
    }
  });

  test("legacy numeric configVersion at current shape does not trigger the guard", () => {
    // legacy `configVersion: 2` is treated as "already migrated to v2 shape"
    // by migrateConfigShape; it must NOT be flagged as newer than 0.8.0.
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: 2, semanticSearchMode: "off" }));
    const loaded = loadConfig();
    expect(loaded.semanticSearchMode).toBe("off");
    expect(getConfigReadOnlyReason()).toBeUndefined();
    expect(() => saveConfig(loaded)).not.toThrow();
  });
});
