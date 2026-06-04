import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegistryIndex } from "../src/commands/registry-search";
import { resolveRegistries, searchRegistry } from "../src/commands/registry-search";
import type { RegistryConfigEntry } from "../src/core/config";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config";
import { getConfigPath } from "../src/core/paths";
import { runCliCapture } from "./_helpers/cli";

// ── Helpers ─────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-reg-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeConfig(configPath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function serveIndex(index: RegistryIndex): { url: string; close: () => void } {
  const body = JSON.stringify(index);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/index.json?test=${token}`,
    close: () => server.stop(true),
  };
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalRegistryUrl = process.env.AKM_REGISTRY_URL;

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = createTmpDir("akm-reg-config-");
  process.env.XDG_CACHE_HOME = createTmpDir("akm-reg-cache-");
  // Pair with XDG_DATA_HOME / XDG_STATE_HOME so the bun-test isolation
  // guard in src/core/paths.ts (tightened in 35ec047) does not fire when
  // searchRegistry's static-index provider tries to open the DB cache.
  // Without these the guard throws TEST_ISOLATION_MISSING, which surfaces
  // as a warning + zero hits — see tests/test-isolation-no-swallow.test.ts.
  process.env.XDG_DATA_HOME = createTmpDir("akm-reg-data-");
  process.env.XDG_STATE_HOME = createTmpDir("akm-reg-state-");
  delete process.env.AKM_REGISTRY_URL;
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
  if (originalRegistryUrl === undefined) {
    delete process.env.AKM_REGISTRY_URL;
  } else {
    process.env.AKM_REGISTRY_URL = originalRegistryUrl;
  }
});

// ── Registry add/remove/list ─────────────────────────────────────────────────

describe("registry add/remove/list via config", () => {
  test("list returns default registries when none configured", () => {
    const config = loadConfig();
    const registries = config.registries ?? [];
    expect(registries.length).toBe(2);
    expect(registries[0].name).toBe("akm-registry");
    expect(registries[0].url).toContain("akm-registry");
    expect(registries[1].name).toBe("skills.sh");
    expect(registries[1].provider).toBe("skills-sh");
    expect(registries[1].enabled).toBe(false);
  });

  test("add appends a registry entry", () => {
    const config = loadConfig();
    const registries = [...(config.registries ?? [])];
    const newEntry: RegistryConfigEntry = { url: "https://example.com/index.json", name: "custom" };
    registries.push(newEntry);
    saveConfig({ ...config, registries });

    const updated = loadConfig();
    expect(updated.registries?.length).toBe(3);
    expect(updated.registries?.[2].url).toBe("https://example.com/index.json");
    expect(updated.registries?.[2].name).toBe("custom");
  });

  test("add deduplicates by URL", () => {
    // Start with a known registry entry
    const url = "https://example.com/dedup-test.json";
    const config = loadConfig();
    const registries = [...(config.registries ?? [])];
    registries.push({ url, name: "dedup-target" });
    saveConfig({ ...config, registries });

    // Verify it was added
    const afterFirst = loadConfig();
    const countAfterFirst = afterFirst.registries?.length ?? 0;

    // Try to add the same URL again using the CLI's dedup logic
    const current = loadConfig();
    const currentRegistries = [...(current.registries ?? [])];
    if (!currentRegistries.some((r) => r.url === url)) {
      currentRegistries.push({ url, name: "dedup-target" });
    }
    saveConfig({ ...current, registries: currentRegistries });

    // Verify length is unchanged — the duplicate was rejected
    const afterSecond = loadConfig();
    expect(afterSecond.registries?.length).toBe(countAfterFirst);
  });

  test("remove by URL", () => {
    const config = loadConfig();
    const registries: RegistryConfigEntry[] = [
      { url: "https://example.com/a.json", name: "a" },
      { url: "https://example.com/b.json", name: "b" },
    ];
    saveConfig({ ...config, registries });

    const current = loadConfig();
    const remaining = (current.registries ?? []).filter((r) => r.url !== "https://example.com/a.json");
    saveConfig({ ...current, registries: remaining });

    const final = loadConfig();
    expect(final.registries?.length).toBe(1);
    expect(final.registries?.[0].name).toBe("b");
  });

  test("remove by name", () => {
    const config = loadConfig();
    const registries: RegistryConfigEntry[] = [
      { url: "https://example.com/a.json", name: "alpha" },
      { url: "https://example.com/b.json", name: "beta" },
    ];
    saveConfig({ ...config, registries });

    const current = loadConfig();
    const remaining = (current.registries ?? []).filter((r) => r.name !== "alpha");
    saveConfig({ ...current, registries: remaining });

    const final = loadConfig();
    expect(final.registries?.length).toBe(1);
    expect(final.registries?.[0].name).toBe("beta");
  });
});

// ── registry remove safety guard (WS0) ──────────────────────────────────────

describe("registry remove confirmation guard (WS0)", () => {
  function seedRegistries(): void {
    const config = loadConfig();
    const registries: RegistryConfigEntry[] = [
      { url: "https://example.com/a.json", name: "alpha" },
      { url: "https://example.com/b.json", name: "beta" },
    ];
    saveConfig({ ...config, registries });
    resetConfigCache();
  }

  test("remove without --yes aborts in non-interactive mode (exit 2) and keeps the registry", async () => {
    seedRegistries();
    const result = await runCliCapture(["registry", "remove", "alpha", "--format=json"]);
    // confirmDestructive throws NON_INTERACTIVE_REQUIRES_YES (UsageError → exit 2)
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("NON_INTERACTIVE_REQUIRES_YES");
    // Registry must NOT have been removed.
    resetConfigCache();
    const after = loadConfig();
    expect(after.registries?.some((r) => r.name === "alpha")).toBe(true);
  });

  test("remove with --yes proceeds and removes the registry", async () => {
    seedRegistries();
    const result = await runCliCapture(["registry", "remove", "alpha", "--yes", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.removed).toBe(true);
    expect(parsed.entry.name).toBe("alpha");
    resetConfigCache();
    const after = loadConfig();
    expect(after.registries?.some((r) => r.name === "alpha")).toBe(false);
    expect(after.registries?.some((r) => r.name === "beta")).toBe(true);
  });

  test("remove of a non-existent registry is a no-op and needs no confirmation", async () => {
    seedRegistries();
    const result = await runCliCapture(["registry", "remove", "does-not-exist", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.removed).toBe(false);
  });
});

// ── resolveRegistries ───────────────────────────────────────────────────────

describe("resolveRegistries", () => {
  test("filters out disabled registries", () => {
    const entries: RegistryConfigEntry[] = [
      { url: "https://a.com/index.json", name: "a", enabled: true },
      { url: "https://b.com/index.json", name: "b", enabled: false },
      { url: "https://c.com/index.json", name: "c" },
    ];
    const resolved = resolveRegistries(entries);
    expect(resolved.length).toBe(2);
    expect(resolved.map((r) => r.name)).toEqual(["a", "c"]);
  });

  test("AKM_REGISTRY_URL env var overrides config", () => {
    process.env.AKM_REGISTRY_URL = "https://override.com/index.json";
    const resolved = resolveRegistries([{ url: "https://config.com/index.json" }]);
    expect(resolved.length).toBe(1);
    expect(resolved[0].url).toBe("https://override.com/index.json");
  });

  test("returns empty array when passed empty array", () => {
    const resolved = resolveRegistries([]);
    // Empty array passed explicitly — returns empty, no fallback
    expect(resolved).toEqual([]);
  });

  test("returns default from config when no override", () => {
    const resolved = resolveRegistries(undefined);
    // Will read from loadConfig which returns DEFAULT_CONFIG registries
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].name).toBe("akm-registry");
  });
});

// ── Registry search with RegistryConfigEntry ────────────────────────────────

describe("registry search with config entries", () => {
  test("basic query against mock index", async () => {
    const index: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:test-stash",
          name: "Test Stash",
          description: "A test stash for deploy",
          ref: "test-stash",
          source: "npm",
          tags: ["deploy"],
        },
      ],
    };

    const srv = serveIndex(index);
    try {
      const result = await searchRegistry("deploy", {
        registries: [{ url: srv.url, name: "test-reg" }],
      });
      expect(result.hits.length).toBe(1);
      expect(result.hits[0].id).toBe("npm:test-stash");
      expect(result.hits[0].registryName).toBe("test-reg");
    } finally {
      srv.close();
    }
  });

  test("multi-registry search merges results from multiple URLs", async () => {
    const index1: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:stash-one",
          name: "Stash One",
          description: "First stash for build",
          ref: "stash-one",
          source: "npm",
          tags: ["build"],
        },
      ],
    };
    const index2: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "github:org/stash-two",
          name: "Stash Two",
          description: "Second stash for build automation",
          ref: "org/stash-two",
          source: "github",
          tags: ["build"],
        },
      ],
    };

    const srv1 = serveIndex(index1);
    const srv2 = serveIndex(index2);
    try {
      const result = await searchRegistry("build", {
        registries: [
          { url: srv1.url, name: "primary" },
          { url: srv2.url, name: "secondary" },
        ],
      });
      expect(result.hits.length).toBe(2);
      const ids = result.hits.map((h) => h.id);
      expect(ids).toContain("npm:stash-one");
      expect(ids).toContain("github:org/stash-two");

      // Verify provenance
      const stash1Hit = result.hits.find((h) => h.id === "npm:stash-one");
      const stash2Hit = result.hits.find((h) => h.id === "github:org/stash-two");
      expect(stash1Hit?.registryName).toBe("primary");
      expect(stash2Hit?.registryName).toBe("secondary");
    } finally {
      srv1.close();
      srv2.close();
    }
  });

  test("disabled registries are skipped via resolveRegistries before search", () => {
    const entries: RegistryConfigEntry[] = [
      { url: "https://enabled.com/index.json", name: "enabled", enabled: true },
      { url: "https://disabled.com/index.json", name: "disabled", enabled: false },
    ];
    const resolved = resolveRegistries(entries);
    expect(resolved.length).toBe(1);
    expect(resolved[0].name).toBe("enabled");
  });
});

// ── Config roundtrip for registries ─────────────────────────────────────────

describe("config roundtrip", () => {
  test("registries persist through save/load cycle", () => {
    const registries: RegistryConfigEntry[] = [
      { url: "https://a.com/index.json", name: "alpha" },
      { url: "https://b.com/index.json", name: "beta", enabled: false },
    ];
    saveConfig({ semanticSearchMode: "auto", registries });

    const loaded = loadConfig();
    expect(loaded.registries?.length).toBe(2);
    expect(loaded.registries?.[0]).toEqual({ url: "https://a.com/index.json", name: "alpha" });
    expect(loaded.registries?.[1]).toEqual({ url: "https://b.com/index.json", name: "beta", enabled: false });
  });

  test("invalid registry entries reject at load time (no silent filtering)", () => {
    const configPath = getConfigPath();
    writeConfig(configPath, {
      semanticSearchMode: "auto",
      registries: [
        { url: "https://valid.com/index.json", name: "valid" },
        { url: "", name: "empty-url" },
        { name: "no-url" },
        42,
        null,
      ],
    });

    expect(() => loadConfig()).toThrow();
  });
});
