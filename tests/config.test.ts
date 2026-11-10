import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setConfigValue } from "../src/commands/config";
import { resolveImproveExecution } from "../src/commands/improve/execution";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { resolveQualityGateJudge } from "../src/commands/improve/stage";
import { stripJsonComments } from "../src/core/common";
import {
  DEFAULT_CONFIG,
  defaultConnection,
  defaultHarness,
  getConfigValueSource,
  getImproveProcessConfig,
  type ImproveProfileConfig,
  loadConfig,
  loadUserConfig,
  mutateConfig,
  parseAndValidateConfigText,
  primaryBundlePath,
  resetConfigCache,
  saveConfig,
  unknownConfigKeyPaths,
  updateConfig,
} from "../src/core/config/config";
import { backupExistingConfig, copyToConfigBackups } from "../src/core/config/config-io";
import {
  AkmConfigSchema,
  EmbeddingConnectionConfigSchema,
  ImproveProcessConfigSchema,
  ImproveProfileConfigSchema,
  validateConfigShape,
} from "../src/core/config/config-schema";
import { isImproveAutonomyEnabled } from "../src/core/config/experimental";
import { ConfigError } from "../src/core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../src/core/extra-params";
import { getCacheDir, getConfigDir, getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";
import { schedulerEnabledRefs } from "../src/tasks/activation-config";
import {
  type Cleanup,
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
  writeRawConfig(getConfigPath(), JSON.stringify({ ...value }));
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

const LAB = { endpoint: "http://lab:1/v1", models: { fast: "m" } };

describe("getConfigPath", () => {
  test("returns config.json under XDG_CONFIG_HOME", () => {
    expect(getConfigPath()).toBe(path.join(testConfigHome, "akm", "config.json"));
  });

  test("defaults to ~/.config/akm when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
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

  test("an embedding block with no semanticSearchMode reads as 'auto': writing it says semantic search is wanted", () => {
    writeCurrentConfig({
      connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "qwen3-8b" } } },
      embedding: { model: "nomic-embed-text" },
    });
    expect(loadConfig().semanticSearchMode).toBe("auto");
  });

  test("an embedding block does not override a semanticSearchMode the config sets", () => {
    writeCurrentConfig({ semanticSearchMode: "off", embedding: { model: "nomic-embed-text" } });
    expect(loadConfig().semanticSearchMode).toBe("off");
  });

  test("without an embedding block the mode stays 'off'", () => {
    writeCurrentConfig({ connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "m" } } } });
    expect(loadConfig().semanticSearchMode).toBe("off");
  });

  test("loads config without a working bundle", () => {
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

  test("warns when an unknown top-level key has no defined behavior", () => {
    writeCurrentConfig({ defualtBundle: "typo" });
    const warnings = captureWarnings(() => loadConfig());
    expect(warnings.join("\n")).toMatch(/unknown config key.*defualtBundle/i);
  });

  test("warns that an execution section is an unknown key", () => {
    writeCurrentConfig({ execution: { allowedTools: ["Read"] } });
    const warnings = captureWarnings(() => loadConfig());
    expect(warnings.join("\n")).toMatch(/unknown config key.*execution/i);
  });

  test("a plugins section (the akm plugins' settings) loads with no warning, whatever its inner values", () => {
    writeCurrentConfig({ plugins: { curateLimit: 8, redact: { pii: true }, autoFeedback: "bad", extra: [1] } });
    let loaded: ReturnType<typeof loadConfig> | undefined;
    const warnings = captureWarnings(() => {
      loaded = loadConfig();
    });
    expect(warnings.filter((w) => /plugins/i.test(w))).toEqual([]);
    expect((loaded as unknown as { plugins?: Record<string, unknown> }).plugins).toEqual({
      curateLimit: 8,
      redact: { pii: true },
      autoFeedback: "bad",
      extra: [1],
    });
  });

  test("akm config set writes a plugins key and keeps the rest of the section", () => {
    const base = { plugins: { autoFeedback: false } } as never;
    const next = setConfigValue(base, "plugins.curateLimit", "8") as unknown as { plugins: Record<string, unknown> };
    expect(next.plugins.autoFeedback).toBe(false);
    expect(next.plugins.curateLimit).toBeDefined();
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

  // Older than the 0.9.32 floor: 0.10 does not convert these, it refuses them
  // with one message naming the 0.9.32 recipe (#1091).
  test.each([
    ["sources", [{ type: "filesystem", path: "/keep", name: "keep" }]],
    ["installed", [{ id: "npm:left-pad", source: "npm", ref: "npm:left-pad" }]],
    ["stashDir", "/legacy-stash"],
  ])("refuses the pre-0.9 `%s` key, naming akm migrate apply under akm 0.9.x", (key, value) => {
    writeRawConfig(getConfigPath(), JSON.stringify({ [key]: value }));

    expect(() => loadConfig()).toThrow(
      new RegExp(`${key}: .*predates akm 0\\.9\\.32.*akm-cli@0\\.9\\.32 && akm migrate apply`),
    );
  });
});

// ── saveConfig ──────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("writes formatted JSON to config.json", () => {
    const config = {
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

  test("any file copied to the config backups is named by its caller and de-collides the same way", () => {
    const source = path.join(getConfigDir(), "credentials.json");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "{}\n");
    const instant = new Date("2026-07-11T12:34:56.789Z");
    const name = (stamp: string) => `credentials.json.${stamp}`;

    const first = copyToConfigBackups(source, name, instant);
    const second = copyToConfigBackups(source, name, instant);

    expect([first, second].map((copy) => path.basename(copy))).toEqual([
      "credentials.json.2026-07-11T12-34-56-789Z",
      "credentials.json.2026-07-11T12-34-56-789Z-1",
    ]);
    expect(path.dirname(first)).toBe(path.join(getCacheDir(), "config-backups"));
    expect(fs.statSync(second).mode & 0o777).toBe(0o600);
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

  test("config saves still work on a filesystem that refuses chmod (CIFS / Azure Files)", () => {
    const refuse = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
    };
    spyOn(fs, "chmodSync").mockImplementation(refuse);
    spyOn(fs, "fchmodSync").mockImplementation(refuse);

    saveConfig({ semanticSearchMode: "off" });
    saveConfig({ semanticSearchMode: "auto" });

    expect(loadConfig().semanticSearchMode).toBe("auto");
    expect(fs.existsSync(path.join(getCacheDir(), "config-backups", "config.latest.json"))).toBe(true);
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

  test("ignores the retired `embedding.chunkSize` key with one warning and no error (#954)", () => {
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
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unknown config key "embedding\.chunkSize"/i);
    expect(loadConfig().embedding?.chunkSize).toBe(-3);
    expect(Object.keys(EmbeddingConnectionConfigSchema.shape)).not.toContain("chunkSize");
  });
});

// ── Connections ──────────────────────────────────────────────────────────────

describe("connections", () => {
  test("loads a $VAR apiKey", () => {
    writeCurrentConfig({
      connections: {
        cloud: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4" }, apiKey: "$OPENAI_API_KEY" },
      },
    });
    expect(loadConfig().connections?.cloud?.apiKey).toBe("$OPENAI_API_KEY");
  });

  test("a literal apiKey is warned about once, kept as written and never read, never a load error", () => {
    writeCurrentConfig({
      connections: { cloud: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4" }, apiKey: "sk-secret" } },
    });
    const warnings = captureWarnings(() => {
      expect(loadConfig().connections?.cloud?.apiKey).toBe("sk-secret");
      resetConfigCache();
      loadConfig();
    });
    const literal = warnings.filter((w) => w.includes("literal apiKey") && w.includes("credentials.json"));
    expect(literal).toHaveLength(1);
    expect(literal.join("\n")).not.toContain("sk-secret");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secret reference syntax under test
  test("a ${secrets/...} reference is not a key akm reads: kept, with a notice that names akm migrate apply", () => {
    writeCurrentConfig({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secret reference under test
      connections: { cloud: { endpoint: "https://x.test/v1", models: { fast: "m" }, apiKey: "${secrets/openai}" } },
    });
    const warnings = captureWarnings(() => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secret reference under test
      expect(loadConfig().connections?.cloud?.apiKey).toBe("${secrets/openai}");
    });
    const notices = warnings.filter((w) => w.includes("secret-store reference"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("akm migrate apply");
    expect(warnings.some((w) => w.includes("literal apiKey"))).toBe(false);
  });

  test("allows a connection with no apiKey (the key may live in credentials.json)", () => {
    writeCurrentConfig({
      connections: { cloud: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4" } } },
    });
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().connections?.cloud?.apiKey).toBeUndefined();
  });

  test("a connection with no endpoint is dropped with one warning; the connections beside it load", () => {
    writeCurrentConfig({
      connections: {
        cloud: { models: { fast: "gpt-4" } },
        lab: LAB,
      },
    });
    const warnings = captureWarnings(() => {
      expect(Object.keys(loadConfig().connections ?? {})).toEqual(["lab"]);
      resetConfigCache();
      loadConfig();
    });
    const dropped = warnings.filter((w) => w.includes('connection "cloud"'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("endpoint");
  });

  test("setting a field on a connection the reader dropped adds to what the file has, never replaces it", () => {
    const dropped = { models: { fast: "gpt-4" }, top_p: 0.9 };
    writeCurrentConfig({ connections: { lab: dropped, other: LAB } });
    captureWarnings(() => {
      mutateConfig((current) => setConfigValue(current, "connections.lab.endpoint", "http://lab:8080/v1"));
    });
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { connections: Record<string, unknown> };
    expect(written.connections.lab).toEqual({ ...dropped, endpoint: "http://lab:8080/v1" });
    expect(written.connections.other).toEqual(LAB);
    resetConfigCache();
    expect(loadConfig().connections?.lab).toMatchObject({ endpoint: "http://lab:8080/v1", models: { fast: "gpt-4" } });
  });

  test("setting the platform on a harness the reader dropped keeps its bin and args", () => {
    writeCurrentConfig({ harnesses: { work: { bin: "/opt/claude", args: ["--print"] } } });
    captureWarnings(() => {
      mutateConfig((current) => setConfigValue(current, "harnesses.work.platform", "claude"));
    });
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { harnesses: Record<string, unknown> };
    expect(written.harnesses.work).toEqual({ bin: "/opt/claude", args: ["--print"], platform: "claude" });
    resetConfigCache();
    expect(loadConfig().harnesses?.work).toMatchObject({ platform: "claude", bin: "/opt/claude", args: ["--print"] });
  });

  test.each([
    ["an endpoint without a scheme", { connections: { typo: { endpoint: "localhost:11434/v1" }, lab: LAB } }, "typo"],
    [
      "a model that is not a name",
      { connections: { typo: { endpoint: "http://x/v1", models: { fast: 3 } }, lab: LAB } },
      "typo",
    ],
    [
      "a harness entry that is not an object",
      { connections: { lab: LAB }, harnesses: { claude: true, codex: {} } },
      "claude",
    ],
    [
      "harness args that are not a list",
      { connections: { lab: LAB }, harnesses: { claude: { args: "--x" }, codex: {} } },
      "claude",
    ],
    ["a connection name outside the naming rule", { connections: { "My Lab": LAB, lab: LAB } }, "My Lab"],
    ["a connection name with a reserved prefix", { connections: { "akm-lab": LAB, lab: LAB } }, "akm-lab"],
    [
      "a harness name outside the naming rule",
      { connections: { lab: LAB }, harnesses: { Claude_Work: { platform: "claude" }, codex: {} } },
      "Claude_Work",
    ],
  ])("%s is dropped with one warning naming it; the rest loads", (_name, config, dropped) => {
    writeCurrentConfig(config);
    let loaded!: ReturnType<typeof loadConfig>;
    const warnings = captureWarnings(() => {
      loaded = loadConfig();
      resetConfigCache();
      loadConfig();
    });
    expect(warnings.filter((w) => w.includes(`"${dropped}"`) && w.startsWith("Ignoring"))).toHaveLength(1);
    expect(Object.keys(loaded.connections ?? {})).not.toContain(dropped);
    expect(Object.keys(loaded.harnesses ?? {})).not.toContain(dropped);
    expect(Object.keys(loaded.connections ?? {})).toContain("lab");
  });

  test("keeps request fields on the connection and on a model entry as written, without warning", () => {
    writeCurrentConfig({
      connections: {
        lab: {
          endpoint: "http://lab:8080/v1",
          timeoutMs: 900000,
          chat_template_kwargs: { enable_thinking: false },
          models: {
            fast: "qwen3-8b",
            reasoning: { model: "glm-5", reasoning_effort: "high", chat_template_kwargs: { thinking_budget: 8192 } },
          },
        },
      },
    });
    const warnings = captureWarnings(() => {
      expect(loadConfig().connections?.lab).toMatchObject({
        timeoutMs: 900000,
        chat_template_kwargs: { enable_thinking: false },
        models: { reasoning: { model: "glm-5", reasoning_effort: "high" } },
      });
    });
    expect(warnings).toEqual([]);
  });

  test("roundtrips a connection via updateConfig", () => {
    const connection = { endpoint: "http://localhost:11434/v1", models: { fast: "llama3.2" } };
    updateConfig({ connections: { local: connection } });
    expect(loadConfig().connections?.local).toMatchObject(connection);
  });
});

// ── getImproveProcessConfig accessor ─────────────────────────────────────────

// The accessor only reads the strategy already selected by the caller. It does
// not re-resolve defaults or fall back to another strategy.
describe("getImproveProcessConfig", () => {
  test("returns the named process section from the selected improve strategy", () => {
    const selected = { processes: { consolidate: { enabled: true, limit: 42 } } };
    expect(getImproveProcessConfig("consolidate", selected)).toEqual({
      enabled: true,
      limit: 42,
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

  test("rejects a disabled default bundle", () => {
    writeCurrentConfig({
      bundles: { off: { path: "/custom/stash", enabled: false } },
      defaultBundle: "off",
    });
    expect(() => loadConfig()).toThrow(/defaultBundle.*disabled/i);
  });

  test("rejects two bundle ids that alias one physical directory through a symlink", () => {
    const root = makeTmpDir();
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, "dir");
    try {
      writeCurrentConfig({ bundles: { first: { path: real }, second: { path: alias } }, defaultBundle: "first" });
      expect(() => loadConfig()).toThrow(/same physical content root/i);
    } finally {
      cleanup(root);
    }
  });
});

// ── search config ────────────────────────────────────────────────────────────

describe("search config", () => {
  test("loads search.defaultExcludeTypes", () => {
    writeCurrentConfig({ search: { defaultExcludeTypes: ["session", "memory"] } });
    expect(loadConfig().search).toEqual({ defaultExcludeTypes: ["session", "memory"] });
  });

  test("an older config with the removed search.curateRerank warns once, keeps loading, and enables nothing", () => {
    writeCurrentConfig({ search: { curateRerank: { enabled: true, endpoint: "http://r/rerank", topN: 30 } } });
    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).not.toThrow();
    });
    expect(warnings.join("\n")).toMatch(/unknown config key.*search\.curateRerank.*ignored/i);
  });

  test("tolerates the retired search.minScore and search.graphBoost keys (lenient unknown-key policy)", () => {
    // Search ranking no longer reads either key. A config an older release
    // wrote must still load, keeping the values in memory rather than failing.
    writeCurrentConfig({ search: { minScore: 0.15, graphBoost: { maxHops: 99, confidenceWeight: 99 } } });
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().search).toEqual({ minScore: 0.15, graphBoost: { maxHops: 99, confidenceWeight: 99 } });
  });
});

describe("embedding profile config", () => {
  test("loads embedding.queryTemplate, documentTemplate and queryTimeoutMs", () => {
    writeCurrentConfig({
      embedding: {
        localModel: "Xenova/bge-small-en-v1.5",
        queryTemplate: "",
        documentTemplate: "doc: {text}",
        queryTimeoutMs: 800,
      },
    });
    expect(loadConfig().embedding).toMatchObject({
      queryTemplate: "",
      documentTemplate: "doc: {text}",
      queryTimeoutMs: 800,
    });
  });

  test("rejects a non-positive embedding.queryTimeoutMs", () => {
    writeCurrentConfig({ embedding: { localModel: "Xenova/bge-small-en-v1.5", queryTimeoutMs: 0 } });
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe("0.9 config shape parsing", () => {
  test("parses harnesses by platform name, with platform for a second install", () => {
    writeCurrentConfig({
      harnesses: {
        opencode: { bin: "opencode", args: ["run"] },
        "claude-work": {
          platform: "claude",
          bin: "/opt/claude-work/bin/claude",
          workspace: "/tmp",
          models: { fast: "m" },
        },
      },
    });
    const loaded = loadConfig();
    expect(loaded.harnesses?.opencode?.args).toEqual(["run"]);
    expect(loaded.harnesses?.["claude-work"]?.platform).toBe("claude");
    expect(loaded.harnesses?.["claude-work"]?.models).toEqual({ fast: "m" });
  });

  test("a harness with an unknown platform, or named for none, is dropped with one warning; the rest loads", () => {
    writeCurrentConfig({ harnesses: { bad: { platform: "invalid-platform" }, claude: {} } });
    const unknownPlatform = captureWarnings(() => {
      expect(Object.keys(loadConfig().harnesses ?? {})).toEqual(["claude"]);
    });
    expect(unknownPlatform.filter((w) => w.includes('harness "bad"') && w.includes("invalid-platform"))).toHaveLength(
      1,
    );

    writeCurrentConfig({ harnesses: { cursor: {}, codex: {} }, connections: { lab: LAB } });
    const unnamed = captureWarnings(() => {
      const loaded = loadConfig();
      expect(Object.keys(loaded.harnesses ?? {})).toEqual(["codex"]);
      expect(Object.keys(loaded.connections ?? {})).toEqual(["lab"]);
    });
    expect(unnamed.filter((w) => w.includes('harness "cursor"') && w.includes("is not a platform name"))).toHaveLength(
      1,
    );
  });

  test("opencode-sdk is akm's own runtime, not a platform a harness can name: dropped, with a warning", () => {
    writeCurrentConfig({ harnesses: { runtime: { platform: "opencode-sdk" } } });
    const warnings = captureWarnings(() => {
      expect(loadConfig().harnesses).toEqual({});
    });
    expect(warnings.some((w) => w.includes('harness "runtime"') && w.includes("opencode-sdk"))).toBe(true);
  });

  test("an entry that is dropped stays in the file through a write", () => {
    writeCurrentConfig({ harnesses: { cursor: {}, claude: {} }, connections: { cloud: { models: { fast: "m" } } } });
    captureWarnings(() => {
      mutateConfig((current) => ({ ...current, output: { format: "text" } }));
    });
    const after = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(after.harnesses).toEqual({ cursor: {}, claude: {} });
    expect(after.connections).toEqual({ cloud: { models: { fast: "m" } } });
  });

  test("a harness alias written as a model object, as on a connection, keeps the harness usable", () => {
    writeCurrentConfig({ harnesses: { claude: { models: { reasoning: { model: "opus", effort: "high" } } } } });
    const warnings = captureWarnings(() => {
      expect(loadConfig().harnesses?.claude?.models).toEqual({ reasoning: { model: "opus", effort: "high" } });
    });
    expect(warnings).toEqual([]);
  });

  test("a key a harness does not read warns once and is ignored", () => {
    writeCurrentConfig({ harnesses: { claude: { colour: "blue" } } });
    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).not.toThrow();
    });
    expect(warnings.some((w) => w.includes("harnesses.claude.colour") && w.includes("ignored"))).toBe(true);
  });

  test("parses the default connection, default harness and improve strategy by name", () => {
    writeCurrentConfig({
      connections: {
        default: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4o-mini" } },
        other: { endpoint: "https://other.test/v1", models: { fast: "m" } },
      },
      harnesses: { opencode: {}, claude: {} },
      improve: { strategy: "my-custom-strategy", strategies: { "my-custom-strategy": {} } },
    });
    const loaded = loadConfig();
    expect(defaultConnection(loaded)?.name).toBe("default");
    expect(defaultHarness(loaded)).toBeUndefined();
    expect(loaded.improve?.strategy).toBe("my-custom-strategy");
  });

  // A pointer to a connection or harness is a plain string, so the config loads with a miscased or unknown name in
  // it. Where it is resolved it is an error that names it, never the default. Only the entry's own name is held to
  // the naming rule.
  test.each([
    ["improve.connection", { improve: { connection: "Anthropic" } }, "improve"],
    ["improve.harness", { improve: { harness: "Anthropic" } }, "improve"],
    [
      "improve.processes.<process>.connection",
      { improve: { processes: { triage: { connection: "Anthropic" } } } },
      "improve",
    ],
    [
      "improve.processes.<process>.harness",
      { improve: { processes: { triage: { harness: "Anthropic" } } } },
      "improve",
    ],
    ["improve.qualityGate.connection", { improve: { qualityGate: { connection: "Anthropic" } } }, "gate"],
  ])("a miscased name at %s loads, and is an error at resolution naming it", (_where, pointer, resolves) => {
    writeCurrentConfig({
      connections: { default: { endpoint: "http://lab:1/v1", models: { fast: "m" } } },
      ...pointer,
    });
    const loaded = loadConfig();
    const resolution = {
      improve: () => resolveImproveExecution({ config: loaded, processName: "triage", alias: "fast" }),
      gate: () =>
        resolveImproveExecution({
          config: loaded,
          processName: "reflect-quality-judge",
          alias: "fast",
          ...(loaded.improve?.qualityGate ? { current: loaded.improve.qualityGate } : {}),
        }),
    }[resolves as "improve" | "gate"];
    expect(resolution).toThrow(/"Anthropic" is not configured/);
  });

  test("the lone connection, and the lone harness, are the defaults whatever they are called", () => {
    writeCurrentConfig({
      connections: { lab: { endpoint: "http://lab/v1", models: { fast: "m" } } },
      harnesses: { claude: {} },
    });
    const loaded = loadConfig();
    expect(defaultConnection(loaded)?.name).toBe("lab");
    expect(defaultHarness(loaded)?.name).toBe("claude");
  });

  test("improve.strategy: graph-refresh loads (retirement is refused lazily by resolveImproveStrategy, not eagerly at config load)", () => {
    // Eagerly refusing this here would fail every command's config load,
    // including `akm migrate apply` — the one command that would let an
    // owner fix a stale default. resolveImproveStrategy
    // (src/commands/improve/improve-strategies.ts) is the one place that
    // refuses "graph-refresh", at improve-invocation time.
    writeCurrentConfig({ improve: { strategy: "graph-refresh" } });
    expect(loadConfig().improve?.strategy).toBe("graph-refresh");
  });

  test("improve.strategy: proactive-maintenance (a built-in until 0.10) still loads, with or without a strategy block (#1129)", () => {
    writeCurrentConfig({ improve: { strategy: "proactive-maintenance" } });
    expect(loadConfig().improve?.strategy).toBe("proactive-maintenance");
    writeCurrentConfig({
      improve: {
        strategy: "proactive-maintenance",
        strategies: {
          "proactive-maintenance": { processes: { proactiveMaintenance: { enabled: true, maxPerRun: 100 } } },
        },
      },
    });
    const loaded = loadConfig();
    expect(loaded.improve?.strategies?.["proactive-maintenance"]?.processes?.proactiveMaintenance?.maxPerRun).toBe(100);
  });

  test("improve.strategy must name a built-in or configured strategy", () => {
    writeCurrentConfig({ improve: { strategy: "nonexistent" } });
    expect(() => loadConfig()).toThrow(/improve\.strategy/);
  });

  test("a leftover improve.salience.salienceThreshold (the removed high-salience lane's key) still loads (#1129)", () => {
    writeCurrentConfig({ improve: { salience: { salienceThreshold: 0.5 } } });
    expect(() => loadConfig()).not.toThrow();
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
});

// ── `extends` is retired ─────────────────────────────────────────────────────

describe("a config that still sets extends", () => {
  test("is refused, naming `akm migrate apply`", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(path.join(dir, "base.json"), JSON.stringify({ archiveRetentionDays: 7 }));
    writeRawConfig(getConfigPath(), JSON.stringify({ extends: "./base.json" }));

    expect(() => loadConfig()).toThrow(/"extends" is no longer supported.*akm migrate apply/s);
  });

  test("is refused even when the base does not exist", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ extends: "./does-not-exist.json" }));

    expect(() => loadConfig()).toThrow(/akm migrate apply/);
  });

  test("is refused by a write too, and the file is not changed", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({ extends: "./base.json" }));
    const before = fs.readFileSync(getConfigPath(), "utf8");

    expect(() => updateConfig({ output: { detail: "full" } })).toThrow(/akm migrate apply/);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });
});

describe("scheduler.enabled", () => {
  test("scheduler.enabled tolerates non-canonical and duplicate entries, including 0.9.17-alpha grant objects", () => {
    writeCurrentConfig({
      scheduler: {
        enabled: [
          { kind: "task", ref: "tasks/nightly", sourceId: `sha256:${"a".repeat(64)}` },
          { kind: "task", ref: "team//tasks/nightly", sourceId: `sha256:${"a".repeat(64)}` },
          "team//tasks/nightly",
        ],
      },
    });

    const warnings = captureWarnings(() => {
      expect(schedulerEnabledRefs(loadConfig())).toEqual(["team//tasks/nightly"]);
    });
    expect(warnings.join("\n")).toMatch(/Ignoring scheduler\.enabled entry "tasks\/nightly"/);
  });
});

describe("getConfigValueSource", () => {
  test("reports 'default' when no config.json exists", () => {
    expect(getConfigValueSource("semanticSearchMode")).toBe("default");
  });

  test("reports 'local' for a key set in the local file", () => {
    writeCurrentConfig({ semanticSearchMode: "auto" });
    expect(getConfigValueSource("semanticSearchMode")).toBe("local");
  });

  test("reports 'default' for a key the local file does not set", () => {
    writeRawConfig(getConfigPath(), JSON.stringify({}));
    expect(getConfigValueSource("archiveRetentionDays")).toBe("default");
  });
});

// #852: an asset's `extraParams` (a workflow unit's `extra_params:`) may not
// shadow a setting akm manages, and the issue names the portable setting to use
// instead. A connection no longer has `extraParams` at all: its request fields
// are written directly and sent as written.

function firstIssue(extraParams: Record<string, unknown>): string {
  const issue = validateExtraParams(extraParams)[0];
  if (!issue) throw new Error("expected extraParams to be refused");
  return formatExtraParamsIssue("extraParams", issue);
}

describe("an extraParams key that shadows a portable setting is refused, naming the setting", () => {
  test.each([
    ["reasoning_effort", "none", "reasoningEffort"],
    ["temperature", 0.2, "temperature"],
    ["maxtokens", 512, "maxTokens"],
    ["enable_thinking", true, "enableThinking"],
  ])("extraParams.%s names %s", (key, value, field) => {
    const message = firstIssue({ [key]: value });
    expect(message).toContain("is protected by AKM");
    expect(message).toContain(`set ${field} instead`);
  });

  test("a protected key with no portable equivalent is refused, and the error names the remedy", () => {
    const message = firstIssue({ stream: true });
    expect(message).toContain("stream is protected by AKM");
    expect(message).toContain("AKM controls streaming internally");
  });

  test("credential-shaped keys are refused at any depth, inside arrays too", () => {
    expect(validateExtraParams({ nested: { "API-Key": "leak" } })).toHaveLength(1);
    expect(validateExtraParams({ provider: [{ auth: [{ API_KEY: "leak" }] }] })).toHaveLength(1);
  });

  test("chat_template_kwargs is the enableThinking setting's to send", () => {
    expect(firstIssue({ chat_template_kwargs: { enable_thinking: true } })).toContain("set enableThinking instead");
  });
});

/**
 * D8 — the `experimental.improveAutonomy` opt-in key.
 *
 * Before D8 this key was documented but did not exist: it was absent from the
 * schema, read nowhere in the runtime, and `akm config set
 * experimental.improveAutonomy true` failed with `Unknown config key`. The
 * documentation therefore inverted the safety posture — an operator could read
 * that autonomy required an opt-in, never set the key, and conclude they were
 * review-first while consolidate was deleting files.
 *
 * These pin the key's existence and its default. The gating behaviour itself is
 * pinned by `tests/integration/improve-autonomy-gate.test.ts`, which asserts on
 * the filesystem rather than on this flag.
 */

const BASE = {};

describe("experimental.improveAutonomy schema", () => {
  test("accepts the key and round-trips true", () => {
    const parsed = AkmConfigSchema.parse({ ...BASE, experimental: { improveAutonomy: true } });
    expect(parsed.experimental?.improveAutonomy).toBe(true);
  });

  test("accepts the key set to false", () => {
    const parsed = AkmConfigSchema.parse({ ...BASE, experimental: { improveAutonomy: false } });
    expect(parsed.experimental?.improveAutonomy).toBe(false);
  });

  test("rejects a non-boolean value rather than coercing it", () => {
    expect(() => AkmConfigSchema.parse({ ...BASE, experimental: { improveAutonomy: "yes" } })).toThrow();
  });

  test("the whole section is optional", () => {
    expect(() => AkmConfigSchema.parse(BASE)).not.toThrow();
  });
});

describe("isImproveAutonomyEnabled", () => {
  test("is OFF when the section is absent — autonomy is opt-in, never inferred", () => {
    expect(isImproveAutonomyEnabled({})).toBe(false);
  });

  test("is OFF when the section exists but the key does not", () => {
    expect(isImproveAutonomyEnabled({ experimental: {} })).toBe(false);
  });

  test("is OFF when explicitly false", () => {
    expect(isImproveAutonomyEnabled({ experimental: { improveAutonomy: false } })).toBe(false);
  });

  test("is ON only when explicitly true", () => {
    expect(isImproveAutonomyEnabled({ experimental: { improveAutonomy: true } })).toBe(true);
  });
});

/** The three example configs the rework is specified by: each is the current form, loads unchanged and validates. */

type Dict = Record<string, unknown>;

describe("the example configs load unchanged and validate", () => {
  const examples = path.join(import.meta.dir, "fixtures", "config-examples");

  test.each(["1-basic", "2-harness", "3-power"])("%s.jsonc", (name) => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, `${name}.jsonc`), "utf8"))) as Dict;
    expect(AkmConfigSchema.safeParse({ semanticSearchMode: "off", ...raw }).success).toBe(true);
    // Every key is one akm reads or a request field.
    expect(unknownConfigKeyPaths({ ...raw })).toEqual([]);
  });

  test.each([
    ["1-basic", "off"],
    ["2-harness", "auto"],
    ["3-power", "auto"],
  ] as const)("%s.jsonc, loaded as written, reads semantic search as %s", (name, mode) => {
    // The examples carry no semanticSearchMode: an `embedding` block alone says semantic search is wanted.
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.copyFileSync(path.join(examples, `${name}.jsonc`), getConfigPath());
    resetConfigCache();
    expect(loadConfig().semanticSearchMode).toBe(mode);
    resetConfigCache();
  });

  test("3-power.jsonc, loaded from a file: triage judges on the anthropic connection's reasoning model, the quality gate on anthropic's balanced one", () => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, "3-power.jsonc"), "utf8"))) as Dict;
    const improve = raw.improve as Dict;
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        ...raw,
        improve: {
          ...improve,
          strategy: "nightly",
          strategies: {
            nightly: { processes: { triage: { enabled: true, judgment: true }, distill: { enabled: true } } },
          },
        },
      }),
    );
    resetConfigCache();
    const config = loadConfig();
    const plan = resolveImprovePlan("nightly", config);
    expect(plan.triageJudgment).toMatchObject({ kind: "connection", name: "anthropic", model: "claude-opus-4-7" });
    expect(plan.processes.distill.runner).toMatchObject({ kind: "connection", name: "default", model: "qwen3-32b" });
    // Nothing names a model for the gate's judge, so it asks for the shipped judge alias: `balanced`.
    expect(resolveQualityGateJudge(config, undefined, "reflect")).toMatchObject({
      kind: "connection",
      name: "anthropic",
      model: "claude-sonnet-4-5",
    });
    resetConfigCache();
  });
});

{
  /**
   * A harness takes no connection or inference of its own: inference for opencode
   * belongs in opencode's own config, and a connection's model alias carries it into
   * model work. A key a harness does not read is warned about once and
   * ignored; it never fails the load.
   */

  function captureWarnings(run: () => void): string[] {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      run();
    } finally {
      _setWarnSinkForTests(undefined);
    }
    return warnings;
  }

  test.each([
    "endpoint",
    "apiKey",
    "temperature",
    "maxTokens",
    "contextLength",
    "reasoning_effort",
  ])("%s is not read by a harness: the load warns once and ignores it", (key) => {
    const text = JSON.stringify({ harnesses: { opencode: { [key]: "x" } } });
    const warnings = captureWarnings(() => {
      expect(() => parseAndValidateConfigText(text)).not.toThrow();
    });
    expect(warnings.filter((w) => w.includes(`harnesses.opencode.${key}`) && w.includes("ignored"))).toHaveLength(1);
  });

  // `agent` names the harness's default native agent, so it needs a platform that can run one.
  describe("a harness's default agent", () => {
    const configWith = (platform: string, agent: string) => ({
      semanticSearchMode: "off" as const,
      harnesses: { h: { platform: platform as "claude", agent } },
    });

    test.each(["opencode", "claude"])("is used on %s", (platform) => {
      const runner = resolveTarget({ config: configWith(platform, "akm-workflow"), layers: [] });
      expect(runner).toMatchObject({ kind: "harness", agent: "akm-workflow" });
    });

    test("is rejected by the schema when empty", () => {
      expect(validateConfigShape(configWith("opencode", "")).ok).toBe(false);
    });

    test("is warned about once and ignored on a harness with no native agent selector", () => {
      const warnings = captureWarnings(() => {
        const runner = resolveTarget({ config: configWith("codex", "x"), layers: [] });
        expect(runner).not.toHaveProperty("agent");
      });
      expect(warnings.some((w) => w.includes('Harness "h"') && w.includes("no native agents"))).toBe(true);
    });
  });

  describe("a harness's models", () => {
    const configWith = (models: unknown) => ({
      semanticSearchMode: "off" as const,
      harnesses: { claude: { models } },
    });

    test("map an alias to a model name", () => {
      expect(validateConfigShape(configWith({ fast: "claude-haiku-4-5" })).ok).toBe(true);
    });

    test("take the model name only: an entry written as a connection's object is read for its model, and needs one", () => {
      expect(validateConfigShape(configWith({ fast: { model: "claude-haiku-4-5", temperature: 0.2 } })).ok).toBe(true);
      expect(validateConfigShape(configWith({ fast: { temperature: 0.2 } })).ok).toBe(false);
    });
  });
}

// Phase 2: triage is a first-class improve process. These guard that a triage
// block under `processes` parses and is accepted, that the triage-specific
// fields validate, and that enabled unknown process keys are rejected by the
// `ImproveProfileProcessesSchema` superRefine.

describe("triage improve-process config schema", () => {
  test("a triage block under processes parses and is accepted", () => {
    const result = ImproveProfileConfigSchema.safeParse({
      processes: {
        reflect: { enabled: true },
        triage: {
          enabled: true,
          applyMode: "queue",
          maxAcceptsPerRun: 25,
          judgment: { connection: "fast", timeoutMs: 600000 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("triage-specific fields validate on ImproveProcessConfigSchema", () => {
    expect(
      ImproveProcessConfigSchema.safeParse({
        enabled: false,
        applyMode: "promote",
        maxAcceptsPerRun: 10,
        judgment: { harness: "agent" },
      }).success,
    ).toBe(true);

    // applyMode is constrained to queue|promote
    expect(ImproveProcessConfigSchema.safeParse({ applyMode: "delete" }).success).toBe(false);
    // maxAcceptsPerRun must be a positive integer
    expect(ImproveProcessConfigSchema.safeParse({ maxAcceptsPerRun: 0 }).success).toBe(false);
    // The retired drain-policy keys are tolerated like any unknown key, never fatal.
    expect(
      ImproveProcessConfigSchema.safeParse({ policy: "personal-stash", maxDiffLines: -1, rejectEmpty: true }).success,
    ).toBe(true);
    // An unknown judgment key is not fatal: the loader warns about it and it changes nothing.
    const withUnknown = ImproveProcessConfigSchema.safeParse({ judgment: { connection: "fast", bogus: 1 } });
    expect(withUnknown.success).toBe(true);
    // judgment.mode is retired in favor of a named connection or harness; like any unknown key it is tolerated, not fatal.
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { mode: "llm" } }).success).toBe(true);
    // judgment.timeoutMs accepts null
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { timeoutMs: null } }).success).toBe(true);
  });

  test("an enabled unknown process is rejected instead of disappearing from the execution plan", () => {
    const enabled = ImproveProfileConfigSchema.safeParse({
      processes: {
        triage: { enabled: true },
        reflecct: { enabled: true, connection: "missing" },
      },
    });
    expect(enabled.success).toBe(false);
    if (enabled.success) throw new Error("fixture must fail validation");
    expect(enabled.error.issues[0]?.path).toEqual(["processes", "reflecct"]);
    expect(enabled.error.issues[0]?.message).toContain("Unknown enabled improve process");

    expect(ImproveProfileConfigSchema.safeParse({ processes: { futureProcess: { enabled: false } } }).success).toBe(
      true,
    );
  });

  // 0.9.17-alpha.9: graphExtraction is a genuinely retired process name (the
  // LLM entity-graph extraction it ran is gone), not a typo — unlike an
  // unrecognized name, it must not fail config loading even when enabled.
  test("an enabled processes.graphExtraction is tolerated, not rejected like an unknown process", () => {
    const result = ImproveProfileConfigSchema.safeParse({
      processes: {
        reflect: { enabled: true },
        graphExtraction: { enabled: true, fullScan: true },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Kept in memory as an ordinary unknown key — nothing reads it any more.
    expect((result.data.processes as Record<string, unknown> | undefined)?.graphExtraction).toEqual({
      enabled: true,
      fullScan: true,
    });
  });

  test("triage may select any connection or harness by name; whether it is configured is resolved when it is used", () => {
    const base = {
      harnesses: { reviewer: { platform: "claude" } },
    } as const;
    for (const selection of [{ harness: "reviewer" }, { connection: "missing" }, { harness: "missing" }]) {
      expect(
        validateConfigShape({
          ...base,
          improve: { strategies: { custom: { processes: { triage: { enabled: true, ...selection, judgment: {} } } } } },
        }).ok,
      ).toBe(true);
    }
  });
});
