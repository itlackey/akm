import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  getConfigValueSource,
  getImproveProcessConfig,
  type ImproveProfileConfig,
  loadConfig,
  loadUserConfig,
  primaryBundlePath,
  resetConfigCache,
  saveConfig,
  updateConfig,
} from "../src/core/config/config";
import { backupExistingConfig } from "../src/core/config/config-io";
import { EmbeddingConnectionConfigSchema } from "../src/core/config/config-schema";
import { ConfigError } from "../src/core/errors";
import { getCacheDir, getConfigDir, getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import {
  type Cleanup,
  mockHomedir,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "./_helpers/sandbox";

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

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    fn();
    return warnings;
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

// XDG_* / HOME / AKM_BUNDLE_DIR / cwd snapshot+restore is provided by
// tests/_preload.ts. This block only owns the per-test tmp-dir lifecycle
// and the production-singleton reset.
let testConfigHome = "";
let xdgCleanup: Cleanup = () => {};

beforeEach(() => {
  const cfg = sandboxXdgConfigHome();
  const cache = sandboxXdgCacheHome(cfg.cleanup);
  const data = sandboxXdgDataHome(cache.cleanup);
  const state = sandboxXdgStateHome(data.cleanup);
  testConfigHome = cfg.dir;
  xdgCleanup = state.cleanup;
  resetConfigCache();
});

afterEach(() => {
  xdgCleanup();
  testConfigHome = "";
  resetConfigCache();
});

// ── getConfigPath ───────────────────────────────────────────────────────────

describe("getConfigPath", () => {
  test("returns config.json under XDG_CONFIG_HOME", () => {
    expect(getConfigPath()).toBe(path.join(testConfigHome, "akm", "config.json"));
  });

  test("defaults to ~/.config/akm when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    // Defense against CI environments where AKM_BUNDLE_DIR is inherited
    // from outer test isolation: if it points at a transient path,
    // getConfigDir's isolation rule fires and overrides the HOME-based
    // fallback this test is verifying (the 2026-05-23
    // setup-clobbers-user-config incident).
    delete process.env.AKM_BUNDLE_DIR;
    const home = sandboxHome();

    expect(getConfigPath()).toBe(path.join(home.dir, ".config", "akm", "config.json"));

    home.cleanup();
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

  // Owner ruling 9 (R-039), deliberately pinning the NEW default: a bare
  // install (no config.json) must never silently pull the ~130 MB local
  // embedding model on first index, so `semanticSearchMode` defaults to
  // "off". This was previously "auto" — the interactive `akm setup` wizard
  // is the only place that still pre-selects semantic search ON (see
  // tests/setup-wizard.test.ts), with a warning, before saving a config.
  test("defaults semanticSearchMode to 'off' for a bare/headless install (R-039)", () => {
    expect(DEFAULT_CONFIG.semanticSearchMode).toBe("off");
    expect(loadConfig().semanticSearchMode).toBe("off");
  });

  test("loads config without requiring AKM_BUNDLE_DIR", () => {
    delete process.env.AKM_BUNDLE_DIR;
    writeCurrentConfig({ semanticSearchMode: "off" });

    const config = loadConfig();
    expect(config.semanticSearchMode).toBe("off");
    expect(config.sources).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
    expect(config.registries).toEqual(DEFAULT_CONFIG.registries);
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
    // read. A project-level file under cwd-ancestors does not contribute
    // settings.
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

  test("ignores the retired `stashes[]` key instead of failing config load", () => {
    writeCurrentConfig({
      stashes: [{ type: "filesystem", path: "/legacy-stash", name: "legacy" }],
    });

    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).not.toThrow();
    });
    expect(warnings.some((w) => w.includes("stashes") && w.includes("retired"))).toBe(true);
  });

  test("folds the retired `sources[]` key into bundles, dropping entries this shim does not recognize", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
        sources: [
          { type: "openviking", url: "https://ov.example.com", name: "my-ov" },
          { type: "filesystem", path: "/keep", name: "keep" },
        ],
      }),
    );

    const warnings = captureWarnings(() => {
      const config = loadConfig();
      expect(config.bundles).not.toHaveProperty("my-ov");
      expect(config.bundles?.keep).toMatchObject({ path: "/keep", writable: true });
      expect(config.defaultBundle).toBe("keep");
      expect((config as unknown as Record<string, unknown>).sources).toBeUndefined();
    });
    expect(warnings.some((w) => w.includes("sources") && w.includes("akm migrate apply"))).toBe(true);
  });

  test("drops the retired `installed[]` key (no 0.9 equivalent) instead of failing config load", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
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

    const warnings = captureWarnings(() => {
      const config = loadConfig();
      expect((config as unknown as Record<string, unknown>).installed).toBeUndefined();
    });
    expect(warnings.some((w) => w.includes("installed") && w.includes("akm migrate apply"))).toBe(true);
  });

  // `stashDir` becomes the `stash` bundle and the default write target.
  test("folds the retired `stashDir` key into a `stash` bundle instead of failing config load", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
        stashDir: "/legacy-stash",
      }),
    );

    const warnings = captureWarnings(() => {
      const config = loadConfig();
      expect(config.bundles?.stash).toMatchObject({ path: "/legacy-stash", writable: true });
      expect(config.defaultBundle).toBe("stash");
      expect((config as unknown as Record<string, unknown>).stashDir).toBeUndefined();
    });
    expect(warnings.some((w) => w.includes("stashDir") && w.includes("akm migrate apply"))).toBe(true);
  });
});

// ── saveConfig ──────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("writes formatted JSON to config.json", () => {
    const config = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "off" as const,
      bundles: { extra: { path: "/extra" } },
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
      bundles: { a: { path: "/a" }, b: { path: "/b" } },
    };
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.semanticSearchMode).toBe("off");
    expect(loaded.bundles).toEqual({ a: { path: "/a" }, b: { path: "/b" } });
    expect(loaded.output).toEqual({ format: "json", detail: "brief" });
  });

  test("roundtrips output config", () => {
    const config = {
      semanticSearchMode: "off" as const,
      bundles: { a: { path: "/a" } },
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
    // RUNTIME-09: this loop used to busy-spin ~10ms between saves "so each
    // backup gets a unique filename [for] mtimeMs, what we sort on". Verified
    // that reasoning was backwards: `backupExistingConfig` de-collides
    // *filenames* itself (src/core/config/config-io.ts:121-133, an EEXIST
    // retry loop appending -1/-2/... to the ISO-millisecond timestamp), while
    // `pruneOldBackups` (config-io.ts:147-174) sorts on `mtimeMs` and keeps
    // only the newest 5 via `slice(MAX_CONFIG_BACKUPS)` — a COUNT-based cut
    // that holds regardless of how mtimeMs ties break, so tied timestamps
    // were never a correctness risk for this test's assertions (≤5 remain,
    // config.latest.json exists). Empirically confirmed too: measured
    // mtimeMs across 10 back-to-back saves already differs at sub-millisecond
    // resolution (real filesystem, no spin needed), and 150 repeated runs of
    // this exact loop without the spin were 150/150 green. 10 saves → up to
    // 10 distinct backup files, but at most 5 should remain.
    for (let i = 0; i < 10; i++) {
      saveConfig({ semanticSearchMode: i % 2 === 0 ? "off" : "auto" });
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
    saveConfig({ semanticSearchMode: "auto", bundles: { a: { path: "/a" } } });
    const updated = updateConfig({ semanticSearchMode: "off" });
    expect(updated.semanticSearchMode).toBe("off");
    expect(updated.bundles).toEqual({ a: { path: "/a" } });
    expect(loadConfig()).toEqual(updated);
  });

  test("creates config.json if it does not exist", () => {
    const updated = updateConfig({ semanticSearchMode: "off" });
    expect(updated.semanticSearchMode).toBe("off");
    expect(updated.bundles).toBeUndefined();
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

  test("ignores the retired `embedding.chunkSize` key, unvalidated, with no error and no warning (#954)", () => {
    // Nothing in src/ ever read embedding.chunkSize; it is dead, not migrated. Before #954 it was
    // still a *validated* schema field (positiveInt), so an out-of-range value failed config
    // load even though the value was never used. Retiring the key drops the validation with it:
    // `embedding` stays `.passthrough()`, so a config that still sets chunkSize — valid or not —
    // is simply carried through unread, never rejected and never warned about. -3 is chosen
    // because it fails the old `positiveInt` (int + positive) validation, making this the
    // distinguishing case: it throws on the unchanged schema and loads clean once retired.
    writeCurrentConfig({ embedding: { chunkSize: -3 } });
    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).not.toThrow();
    });
    expect(warnings).toEqual([]);
    expect(loadConfig().embedding?.chunkSize).toBe(-3);
    expect(Object.keys(EmbeddingConnectionConfigSchema.shape)).not.toContain("chunkSize");
  });

  test("ignores the retired `embedding.maxInputTokens`/`maxTokens`/`batchSize`/`contextLength` keys, unvalidated, with no error and no warning (index-redesign, B5)", () => {
    // RemoteEmbedder now packs requests against the provider's own probed
    // window (`probeProviderLimits`, threaded in by `drain.ts` as
    // `EmbeddingRequestPacking`) instead of these four config knobs — same
    // rationale and same test shape as the `chunkSize` retirement above:
    // `embedding` stays `.passthrough()`, so a config that still sets any of
    // them — valid or not — is simply carried through unread, never rejected
    // and never warned about. -3 is chosen for each because it fails the old
    // `positiveInt` (int + positive) validation, making this the
    // distinguishing case: it threw on the unchanged schema and loads clean
    // once retired.
    writeCurrentConfig({
      embedding: { maxInputTokens: -3, maxTokens: -3, batchSize: -3, contextLength: -3 },
    });
    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).not.toThrow();
    });
    expect(warnings).toEqual([]);
    const embedding = loadConfig().embedding as Record<string, unknown> | undefined;
    expect(embedding?.maxInputTokens).toBe(-3);
    expect(embedding?.maxTokens).toBe(-3);
    expect(embedding?.batchSize).toBe(-3);
    expect(embedding?.contextLength).toBe(-3);
    const shapeKeys = Object.keys(EmbeddingConnectionConfigSchema.shape);
    expect(shapeKeys).not.toContain("maxInputTokens");
    expect(shapeKeys).not.toContain("maxTokens");
    expect(shapeKeys).not.toContain("batchSize");
    expect(shapeKeys).not.toContain("contextLength");
  });
});

// ── LLM engine config ───────────────────────────────────────────────────────

describe("LLM engine config", () => {
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

  test("loads a file-backed LLM engine apiKeyFile (#905)", () => {
    writeCurrentConfig({
      engines: {
        cloud: {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4",
          apiKeyFile: "/run/secrets/cloud-api-key",
        },
      },
    });
    expect(loadConfig().engines?.cloud?.apiKeyFile).toBe("/run/secrets/cloud-api-key");
    expect(loadConfig().engines?.cloud?.apiKey).toBeUndefined();
  });

  // Neither field is required at the schema level: an engine that sets
  // neither still resolves its credential through the pre-existing implicit
  // `AKM_ENGINE_<NAME>_API_KEY` convention (see engine-resolution.test.ts).
  // apiKeyFile is an alternative to apiKey, not a narrowing of what was
  // already valid.
  test("allows an LLM engine with neither apiKey nor apiKeyFile set (#905)", () => {
    writeCurrentConfig({
      engines: {
        cloud: { kind: "llm", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4" },
      },
    });
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().engines?.cloud?.apiKey).toBeUndefined();
    expect(loadConfig().engines?.cloud?.apiKeyFile).toBeUndefined();
  });

  test("rejects an LLM engine with both apiKey and apiKeyFile set (#905)", () => {
    writeCurrentConfig({
      engines: {
        cloud: {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4",
          apiKey: "$OPENAI_API_KEY",
          apiKeyFile: "/run/secrets/cloud-api-key",
        },
      },
    });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/apiKey and apiKeyFile cannot both be set/);
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

// ── components.*.adapter validation (#909) ───────────────────────────────────

describe("components.*.adapter validation (#909)", () => {
  test("an unrecognized adapter fails INVALID_CONFIG_FILE listing the accepted names", () => {
    writeCurrentConfig({
      bundles: {
        main: {
          path: "/home/user/my-stash",
          writable: true,
          components: { main: { root: ".", adapter: "__invalid__" } },
        },
      },
      defaultBundle: "main",
    });
    // RED on old code: an unknown adapter silently fell back to `akm` at
    // detect-time — loadConfig() never threw, and `akm bundle list` reported
    // "akm" as if it had been configured (#909). GREEN on the fix: config
    // load itself rejects it.
    let thrown: unknown;
    try {
      loadConfig();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).code).toBe("INVALID_CONFIG_FILE");
    const message = (thrown as ConfigError).message;
    expect(message).toContain("__invalid__");
    // The accepted names are listed, derived from the registry — spot-check a
    // representative few rather than pinning the whole (registry-owned) list.
    expect(message).toContain("akm");
    expect(message).toContain("agent-skills");
    expect(message).toContain("okf");
  });

  test("a valid adapter name loads without error", () => {
    writeCurrentConfig({
      bundles: {
        main: {
          path: "/home/user/my-stash",
          writable: true,
          components: { main: { root: ".", adapter: "agent-skills" } },
        },
      },
      defaultBundle: "main",
    });
    const config = loadConfig();
    expect(config.bundles?.main?.components?.main?.adapter).toBe("agent-skills");
  });
});

// ── primary stash (defaultBundle) config ─────────────────────────────────────

describe("primary stash config", () => {
  test("resolves the primary stash from the defaultBundle path", () => {
    writeCurrentConfig({
      bundles: { main: { path: "/home/user/my-stash", writable: true } },
      defaultBundle: "main",
    });
    expect(primaryBundlePath(loadConfig())).toBe("/home/user/my-stash");
  });

  test("resolves the primary stash from the default bundle's component root", () => {
    writeCurrentConfig({
      bundles: {
        main: {
          path: "/home/user/package",
          writable: true,
          components: { main: { root: "catalog", adapter: "akm" } },
        },
      },
      defaultBundle: "main",
    });
    expect(primaryBundlePath(loadConfig())).toBe("/home/user/package/catalog");
  });

  test("primary stash is undefined by default", () => {
    expect(primaryBundlePath(loadConfig())).toBeUndefined();
  });

  test("roundtrips the primary bundle via updateConfig", () => {
    updateConfig({ bundles: { main: { path: "/custom/stash", writable: true } }, defaultBundle: "main" });
    expect(primaryBundlePath(loadConfig())).toBe("/custom/stash");
  });
});

// ── search config ────────────────────────────────────────────────────────────

describe("search config", () => {
  test("loads search.graphBoost values", () => {
    writeCurrentConfig({
      search: {
        graphBoost: {
          directBoostPerEntity: 0.2,
          directBoostCap: 0.6,
          hopBoostPerEntity: 0.08,
          hopBoostCap: 0.24,
          maxHops: 2,
          confidenceMode: "blend",
          confidenceWeight: 0.4,
        },
      },
    });

    expect(loadConfig().search).toEqual({
      graphBoost: {
        directBoostPerEntity: 0.2,
        directBoostCap: 0.6,
        hopBoostPerEntity: 0.08,
        hopBoostCap: 0.24,
        maxHops: 2,
        confidenceMode: "blend",
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

  test("ignores legacy features.improve instead of failing config load", () => {
    writeCurrentConfig({
      features: {
        improve: {
          reflect: { mode: "llm", profile: "openai-mini", timeoutMs: 60000 },
          memory_consolidation: false,
          feedback_distillation: true,
        },
      },
    });
    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).not.toThrow();
    });
    expect(warnings.some((w) => w.includes("features") && w.includes("retired"))).toBe(true);
  });

  test("loads a literal engine apiKey, warning instead of failing", () => {
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
    const warnings = captureWarnings(() => {
      const config = loadConfig();
      expect(config.engines?.cloud?.apiKey).toBe("sk-secret");
    });
    expect(warnings.some((w) => w.includes("engines.<name>.apiKey"))).toBe(true);
  });
});

// ── `extends` inheritance (#945) ────────────────────────────────────────────

describe("extends inheritance (#945)", () => {
  test("merges a base config from a relative path, local wins", () => {
    const dir = path.dirname(getConfigPath());
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
    writeRawConfig(
      path.join(dir, "shared", "shared.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          fast: { kind: "llm", endpoint: "https://api.example.test/v1/chat/completions", model: "base-model" },
        },
        output: { format: "text", detail: "full" },
      }),
    );
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
        extends: "./shared/shared.json",
        output: { detail: "brief" },
      }),
    );

    const config = loadConfig();
    expect(config.engines?.fast?.model).toBe("base-model");
    // Local wins: output.detail overridden, output.format inherited.
    expect(config.output).toEqual({ format: "text", detail: "brief" });
  });

  test("expands ~ in a filesystem extends path", () => {
    const home = mockHomedir();
    try {
      fs.mkdirSync(path.join(home.dir, "fleet"), { recursive: true });
      fs.writeFileSync(
        path.join(home.dir, "fleet", "shared.json"),
        JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "auto" }),
      );
      writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "~/fleet/shared.json" }));

      expect(loadConfig().semanticSearchMode).toBe("auto");
    } finally {
      home.cleanup();
    }
  });

  test("supports a chain (A extends B extends C)", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(path.join(dir, "c.json"), JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 30 }));
    writeRawConfig(
      path.join(dir, "b.json"),
      JSON.stringify({ configVersion: "0.9.0", extends: "./c.json", semanticSearchMode: "auto" }),
    );
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./b.json" }));

    const config = loadConfig();
    expect(config.archiveRetentionDays).toBe(30);
    expect(config.semanticSearchMode).toBe("auto");
  });

  test("throws ConfigError on a two-hop cycle", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(path.join(dir, "b.json"), JSON.stringify({ configVersion: "0.9.0", extends: getConfigPath() }));
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: path.join(dir, "b.json") }));

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/cycle/i);
  });

  test("throws ConfigError when extends resolves to a self-loop", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: getConfigPath() }));
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/cycle/i);
  });

  test("throws ConfigError on a missing extends file, naming the ref", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./does-not-exist.json" }));
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/does-not-exist\.json/);
  });

  test("throws ConfigError when extends is not a non-empty string", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "" }));
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("the base config runs through its own independent version-shim pass", () => {
    // The synthetic "0.0.1" -> "0.9.0" shim moves a root `defaultEngine` under
    // `defaults.llmEngine` (config-version-shim.ts). Writing the BASE at that
    // old version proves the base gets its own shim pass, independent of the
    // (current-version) local file that extends it.
    const dir = path.dirname(getConfigPath());
    writeRawConfig(
      path.join(dir, "old-base.json"),
      JSON.stringify({
        configVersion: "0.0.1",
        defaultEngine: "legacy",
        engines: { legacy: { kind: "llm", endpoint: "https://api.example.test/v1/chat/completions", model: "m" } },
      }),
    );
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./old-base.json" }));

    const config = loadConfig();
    expect(config.defaults?.llmEngine).toBe("legacy");
    expect((config as unknown as Record<string, unknown>).defaultEngine).toBeUndefined();
  });

  test("extends by a filesystem bundle asset ref (bundle//<path>), no index involved", () => {
    const fleetDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(fleetDir, "config"), { recursive: true });
      fs.writeFileSync(
        path.join(fleetDir, "config", "shared.json"),
        JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 14 }),
      );
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          configVersion: "0.9.0",
          bundles: { fleet: { path: fleetDir } },
          extends: "fleet//config/shared.json",
        }),
      );

      const config = loadConfig();
      expect(config.archiveRetentionDays).toBe(14);
    } finally {
      cleanup(fleetDir);
    }
  });

  test("extends bundle ref against a non-filesystem bundle is a ConfigError naming the bundle", () => {
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
        bundles: { fleet: { git: "https://example.test/fleet.git" } },
        extends: "fleet//config/shared.json",
      }),
    );
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/fleet/);
  });

  test("rejects an absolute path after bundle//", () => {
    const fleetDir = makeTmpDir();
    try {
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          configVersion: "0.9.0",
          bundles: { fleet: { path: fleetDir } },
          extends: "fleet///etc/passwd",
        }),
      );
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/absolute/);
    } finally {
      cleanup(fleetDir);
    }
  });

  test("rejects a bundle//<path> that escapes the bundle's content root", () => {
    const fleetDir = makeTmpDir();
    try {
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          configVersion: "0.9.0",
          bundles: { fleet: { path: path.join(fleetDir, "content") } },
          extends: "fleet//../outside.json",
        }),
      );
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/escapes/);
    } finally {
      cleanup(fleetDir);
    }
  });

  test("config get extends returns the locally configured ref (not silently dropped)", () => {
    // Deliberate deviation from a literal "strip extends before validation"
    // reading: `mutateConfig` (config set/unset) reads the EFFECTIVE config as
    // `current` and writes a mutated copy of the SAME object back to the local
    // file (pre-existing behavior — see DEFAULT_CONFIG baking into config.json
    // on any write). Stripping `extends` from the effective object would mean
    // any `config set` after adopting `extends` silently deletes the
    // directive from disk. Keeping it lets it round-trip.
    const dir = path.dirname(getConfigPath());
    writeRawConfig(path.join(dir, "base.json"), JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 7 }));
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./base.json" }));

    const config = loadConfig();
    expect(config.archiveRetentionDays).toBe(7);
    expect((config as unknown as Record<string, unknown>).extends).toBe("./base.json");
  });

  test("config set on an unrelated key after adopting extends does not duplicate the base's fields into the local file", () => {
    // Round-1 review finding: mutateConfig used to write the entire
    // extends-merged EFFECTIVE config back to the local file on any
    // `config set`/`unset`, baking every inherited field (engines,
    // improve.strategies, ...) into the local file on the very next
    // ordinary write — defeating the whole point of `extends`.
    const dir = path.dirname(getConfigPath());
    writeRawConfig(
      path.join(dir, "base.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          fast: { kind: "llm", endpoint: "https://api.example.test/v1/chat/completions", model: "base-model" },
        },
        improve: { strategies: { nightly: { engine: "fast" } } },
        archiveRetentionDays: 30,
      }),
    );
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./base.json" }));

    // `akm config set output.detail full` — an unrelated key. `updateConfig`
    // goes through `mutateConfig` the same way `config set`'s CLI handler does.
    updateConfig({ output: { detail: "full" } });

    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(raw.extends).toBe("./base.json");
    expect(raw.output).toEqual({ detail: "full" });
    // The base's fields must NOT have been duplicated into the local file.
    expect(raw.engines).toBeUndefined();
    expect(raw.improve).toBeUndefined();
    expect(raw.archiveRetentionDays).toBeUndefined();

    // The effective (loaded) config is unaffected: still inherited.
    const config = loadConfig();
    expect(config.engines?.fast?.model).toBe("base-model");
    expect(config.archiveRetentionDays).toBe(30);
    expect(config.output).toEqual({ format: "json", detail: "full" });
  });
});

describe("getConfigValueSource (#945)", () => {
  test("reports 'default' when no config.json exists", () => {
    expect(getConfigValueSource("semanticSearchMode")).toBe("default");
  });

  test("reports 'local' for a key set in the local file", () => {
    writeCurrentConfig({ semanticSearchMode: "auto" });
    expect(getConfigValueSource("semanticSearchMode")).toBe("local");
  });

  test("reports 'extends:<ref>' for a key that only the base sets", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(path.join(dir, "base.json"), JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 30 }));
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./base.json" }));

    expect(getConfigValueSource("archiveRetentionDays")).toBe("extends:./base.json");
  });

  test("reports 'default' for a key neither the local file nor any base sets", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0" }));
    expect(getConfigValueSource("archiveRetentionDays")).toBe("default");
  });

  test("prefers 'local' over an inherited value for the same key", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(path.join(dir, "base.json"), JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 30 }));
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({ configVersion: "0.9.0", extends: "./base.json", archiveRetentionDays: 5 }),
    );

    expect(getConfigValueSource("archiveRetentionDays")).toBe("local");
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
