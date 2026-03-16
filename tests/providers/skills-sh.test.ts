import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProviderFactory } from "../../src/registry-factory";
import type { RegistryProvider } from "../../src/registry-provider";

// Trigger self-registration
import "../../src/providers/skills-sh";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_RESPONSE = {
  skills: [
    {
      id: "vercel-labs/agent-skills/react-best-practices",
      name: "react-best-practices",
      installs: 22475,
      source: "vercel-labs/agent-skills",
    },
    { id: "some-org/web-skills/css-layout", name: "css-layout", installs: 5000, source: "some-org/web-skills" },
    { id: "solo-dev/my-skills/deploy-helper", name: "deploy-helper", installs: 100, source: "solo-dev/my-skills" },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];
const servers: Array<{ stop: (force: boolean) => void }> = [];

function createTmpDir(prefix = "akm-skills-sh-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function serveJson(body: unknown): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

function serveError(status: number): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("error", { status });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

function serveText(text: string): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(text, {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

function makeProvider(url: string, name = "skills.sh"): RegistryProvider {
  const factory = resolveProviderFactory("skills-sh");
  if (!factory) throw new Error("skills-sh provider not registered");
  return factory({ url, name });
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-skills-cache-");
});

afterEach(() => {
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      /* already stopped */
    }
  }
  servers.length = 0;

  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SkillsShProvider", () => {
  test("factory is registered", () => {
    const factory = resolveProviderFactory("skills-sh");
    expect(factory).not.toBeNull();
  });

  describe("happy path", () => {
    test("returns correct number of hits", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits).toHaveLength(3);
    });

    test("hit IDs are prefixed with skills-sh:", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.id).toStartWith("skills-sh:");
      }
    });

    test("hit source is github", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.source).toBe("github");
      }
    });

    test("hit ref matches entry source", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits[0].ref).toBe("vercel-labs/agent-skills");
      expect(result.hits[1].ref).toBe("some-org/web-skills");
      expect(result.hits[2].ref).toBe("solo-dev/my-skills");
    });

    test("hit homepage derives from config URL", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits[0].homepage).toBe(`${srv.url}/vercel-labs/agent-skills/react-best-practices`);
    });

    test("registryName is set from config", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url, "my-skills-registry");
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.registryName).toBe("my-skills-registry");
      }
    });

    test("metadata includes installs and author", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits[0].metadata?.installs).toBe("22475");
      expect(result.hits[0].metadata?.author).toBe("vercel-labs");
    });

    test("registryName defaults to skills.sh when config has no name", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const factory = resolveProviderFactory("skills-sh");
      expect(factory).not.toBeNull();
      const provider = factory?.({ url: srv.url });
      const result = await provider?.search({ query: "react", limit: 10 });
      for (const hit of result?.hits ?? []) {
        expect(hit.registryName).toBe("skills.sh");
      }
    });

    test("limit is enforced client-side", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 1 });
      expect(result.hits).toHaveLength(1);
    });

    test("no warnings on success", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.warnings).toBeUndefined();
    });
  });

  describe("empty results", () => {
    test("empty skills array returns empty hits and no warnings", async () => {
      const srv = serveJson({ skills: [] });
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "nonexistent", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toBeUndefined();
    });
  });

  describe("error handling", () => {
    test("404 returns empty hits with warning", async () => {
      const srv = serveError(404);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("skills.sh");
    });

    test("500 returns empty hits with warning", async () => {
      const srv = serveError(500);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings?.[0]).toContain("HTTP 500");
    });

    test("unreachable server returns warning", async () => {
      const provider = makeProvider("http://127.0.0.1:1");
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("malformed responses", () => {
    test("non-JSON returns empty hits with warning", async () => {
      const srv = serveText("not json at all");
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toBeDefined();
    });

    test("missing skills array returns empty hits without warning", async () => {
      const srv = serveJson({ unexpected: true });
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      // No warning because the response was valid JSON, just empty results
      expect(result.warnings).toBeUndefined();
    });

    test("skills with invalid entries filters them out", async () => {
      const srv = serveJson({
        skills: [
          { id: "valid/skill", name: "valid", installs: 100, source: "valid/repo" },
          { id: "missing-fields" }, // invalid
          "not-an-object", // invalid
          null, // invalid
        ],
      });
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].title).toBe("valid");
    });
  });

  describe("score normalization", () => {
    test("scores are in 0-1 range", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    });

    test("highest-installs entry gets score 1.0", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10 });
      // vercel-labs has 22475 installs (highest)
      expect(result.hits[0].score).toBe(1);
    });
  });

  describe("asset hits", () => {
    test("includeAssets returns RegistryAssetSearchHit entries", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10, includeAssets: true });
      expect(result.assetHits).toHaveLength(3);
    });

    test("asset hits have assetType skill", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10, includeAssets: true });
      for (const hit of result.assetHits ?? []) {
        expect(hit.assetType).toBe("skill");
      }
    });

    test("asset hits have correct action", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10, includeAssets: true });
      expect(result.assetHits?.[0].action).toBe("akm add vercel-labs/agent-skills");
    });

    test("no asset hits when includeAssets is false", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "react", limit: 10, includeAssets: false });
      expect(result.assetHits).toBeUndefined();
    });
  });

  describe("caching", () => {
    test("second call uses cache after server is killed", async () => {
      const srv = serveJson(FIXTURE_RESPONSE);
      const provider = makeProvider(srv.url);

      // First call — fetches from server
      const result1 = await provider.search({ query: "react", limit: 10 });
      expect(result1.hits).toHaveLength(3);

      // Kill the server
      srv.close();

      // Second call — should use cache
      const result2 = await provider.search({ query: "react", limit: 10 });
      expect(result2.hits).toHaveLength(3);
      expect(result2.hits[0].id).toBe(result1.hits[0].id);
    });
  });
});
