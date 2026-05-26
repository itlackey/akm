import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  getDefaultLlmConfig,
  loadConfig,
  loadUserConfig,
  requireLlmConfig,
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

// XDG_* / HOME / AKM_STASH_DIR / cwd snapshot+restore is provided by
// tests/_preload.ts. This block only owns the per-test tmp-dir lifecycle
// and the production-singleton reset.
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
  resetConfigCache();
});

afterEach(() => {
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

  test("passes through string 'auto' for semanticSearchMode", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "auto" }));
    expect(loadConfig().semanticSearchMode).toBe("auto");
  });

  test("passes through string 'off' for semanticSearchMode", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "off" }));
    expect(loadConfig().semanticSearchMode).toBe("off");
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

  test("project-level .akm/config.json is no longer merged (single-layer load)", () => {
    // Multi-layer project config was removed; only the user-level config is
    // read. A project-level file under cwd-ancestors emits a deprecation
    // warning but does NOT contribute settings.
    const projectDir = makeTmpDir();
    const restoreCwd = process.cwd();
    try {
      writeRawConfig(getConfigPath(), JSON.stringify({ semanticSearchMode: "auto" }));
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({
          semanticSearchMode: "off",
          sources: [{ type: "filesystem", path: "/project-stash" }],
        }),
      );
      process.chdir(projectDir);
      const loaded = loadConfig();
      expect(loaded.semanticSearchMode).toBe("auto");
      // sources from project config are ignored
      expect(loaded.sources).toBeUndefined();
    } finally {
      process.chdir(restoreCwd);
      cleanup(projectDir);
    }
  });

  test("migrates legacy `stashes[]` to `sources[]` with a deprecation warning", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        stashes: [{ type: "filesystem", path: "/legacy-stash", name: "legacy" }],
      }),
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      const config = loadConfig();
      expect(config.sources?.[0]?.path).toBe("/legacy-stash");
      expect((config as unknown as Record<string, unknown>).stashes).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("stashes[]") && w.includes("sources[]"))).toBe(true);
  });

  test("drops openviking sources during migration with a warning", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        sources: [
          { type: "openviking", url: "https://ov.example.com", name: "my-ov" },
          { type: "filesystem", path: "/keep", name: "keep" },
        ],
      }),
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      const config = loadConfig();
      expect(config.sources?.length).toBe(1);
      expect(config.sources?.[0]?.name).toBe("keep");
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("openviking") && w.includes("my-ov"))).toBe(true);
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

  test("emits a one-time deprecation warning when a project-level config is discovered (#457)", () => {
    const projectDir = makeTmpDir();
    const restoreCwd = process.cwd();
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
      // Warning mentions deprecation + project-level + that the file is ignored.
      expect(messages.some((m) => m.includes("DEPRECATED") && m.includes("project-level"))).toBe(true);
      expect(messages.some((m) => m.includes("ignored"))).toBe(true);
    } finally {
      process.chdir(restoreCwd);
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

  test("writes only user config and ignores any project-level .akm/config.json", () => {
    // Project-level config files are no longer merged (single-layer load).
    // updateConfig writes to the user-level file; project-level files are
    // left untouched and their settings have no effect on loadConfig().
    const projectDir = makeTmpDir();
    const restoreCwd = process.cwd();
    try {
      writeRawConfig(
        path.join(projectDir, ".akm", "config.json"),
        JSON.stringify({ sources: [{ type: "filesystem", path: "/project-stash" }] }),
      );

      process.chdir(projectDir);
      updateConfig({ semanticSearchMode: "off" });

      // Project sources are NOT merged in.
      expect(loadConfig().sources).toBeUndefined();
      expect(loadUserConfig().sources).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8"))).not.toHaveProperty("stashes");
      expect(loadUserConfig().semanticSearchMode).toBe("off");
    } finally {
      process.chdir(restoreCwd);
      cleanup(projectDir);
    }
  });
});

describe("output config", () => {
  test("loads valid output config", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ output: { format: "text", detail: "full" } }));
    expect(loadConfig().output).toEqual({ format: "text", detail: "full" });
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

  // Regression: on 2026-05-23 a config-rewrite dropped `defaults.llm` while
  // leaving `profiles.llm.default` intact. `getDefaultLlmConfig` returned
  // undefined, every pass that goes through it (memory-inference, distill's
  // chat path) silently no-op'd for ~18h. Implicit fallback closes that hole.
  describe("default LLM resolution (implicit profiles.llm.default fallback)", () => {
    const llmConfig = {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    };

    test("getDefaultLlmConfig honors explicit defaults.llm", () => {
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { llm: "primary" },
        profiles: { llm: { primary: llmConfig } },
      };
      expect(getDefaultLlmConfig(cfg)).toEqual(llmConfig);
    });

    test("getDefaultLlmConfig falls back to profiles.llm.default when defaults.llm is unset", () => {
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { agent: "opencode" },
        profiles: { llm: { default: llmConfig } },
      };
      expect(getDefaultLlmConfig(cfg)).toEqual(llmConfig);
    });

    test("getDefaultLlmConfig returns undefined when neither defaults.llm nor profiles.llm.default is set", () => {
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { agent: "opencode" },
        profiles: { llm: { gemma: llmConfig } },
      };
      expect(getDefaultLlmConfig(cfg)).toBeUndefined();
    });

    test("requireLlmConfig falls back to profiles.llm.default when defaults.llm is unset", () => {
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { agent: "opencode" },
        profiles: { llm: { default: llmConfig } },
      };
      expect(requireLlmConfig(cfg)).toEqual(llmConfig);
    });

    test("requireLlmConfig throws when neither defaults.llm nor profiles.llm.default is set", () => {
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { agent: "opencode" },
        profiles: { llm: { gemma: llmConfig } },
      };
      expect(() => requireLlmConfig(cfg)).toThrow(ConfigError);
      expect(() => requireLlmConfig(cfg)).toThrow(/LLM is not configured/);
    });

    test("explicit defaults.llm takes precedence over an unrelated profiles.llm.default", () => {
      const explicit = { endpoint: "http://explicit/v1", model: "explicit-model" };
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { llm: "primary" },
        profiles: { llm: { primary: explicit, default: llmConfig } },
      };
      expect(getDefaultLlmConfig(cfg)).toEqual(explicit);
      expect(requireLlmConfig(cfg)).toEqual(explicit);
    });
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

  test("rejects search.graphBoost.confidenceWeight > 1 (no silent clamp)", () => {
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

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/confidenceWeight/);
  });

  test("rejects search.graphBoost.maxHops > 3 (no silent clamp)", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ search: { graphBoost: { maxHops: 99 } } }));
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/maxHops/);
  });

  test("rejects unknown search.graphBoost keys (typos surface at load time)", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        search: {
          graphBoost: {
            maxHops: 2,
            unsupportedNested: "x",
          },
        },
      }),
    );

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/unsupportedNested/);
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

  test("rejects agent profile with invalid platform (no silent drop)", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        profiles: { agent: { bad: { platform: "invalid-platform" } } },
      }),
    );
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/platform/);
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
    // 0.8.0: feedback_distillation migrates into the unified distill gate.
    expect(processes?.distill?.enabled).toBe(true);
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
