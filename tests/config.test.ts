import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { schedulerEnabledRefs } from "../src/tasks/activation-config";
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

const LAB = { endpoint: "http://lab:1/v1", models: { fast: "m" } };

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

  // Older than the 0.9.15 floor: 0.10 does not convert these, it refuses them
  // with one message naming `akm migrate apply` under akm 0.9.x (#1091).
  test.each([
    ["sources", [{ type: "filesystem", path: "/keep", name: "keep" }]],
    ["installed", [{ id: "npm:left-pad", source: "npm", ref: "npm:left-pad" }]],
    ["stashDir", "/legacy-stash"],
  ])("refuses the pre-0.9 `%s` key, naming akm migrate apply under akm 0.9.x", (key, value) => {
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", [key]: value }));

    expect(() => loadConfig()).toThrow(
      new RegExp(`${key}: .*predates akm 0\\.9\\.15.*akm migrate apply.* with akm 0\\.9\\.x`),
    );
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
    expect(dropped[0]).toContain("no endpoint");
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

  test("rejects disabled read and write defaults", () => {
    writeCurrentConfig({
      bundles: { off: { path: "/custom/stash", enabled: false } },
      defaultBundle: "off",
      defaultWriteTarget: "off",
    });
    expect(() => loadConfig()).toThrow(/defaultBundle.*disabled|defaultWriteTarget.*disabled/i);
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
  test("loads search.defaultExcludeTypes and search.curateRerank", () => {
    writeCurrentConfig({
      search: { defaultExcludeTypes: ["session", "memory"], curateRerank: { enabled: true, topN: 30 } },
    });
    expect(loadConfig().search).toEqual({
      defaultExcludeTypes: ["session", "memory"],
      curateRerank: { enabled: true, topN: 30 },
    });
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
  test("parses configVersion", () => {
    writeCurrentConfig({});
    const loaded = loadConfig();
    expect(loaded.configVersion).toBe("0.9.0");
  });

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
    expect(unknownPlatform.filter((w) => w.includes('harness "bad"') && w.includes('"invalid-platform"'))).toHaveLength(
      1,
    );

    writeCurrentConfig({ harnesses: { cursor: {}, codex: {} }, connections: { lab: LAB } });
    const unnamed = captureWarnings(() => {
      const loaded = loadConfig();
      expect(Object.keys(loaded.harnesses ?? {})).toEqual(["codex"]);
      expect(Object.keys(loaded.connections ?? {})).toEqual(["lab"]);
    });
    expect(unnamed.filter((w) => w.includes('harness "cursor"') && w.includes("names no platform"))).toHaveLength(1);
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

// ── `extends` inheritance (#945) ────────────────────────────────────────────

describe("extends inheritance (#945)", () => {
  test("merges a base config from a relative path, local wins", () => {
    const dir = path.dirname(getConfigPath());
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
    writeRawConfig(
      path.join(dir, "shared", "shared.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        connections: {
          fast: { endpoint: "https://api.example.test/v1", models: { fast: "base-model" } },
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
    expect(config.connections?.fast?.models).toEqual({ fast: "base-model" });
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

  test("a base config declaring a foreign configVersion is still merged underneath", () => {
    // The base gets the same per-file pipeline as the local file: its
    // `configVersion` is read as current rather than gating the merge, and the retired
    // engines/defaults form it is written in is read as connections.
    const dir = path.dirname(getConfigPath());
    writeRawConfig(
      path.join(dir, "old-base.json"),
      JSON.stringify({
        configVersion: "0.8.0",
        defaults: { llmEngine: "legacy" },
        engines: { legacy: { kind: "llm", endpoint: "https://api.example.test/v1/chat/completions", model: "m" } },
      }),
    );
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./old-base.json" }));

    const config = loadConfig();
    expect(config.configVersion).toBe("0.9.0");
    expect(config.connections?.default).toMatchObject({ endpoint: "https://api.example.test/v1/chat/completions" });
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

  test("rejects a bundle config symlink that physically escapes its content root", () => {
    const fleetDir = makeTmpDir();
    const outsideDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(fleetDir, "config"), { recursive: true });
      fs.writeFileSync(
        path.join(outsideDir, "shared.json"),
        JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 99 }),
      );
      fs.symlinkSync(path.join(outsideDir, "shared.json"), path.join(fleetDir, "config", "shared.json"));
      writeRawConfig(
        getConfigPath(),
        JSON.stringify({
          configVersion: "0.9.0",
          bundles: { fleet: { path: fleetDir } },
          extends: "fleet//config/shared.json",
        }),
      );
      expect(() => loadConfig()).toThrow(/symbolic link outside/i);
    } finally {
      cleanup(fleetDir);
      cleanup(outsideDir);
    }
  });

  test("strips inherited host authority while retaining portable connection and harness settings", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(
      path.join(dir, "base.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        connections: {
          cloud: {
            endpoint: "https://api.example.test/v1",
            apiKey: "$INHERITED_KEY",
            models: { fast: "portable-model" },
          },
        },
        harnesses: {
          inherited: {
            platform: "claude",
            models: { fast: "portable-model" },
            bin: "/untrusted/bin",
            args: ["--dangerous"],
            workspace: "/untrusted/workspace",
          },
        },
        experimental: { improveAutonomy: true },
      }),
    );
    writeRawConfig(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: "./base.json" }));

    const config = loadConfig();
    expect(config.harnesses?.inherited).toMatchObject({ platform: "claude", models: { fast: "portable-model" } });
    expect(config.harnesses?.inherited).not.toHaveProperty("bin");
    expect(config.harnesses?.inherited).not.toHaveProperty("args");
    expect(config.harnesses?.inherited).not.toHaveProperty("workspace");
    expect(config.connections?.cloud).toMatchObject({ endpoint: "https://api.example.test/v1" });
    expect(config.connections?.cloud).not.toHaveProperty("apiKey");
    expect(config.experimental).toBeUndefined();
    expect(getConfigValueSource("harnesses.inherited.models")).toBe("extends:./base.json");
    expect(getConfigValueSource("harnesses.inherited.bin")).toBe("default");
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

  test("scheduler activation is host-local and never inherited through extends", () => {
    const dir = path.dirname(getConfigPath());
    writeRawConfig(
      path.join(dir, "base.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        scheduler: { enabled: [{ kind: "task", ref: "fleet//tasks/untrusted" }] },
      }),
    );
    writeRawConfig(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
        extends: "./base.json",
        scheduler: {
          enabled: [{ kind: "task", ref: "local//tasks/nightly", sourceId: `sha256:${"a".repeat(64)}` }],
        },
      }),
    );

    const warnings = captureWarnings(() => {
      expect(loadConfig().scheduler?.enabled).toEqual(["local//tasks/nightly"]);
    });
    expect(warnings.join("\n")).toMatch(/ignoring inherited config key "scheduler"/i);
  });

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

  test("config set on an unrelated key after adopting extends does not duplicate the base's fields into the local file", () => {
    // Round-1 review finding: mutateConfig used to write the entire
    // extends-merged EFFECTIVE config back to the local file on any
    // `config set`/`unset`, baking every inherited field (connections,
    // improve.strategies, ...) into the local file on the very next
    // ordinary write — defeating the whole point of `extends`.
    const dir = path.dirname(getConfigPath());
    writeRawConfig(
      path.join(dir, "base.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        connections: {
          fast: { endpoint: "https://api.example.test/v1", models: { fast: "base-model" } },
        },
        improve: { connection: "fast" },
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
    expect(raw.connections).toBeUndefined();
    expect(raw.improve).toBeUndefined();
    expect(raw.archiveRetentionDays).toBeUndefined();

    // The effective (loaded) config is unaffected: still inherited.
    const config = loadConfig();
    expect(config.connections?.fast?.models).toEqual({ fast: "base-model" });
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
