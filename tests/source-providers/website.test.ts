import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../../src/core/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import { resolveSourceProviderFactory } from "../../src/sources/provider-factory";
import {
  ensureWebsiteMirror,
  fetchWebsiteMarkdownSnapshot,
  getWebsiteCachePaths,
  validateWebsiteInputUrl,
  validateWebsiteUrl,
} from "../../src/sources/website-ingest";

// Trigger self-registration
import "../../src/sources/providers/website";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-website-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-website-cache-");
  process.env.XDG_CONFIG_HOME = createTmpDir("akm-website-config-");
  process.env.AKM_STASH_DIR = createTmpDir("akm-website-stash-");
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WebsiteSourceProvider", () => {
  test("self-registers as 'website'", () => {
    expect(resolveSourceProviderFactory("website")).toBeTruthy();
  });

  test("provider exposes only the v1 SourceProvider surface (no search/show stubs)", () => {
    const factory = resolveSourceProviderFactory("website");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected website factory to be registered");
    const provider = factory({
      type: "website",
      url: "https://example.com/docs",
      name: "example",
    });

    expect(provider.kind).toBe("website");
    expect(provider.name).toBe("example");
    expect(typeof provider.path).toBe("function");
    expect(typeof provider.sync).toBe("function");
    expect((provider as unknown as { search?: unknown }).search).toBeUndefined();
    expect((provider as unknown as { show?: unknown }).show).toBeUndefined();
    expect((provider as unknown as { canShow?: unknown }).canShow).toBeUndefined();
  });

  test("path() returns the same value across calls (lifetime stability)", () => {
    const factory = resolveSourceProviderFactory("website");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected website factory to be registered");
    const provider = factory({
      type: "website",
      url: "https://example.com/docs",
      name: "example",
    });
    const first = provider.path();
    const second = provider.path();
    expect(second).toBe(first);
  });

  test("scrapes a website into cached markdown files", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example.test/") {
        return new Response(
          "<html><head><title>Docs Home</title></head><body><h1>Docs Home</h1><p>Welcome.</p><a href='/guide'>Guide</a></body></html>",
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (url === "https://docs.example.test/guide") {
        return new Response("<html><body><h1>Guide</h1><p>Install the tool safely.</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const entry = { type: "website", url: "https://docs.example.test/" } as const;
      const cachePaths = await ensureWebsiteMirror(entry, { requireStashDir: true });
      const topFiles = fs.readdirSync(path.join(cachePaths.stashDir, "knowledge")).sort();
      expect(topFiles).toEqual(["guide.md", "index.md"]);

      const homeDoc = fs.readFileSync(path.join(cachePaths.stashDir, "knowledge", "index.md"), "utf8");
      expect(homeDoc).toContain("# Docs Home");
      expect(homeDoc).toContain("Source: https://docs.example.test/");
      expect(homeDoc).toContain("[Guide](https://docs.example.test/guide)");

      const guideDoc = fs.readFileSync(path.join(cachePaths.stashDir, "knowledge", "guide.md"), "utf8");
      expect(guideDoc).toContain("# Guide");
      expect(guideDoc).toContain("Install the tool safely.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("validateWebsiteUrl rejects embedded credentials", () => {
    expect(() => validateWebsiteUrl("https://user:pass@example.com")).toThrow("embedded credentials");
  });

  test("CLI input validation throws UsageError while config validation throws ConfigError", () => {
    expect(() => validateWebsiteInputUrl("not a url")).toThrow(UsageError);
    expect(() => validateWebsiteUrl("not a url")).toThrow(ConfigError);
  });

  test("getWebsiteCachePaths is stable for normalized URLs", () => {
    const a = getWebsiteCachePaths("https://example.com/docs/");
    const b = getWebsiteCachePaths("https://example.com/docs");
    expect(a.rootDir).toBe(b.rootDir);
  });

  test("fetchWebsiteMarkdownSnapshot fetches one page and derives a URL-path name", async () => {
    const originalFetch = globalThis.fetch;
    let headers: Headers | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      const url = String(input);
      if (url === "https://docs.example.test/guide/getting-started") {
        return new Response(
          "<html><head><title>Getting Started</title></head><body><h1>Getting Started</h1><p>Run setup first.</p></body></html>",
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const snapshot = await fetchWebsiteMarkdownSnapshot("https://docs.example.test/guide/getting-started");
      expect(snapshot.url).toBe("https://docs.example.test/guide/getting-started");
      expect(snapshot.preferredName).toBe("guide/getting-started");
      expect(snapshot.title).toBe("Getting Started");
      expect(snapshot.content).toContain('sourceUrl: "https://docs.example.test/guide/getting-started"');
      expect(snapshot.content).toContain("# Getting Started");
      expect(headers?.get("connection")).toBe("close");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
