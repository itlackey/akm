import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../../src/config";
import { resolveStashProviderFactory } from "../../src/stash-provider-factory";
import { ensureWebsiteMirror, getCachePaths, validateWebsiteUrl } from "../../src/stash-providers/website";

// Trigger self-registration
import "../../src/stash-providers/website";

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

describe("WebsiteStashProvider", () => {
  test("self-registers as 'website'", () => {
    expect(resolveStashProviderFactory("website")).toBeTruthy();
  });

  test("search() returns empty hits because content is indexed locally", async () => {
    const factory = resolveStashProviderFactory("website");
    expect(factory).toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
    const provider = factory!({
      type: "website",
      url: "https://example.com/docs",
      name: "example",
    });

    const result = await provider.search({ query: "docs", limit: 5 });
    expect(result.hits).toEqual([]);
    expect(provider.canShow("knowledge:example-com")).toBe(false);
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
      const files = fs.readdirSync(path.join(cachePaths.stashDir, "knowledge")).sort();
      expect(files).toEqual(["docs.example.test.md", "docs.example.test__guide.md"]);

      const homeDoc = fs.readFileSync(path.join(cachePaths.stashDir, "knowledge", "docs.example.test.md"), "utf8");
      expect(homeDoc).toContain("# Docs Home");
      expect(homeDoc).toContain("Source: https://docs.example.test/");
      expect(homeDoc).toContain("[Guide](https://docs.example.test/guide)");

      const guideDoc = fs.readFileSync(
        path.join(cachePaths.stashDir, "knowledge", "docs.example.test__guide.md"),
        "utf8",
      );
      expect(guideDoc).toContain("# Guide");
      expect(guideDoc).toContain("Install the tool safely.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("validateWebsiteUrl rejects embedded credentials", () => {
    expect(() => validateWebsiteUrl("https://user:pass@example.com")).toThrow("embedded credentials");
  });

  test("getCachePaths is stable for normalized URLs", () => {
    const a = getCachePaths("https://example.com/docs/");
    const b = getCachePaths("https://example.com/docs");
    expect(a.rootDir).toBe(b.rootDir);
  });
});
