import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegistryConfigEntry } from "../src/config";
import { getConfigPath, loadConfig, saveConfig } from "../src/config";
import type { RegistryIndex } from "../src/registry-search";
import { resolveRegistries, searchRegistry } from "../src/registry-search";

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
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/index.json`,
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
const originalRegistryUrl = process.env.AKM_REGISTRY_URL;

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = createTmpDir("akm-reg-config-");
  process.env.XDG_CACHE_HOME = createTmpDir("akm-reg-cache-");
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
    expect(registries.length).toBe(1);
    expect(registries[0].name).toBe("official");
    expect(registries[0].url).toContain("akm-registry");
  });

  test("add appends a registry entry", () => {
    const config = loadConfig();
    const registries = [...(config.registries ?? [])];
    const newEntry: RegistryConfigEntry = { url: "https://example.com/index.json", name: "custom" };
    registries.push(newEntry);
    saveConfig({ ...config, registries });

    const updated = loadConfig();
    expect(updated.registries?.length).toBe(2);
    expect(updated.registries?.[1].url).toBe("https://example.com/index.json");
    expect(updated.registries?.[1].name).toBe("custom");
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
    expect(resolved[0].name).toBe("official");
  });
});

// ── Registry search with RegistryConfigEntry ────────────────────────────────

describe("registry search with config entries", () => {
  test("basic query against mock index", async () => {
    const index: RegistryIndex = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "npm:test-kit",
          name: "Test Kit",
          description: "A test kit for deploy",
          ref: "test-kit",
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
      expect(result.hits[0].id).toBe("npm:test-kit");
      expect(result.hits[0].registryName).toBe("test-reg");
    } finally {
      srv.close();
    }
  });

  test("multi-registry search merges results from multiple URLs", async () => {
    const index1: RegistryIndex = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "npm:kit-one",
          name: "Kit One",
          description: "First kit for build",
          ref: "kit-one",
          source: "npm",
          tags: ["build"],
        },
      ],
    };
    const index2: RegistryIndex = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "github:org/kit-two",
          name: "Kit Two",
          description: "Second kit for build automation",
          ref: "org/kit-two",
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
      expect(ids).toContain("npm:kit-one");
      expect(ids).toContain("github:org/kit-two");

      // Verify provenance
      const kit1Hit = result.hits.find((h) => h.id === "npm:kit-one");
      const kit2Hit = result.hits.find((h) => h.id === "github:org/kit-two");
      expect(kit1Hit?.registryName).toBe("primary");
      expect(kit2Hit?.registryName).toBe("secondary");
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
    saveConfig({ semanticSearch: true, searchPaths: [], registries });

    const loaded = loadConfig();
    expect(loaded.registries?.length).toBe(2);
    expect(loaded.registries?.[0]).toEqual({ url: "https://a.com/index.json", name: "alpha" });
    expect(loaded.registries?.[1]).toEqual({ url: "https://b.com/index.json", name: "beta", enabled: false });
  });

  test("invalid registry entries are filtered during load", () => {
    const configPath = getConfigPath();
    writeConfig(configPath, {
      semanticSearch: true,
      searchPaths: [],
      registries: [
        { url: "https://valid.com/index.json", name: "valid" },
        { url: "", name: "empty-url" },
        { name: "no-url" },
        42,
        null,
      ],
    });

    const loaded = loadConfig();
    expect(loaded.registries?.length).toBe(1);
    expect(loaded.registries?.[0].url).toBe("https://valid.com/index.json");
  });
});
