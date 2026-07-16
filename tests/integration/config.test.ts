import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  getDefaultLlmConfig,
  getImproveProcessConfig,
  type ImproveProfileConfig,
  loadConfig,
  loadUserConfig,
  requireLlmConfig,
  resetConfigCache,
  saveConfig,
  updateConfig,
} from "../../src/core/config/config";
import { backupExistingConfig } from "../../src/core/config/config-io";
import { ConfigError } from "../../src/core/errors";
import { getCacheDir, getConfigDir, getConfigPath } from "../../src/core/paths";
import { setQuiet } from "../../src/core/warn";

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

function writeCurrentConfig(value: Record<string, unknown>): void {
  writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", ...value }));
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
    writeCurrentConfig({ semanticSearchMode: "off" });

    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("off");
    expect(config.sources).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
    expect(config.registries).toEqual(DEFAULT_CONFIG.registries);
  });

  test("merges partial config with defaults", () => {
    writeCurrentConfig({ semanticSearchMode: "off" });
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
    writeCurrentConfig({ semanticSearchMode: "auto" });
    expect(loadConfig().semanticSearchMode).toBe("auto");
  });

  test("passes through string 'off' for semanticSearchMode", () => {
    writeCurrentConfig({ semanticSearchMode: "off" });
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
      writeCurrentConfig({ semanticSearchMode: "auto" });
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

  test("rejects the retired `stashes[]` key instead of aliasing it to `sources[]`", () => {
    writeCurrentConfig({
      stashes: [{ type: "filesystem", path: "/legacy-stash", name: "legacy" }],
    });

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/stashes is retired in 0\.9/);
  });

  test("rejects retired openviking sources instead of dropping them", () => {
    writeCurrentConfig({
      sources: [
        { type: "openviking", url: "https://ov.example.com", name: "my-ov" },
        { type: "filesystem", path: "/keep", name: "keep" },
      ],
    });

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/sources\.0\.type/);
  });

  test("throws ConfigError when installed npm entry is marked writable", () => {
    writeCurrentConfig({
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
    });

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
      // setQuiet(false): harness defaults to quiet=true; opt into noisy mode so
      // warn() inside warnIfProjectConfigPresent reaches the patched console.warn.
      setQuiet(false);
      console.warn = (...args: unknown[]) => {
        messages.push(args.map(String).join(" "));
      };
      try {
        process.chdir(projectDir);
        loadConfig();
      } finally {
        console.warn = originalWarn;
        setQuiet(true); // restore harness default
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
    const config = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "off" as const,
      sources: [{ type: "filesystem" as const, path: "/extra" }],
    };
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
    expect(JSON.parse(fs.readFileSync(latestPath, "utf8"))).toEqual({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
    });

    const backups = fs.readdirSync(backupDir).filter((name) => name.startsWith("config-") && name.endsWith(".json"));
    expect(backups.length).toBeGreaterThan(0);
  });

  test("same-millisecond config backups never overwrite each other", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"version":1}\n');
    const instant = new Date("2026-07-11T12:34:56.789Z");
    const first = backupExistingConfig(configPath, instant);
    fs.writeFileSync(configPath, '{"version":2}\n');
    const second = backupExistingConfig(configPath, instant);

    expect(first?.timestamped).not.toBe(second?.timestamped);
    expect(fs.readFileSync(first?.timestamped as string, "utf8")).toContain('"version":1');
    expect(fs.readFileSync(second?.timestamped as string, "utf8")).toContain('"version":2');
  });

  test("config backups are written owner-only (0600) — they can carry secrets (08-F4)", () => {
    saveConfig({ semanticSearchMode: "off" });
    // A second save backs up the first config file.
    saveConfig({ semanticSearchMode: "auto" });

    const backupDir = path.join(getCacheDir(), "config-backups");
    // The backup dir is owner-only (0700) so the copy→chmod window is not
    // traversable by other local users.
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    const latestPath = path.join(backupDir, "config.latest.json");
    expect(fs.existsSync(latestPath)).toBe(true);
    expect(fs.statSync(latestPath).mode & 0o777).toBe(0o600);

    const timestamped = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith("config-") && name.endsWith(".json"));
    expect(timestamped.length).toBeGreaterThan(0);
    for (const name of timestamped) {
      expect(fs.statSync(path.join(backupDir, name)).mode & 0o777).toBe(0o600);
    }
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
    writeCurrentConfig({ output: { format: "text", detail: "full" } });
    expect(loadConfig().output).toEqual({ format: "text", detail: "full" });
  });
});

// ── embedding config ────────────────────────────────────────────────────────

describe("embedding config", () => {
  test("loads embedding connection config", () => {
    writeCurrentConfig({
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      },
    });
    expect(loadConfig().embedding).toEqual({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
  });

  test("loads embedding config with a symbolic apiKey", () => {
    writeCurrentConfig({
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
        apiKey: "$OPENAI_API_KEY",
      },
    });
    expect(loadConfig().embedding?.apiKey).toBe("$OPENAI_API_KEY");
  });

  test("loads embedding config with provider and dimension", () => {
    writeCurrentConfig({
      embedding: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
        dimension: 384,
      },
    });
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

  test("clears embedding config with an explicit lifecycle write", () => {
    const embeddingConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    };
    updateConfig({ embedding: embeddingConfig });
    saveConfig({ ...loadConfig(), embedding: undefined });
    expect(loadConfig().embedding).toBeUndefined();
  });
});

// ── LLM engine config ───────────────────────────────────────────────────────

describe("LLM engine config", () => {
  test("loads an LLM engine connection", () => {
    writeCurrentConfig({
      engines: {
        local: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "llama3.2",
        },
      },
      defaults: { llmEngine: "local" },
    });
    const cfg = loadConfig();
    expect(cfg.engines?.local).toMatchObject({
      kind: "llm",
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    });
    expect(cfg.defaults?.llmEngine).toBe("local");
  });

  test("materializes a symbolic engine apiKey from the environment", () => {
    writeCurrentConfig({
      engines: {
        local: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "llama3.2",
          apiKey: "$AKM_LLM_API_KEY",
        },
      },
      defaults: { llmEngine: "local" },
    });
    process.env.AKM_LLM_API_KEY = "sk-selected-engine";
    try {
      const cfg = loadConfig();
      expect(cfg.engines?.local?.apiKey).toBe("$AKM_LLM_API_KEY");
      expect(getDefaultLlmConfig(cfg)?.apiKey).toBe("sk-selected-engine");
    } finally {
      delete process.env.AKM_LLM_API_KEY;
    }
  });

  test("loads a symbolic LLM engine apiKey", () => {
    writeCurrentConfig({
      engines: {
        cloud: {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4",
          apiKey: "$OPENAI_API_KEY",
        },
      },
    });
    expect(loadConfig().engines?.cloud?.apiKey).toBe("$OPENAI_API_KEY");
  });

  test("loads an LLM engine with provider, temperature, and maxTokens", () => {
    writeCurrentConfig({
      engines: {
        cloud: {
          kind: "llm",
          provider: "openai",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
          temperature: 0.6,
          maxTokens: 256,
        },
      },
    });
    expect(loadConfig().engines?.cloud).toMatchObject({
      kind: "llm",
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: 0.6,
      maxTokens: 256,
    });
  });

  test("roundtrips an LLM engine via updateConfig", () => {
    const engine = {
      kind: "llm" as const,
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    };
    updateConfig({ engines: { local: engine }, defaults: { llmEngine: "local" } });
    expect(loadConfig().engines?.local).toMatchObject(engine);
  });

  describe("default LLM engine resolution", () => {
    const engine = {
      kind: "llm" as const,
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
    };

    test("getDefaultLlmConfig honors explicit defaults.llmEngine", () => {
      const cfg = { ...DEFAULT_CONFIG, defaults: { llmEngine: "primary" }, engines: { primary: engine } };
      expect(getDefaultLlmConfig(cfg)).toEqual({ endpoint: engine.endpoint, model: engine.model, timeoutMs: 600_000 });
    });

    test("getDefaultLlmConfig does not infer an engine named default", () => {
      const cfg = { ...DEFAULT_CONFIG, engines: { default: engine } };
      expect(getDefaultLlmConfig(cfg)).toBeUndefined();
    });

    test("getDefaultLlmConfig returns undefined when no LLM engine is selected", () => {
      const cfg = { ...DEFAULT_CONFIG, engines: { gemma: engine } };
      expect(getDefaultLlmConfig(cfg)).toBeUndefined();
    });

    test("requireLlmConfig resolves the selected LLM engine", () => {
      const cfg = { ...DEFAULT_CONFIG, defaults: { llmEngine: "local" }, engines: { local: engine } };
      expect(requireLlmConfig(cfg)).toEqual({ endpoint: engine.endpoint, model: engine.model, timeoutMs: 600_000 });
    });

    test("requireLlmConfig throws when no LLM engine is selected", () => {
      const cfg = { ...DEFAULT_CONFIG, engines: { gemma: engine } };
      expect(() => requireLlmConfig(cfg)).toThrow(ConfigError);
      expect(() => requireLlmConfig(cfg)).toThrow(/No LLM engine is selected/);
    });

    test("explicit defaults.llmEngine selects one of several engines", () => {
      const explicit = {
        kind: "llm" as const,
        endpoint: "http://explicit/v1/chat/completions",
        model: "explicit-model",
      };
      const cfg = {
        ...DEFAULT_CONFIG,
        defaults: { llmEngine: "primary" },
        engines: { primary: explicit, default: engine },
      };
      expect(getDefaultLlmConfig(cfg)).toEqual({
        endpoint: explicit.endpoint,
        model: explicit.model,
        timeoutMs: 600_000,
      });
      expect(requireLlmConfig(cfg)).toEqual({
        endpoint: explicit.endpoint,
        model: explicit.model,
        timeoutMs: 600_000,
      });
    });
  });
});

// ── getImproveProcessConfig accessor ─────────────────────────────────────────

// The accessor only reads the strategy already selected by the caller. It does
// not re-resolve defaults or fall back to another strategy.
describe("getImproveProcessConfig", () => {
  test("returns the named process section from the selected improve strategy", () => {
    const selected = { processes: { consolidate: { enabled: true, minPoolSize: 42 } } };
    expect(getImproveProcessConfig("consolidate", selected)).toEqual({
      enabled: true,
      minPoolSize: 42,
    });
  });

  test("returns undefined when the process is absent", () => {
    const selected = { processes: { consolidate: { enabled: true } } };
    expect(getImproveProcessConfig("extract", selected)).toBeUndefined();
  });

  test("returns undefined when no strategy was selected", () => {
    // Post-WI-9.1 the signature cannot even receive a config, so "does not
    // implicitly consult configured strategies" is guaranteed by construction.
    expect(getImproveProcessConfig("reflect")).toBeUndefined();
  });

  test("the selected strategy's per-process override is authoritative", () => {
    const activeProfile = { processes: { distill: { enabled: true } } } as unknown as ImproveProfileConfig;
    expect(getImproveProcessConfig("distill", activeProfile)).toEqual({ enabled: true });
  });

  test("does not fall back when the selected strategy omits the section", () => {
    const activeProfile = { processes: { distill: { enabled: true } } } as unknown as ImproveProfileConfig;
    expect(getImproveProcessConfig("consolidate", activeProfile)).toBeUndefined();
  });
});

// ── stashDir config ──────────────────────────────────────────────────────────

describe("stashDir config", () => {
  test("loads stashDir from config.json", () => {
    writeCurrentConfig({ stashDir: "/home/user/my-stash" });
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
    writeCurrentConfig({
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
    });

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
    writeCurrentConfig({
      search: {
        graphBoost: {
          confidenceMode: "blend",
          confidenceWeight: 99,
        },
      },
    });

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/confidenceWeight/);
  });

  test("rejects search.graphBoost.maxHops > 3 (no silent clamp)", () => {
    writeCurrentConfig({ search: { graphBoost: { maxHops: 99 } } });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/maxHops/);
  });

  test("tolerates unknown search.graphBoost keys (lenient unknown-key policy)", () => {
    // Lenient policy: unknown keys are preserved, not rejected — cross-version
    // config skew must not become INVALID_CONFIG_FILE. Known keys still validate.
    writeCurrentConfig({
      search: {
        graphBoost: {
          maxHops: 2,
          unsupportedNested: "x",
        },
      },
    });

    expect(() => loadConfig()).not.toThrow();
    const gb = loadConfig().search?.graphBoost as Record<string, unknown>;
    expect(gb.maxHops).toBe(2);
    expect(gb.unsupportedNested).toBe("x");
  });
});

describe("0.9 config shape parsing", () => {
  test("parses configVersion", () => {
    writeCurrentConfig({});
    const loaded = loadConfig();
    expect(loaded.configVersion).toBe("0.9.0");
  });

  test("parses an LLM engine with supportsJsonSchema", () => {
    writeCurrentConfig({
      engines: {
        "openai-mini": {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
          temperature: 0.3,
          supportsJsonSchema: true,
        },
      },
    });
    const loaded = loadConfig();
    expect(loaded.engines?.["openai-mini"]?.model).toBe("gpt-4o-mini");
    expect(loaded.engines?.["openai-mini"]?.supportsJsonSchema).toBe(true);
  });

  test("parses agent engines with platform fields", () => {
    writeCurrentConfig({
      engines: {
        "opencode-default": { kind: "agent", platform: "opencode", bin: "opencode", args: ["run"] },
        "opencode-sdk": { kind: "agent", platform: "opencode-sdk", workspace: "/tmp", model: "claude-3" },
      },
    });
    const loaded = loadConfig();
    expect(loaded.engines?.["opencode-default"]?.platform).toBe("opencode");
    expect(loaded.engines?.["opencode-sdk"]?.platform).toBe("opencode-sdk");
    expect(loaded.engines?.["opencode-sdk"]?.model).toBe("claude-3");
  });

  test("rejects an agent engine with invalid platform (no silent drop)", () => {
    writeCurrentConfig({ engines: { bad: { kind: "agent", platform: "invalid-platform" } } });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/engines\.bad/);
  });

  test("parses canonical engine and improve strategy defaults", () => {
    writeCurrentConfig({
      engines: {
        "openai-mini": {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
        },
        "opencode-default": { kind: "agent", platform: "opencode" },
      },
      defaults: {
        llmEngine: "openai-mini",
        engine: "opencode-default",
        improveStrategy: "my-custom-strategy",
      },
      improve: { strategies: { "my-custom-strategy": {} } },
    });
    const loaded = loadConfig();
    expect(loaded.defaults?.llmEngine).toBe("openai-mini");
    expect(loaded.defaults?.engine).toBe("opencode-default");
    expect(loaded.defaults?.improveStrategy).toBe("my-custom-strategy");
  });

  test("rejects legacy features.improve instead of translating it", () => {
    writeCurrentConfig({
      features: {
        improve: {
          reflect: { mode: "llm", profile: "openai-mini", timeoutMs: 60000 },
          memory_consolidation: false,
          feedback_distillation: true,
        },
      },
    });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/features is retired in 0\.9/);
  });

  test("rejects legacy feature index/search blocks instead of translating them", () => {
    writeCurrentConfig({
      features: {
        index: { memory_inference: true, graph_extraction: { profile: "openai-mini" }, metadata_enhance: false },
        search: { curate_rerank: true },
      },
    });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/features is retired in 0\.9/);
  });

  test("rejects literal engine apiKey values before persistence", () => {
    writeCurrentConfig({
      engines: {
        cloud: {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o",
          apiKey: "sk-secret",
        },
      },
    });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/apiKey must be \$VAR/);
  });
});

// ── Strict version gate ──────────────────────────────────────────────────────

describe("strict 0.9 config loading", () => {
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

  test("rejects a legacy config with no configVersion without rewriting it", () => {
    delete process.env.AKM_NO_AUTO_MIGRATE;

    const configPath = getConfigPath();
    const v1Config = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { memory_inference: true },
      },
    };
    const original = JSON.stringify(v1Config);
    writeRawConfig(configPath, original);

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/Unsupported configVersion/);
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk.configVersion).toBeUndefined();
    expect(onDisk.llm?.endpoint).toBe("http://localhost:11434");
    expect(onDisk.profiles).toBeUndefined();
    const backupDir = path.join(getCacheDir(), "config-backups");
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  test("AKM_NO_AUTO_MIGRATE does not bypass the strict version gate", () => {
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

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/Unsupported configVersion/);

    const onDisk = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(onDisk);
    expect(parsed.configVersion).toBeUndefined();
    expect(parsed.llm?.features?.memory_inference).toBe(true);
  });

  test("rejects 0.8.0 profile vocabulary without creating a backup", () => {
    delete process.env.AKM_NO_AUTO_MIGRATE;

    const configPath = getConfigPath();
    const currentConfig = {
      configVersion: "0.8.0",
      profiles: { llm: { default: { endpoint: "http://localhost:11434", model: "qwen3" } } },
      defaults: { llm: "default" },
    };
    writeRawConfig(configPath, JSON.stringify(currentConfig));

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/Unsupported configVersion/);

    // No backup should be created since nothing needed migrating
    const backupDir = path.join(getCacheDir(), "config-backups");
    const backupFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(backupFiles.length).toBe(0);
  });

  test("does not translate retired LLM vocabulary in memory", () => {
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

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/Unsupported configVersion/);
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk.profiles).toBeUndefined();
    expect(onDisk.llm.endpoint).toBe("http://localhost:11434");
  });

  test("version rejection does not attempt a write even when the directory is read-only (#461)", () => {
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

    const configDir = path.dirname(configPath);
    fs.chmodSync(configDir, 0o555);
    try {
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/Unsupported configVersion/);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).llm.model).toBe("qwen3");
    } finally {
      fs.chmodSync(configDir, 0o755);
    }
  });
});
