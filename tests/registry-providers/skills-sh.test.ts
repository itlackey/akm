import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpClient } from "../../src/core/common";
import { resolveProviderFactory } from "../../src/registry/factory";
import type { RegistryProvider } from "../../src/registry/providers/types";
import { type Cleanup, sandboxXdgCacheHome } from "../_helpers/sandbox";

// Trigger self-registration
import "../../src/registry/providers/skills-sh";

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

// Non-routable endpoint — the injected fetch never connects. Each provider gets
// a unique host so the registry index cache (keyed by config URL) never collides
// between tests that share a query string.
let endpointSeq = 0;
function nextEndpoint(): string {
  endpointSeq += 1;
  return `http://test.local/r${endpointSeq}`;
}

// ── Fake fetch helpers ────────────────────────────────────────────────────────

/** Fake HttpClient that returns `body` as a JSON response (status 200). */
function fetchJson(body: unknown): HttpClient {
  return async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** Fake HttpClient that returns an error status. */
function fetchStatus(status: number): HttpClient {
  return async () => new Response("error", { status });
}

/** Fake HttpClient that returns raw (non-JSON) text with a JSON content-type. */
function fetchText(text: string): HttpClient {
  return async () => new Response(text, { headers: { "Content-Type": "application/json" } });
}

/** Fake HttpClient that simulates an unreachable server (network error). */
function fetchUnreachable(): HttpClient {
  return async () => {
    throw new Error("connect ECONNREFUSED");
  };
}

function makeProvider(fetch: HttpClient, name = "skills.sh", url = nextEndpoint()): RegistryProvider {
  const factory = resolveProviderFactory("skills-sh");
  if (!factory) throw new Error("skills-sh provider not registered");
  return factory({ url, name }, { fetch });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  envCleanup = cacheResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SkillsShProvider", () => {
  test("factory is registered", () => {
    const factory = resolveProviderFactory("skills-sh");
    expect(factory).not.toBeNull();
  });

  describe("happy path", () => {
    test("returns correct number of hits", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits).toHaveLength(3);
    });

    test("hit IDs are prefixed with skills-sh:", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.id).toStartWith("skills-sh:");
      }
    });

    test("hit source is github", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.source).toBe("github");
      }
    });

    test("hit ref matches entry source", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits[0].ref).toBe("vercel-labs/agent-skills");
      expect(result.hits[1].ref).toBe("some-org/web-skills");
      expect(result.hits[2].ref).toBe("solo-dev/my-skills");
    });

    test("hit homepage derives from config URL", async () => {
      const url = nextEndpoint();
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE), "skills.sh", url);
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits[0].homepage).toBe(`${url}/vercel-labs/agent-skills/react-best-practices`);
    });

    test("registryName is set from config", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE), "my-skills-registry");
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.registryName).toBe("my-skills-registry");
      }
    });

    test("metadata includes installs and author", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.hits[0].metadata?.installs).toBe("22475");
      expect(result.hits[0].metadata?.author).toBe("vercel-labs");
    });

    test("registryName defaults to skills.sh when config has no name", async () => {
      const factory = resolveProviderFactory("skills-sh");
      expect(factory).not.toBeNull();
      const provider = factory?.({ url: nextEndpoint() }, { fetch: fetchJson(FIXTURE_RESPONSE) });
      const result = await provider?.search({ query: "react", limit: 10 });
      for (const hit of result?.hits ?? []) {
        expect(hit.registryName).toBe("skills.sh");
      }
    });

    test("limit is enforced client-side", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 1 });
      expect(result.hits).toHaveLength(1);
    });

    test("no warnings on success", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      expect(result.warnings).toBeUndefined();
    });
  });

  describe("empty results", () => {
    test("empty skills array returns empty hits and no warnings", async () => {
      const provider = makeProvider(fetchJson({ skills: [] }));
      const result = await provider.search({ query: "nonexistent", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toBeUndefined();
    });
  });

  describe("error handling", () => {
    test("404 returns empty hits with warning", async () => {
      const provider = makeProvider(fetchStatus(404));
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("skills.sh");
    });

    test("500 returns empty hits with warning", async () => {
      const provider = makeProvider(fetchStatus(500));
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings?.[0]).toContain("HTTP 500");
    });

    test("unreachable server returns warning", async () => {
      const provider = makeProvider(fetchUnreachable());
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("malformed responses", () => {
    test("non-JSON returns empty hits with warning", async () => {
      const provider = makeProvider(fetchText("not json at all"));
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      expect(result.warnings).toBeDefined();
    });

    test("missing skills array returns empty hits without warning", async () => {
      const provider = makeProvider(fetchJson({ unexpected: true }));
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toEqual([]);
      // No warning because the response was valid JSON, just empty results
      expect(result.warnings).toBeUndefined();
    });

    test("skills with invalid entries filters them out", async () => {
      const provider = makeProvider(
        fetchJson({
          skills: [
            { id: "valid/skill", name: "valid", installs: 100, source: "valid/repo" },
            { id: "missing-fields" }, // invalid
            "not-an-object", // invalid
            null, // invalid
          ],
        }),
      );
      const result = await provider.search({ query: "test", limit: 10 });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].title).toBe("valid");
    });
  });

  describe("score normalization", () => {
    test("scores are in 0-1 range", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      for (const hit of result.hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    });

    test("highest-installs entry gets score 1.0", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10 });
      // vercel-labs has 22475 installs (highest)
      expect(result.hits[0].score).toBe(1);
    });
  });

  describe("asset hits", () => {
    test("includeAssets returns RegistryAssetSearchHit entries", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10, includeAssets: true });
      expect(result.assetHits).toHaveLength(3);
    });

    test("asset hits have assetType skill", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10, includeAssets: true });
      for (const hit of result.assetHits ?? []) {
        expect(hit.assetType).toBe("skill");
      }
    });

    test("asset hits have correct action", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10, includeAssets: true });
      expect(result.assetHits?.[0].action).toBe("akm add github:vercel-labs/agent-skills");
    });

    test("no asset hits when includeAssets is false", async () => {
      const provider = makeProvider(fetchJson(FIXTURE_RESPONSE));
      const result = await provider.search({ query: "react", limit: 10, includeAssets: false });
      expect(result.assetHits).toBeUndefined();
    });
  });

  describe("caching", () => {
    test("second call uses cache after fetch stops responding", async () => {
      // First call fetches from the API; the second call must be served from the
      // cache, so the fake fetch is swapped to one that fails on any later call.
      let live = true;
      const provider = makeProvider(async () => {
        if (!live) throw new Error("connect ECONNREFUSED");
        return new Response(JSON.stringify(FIXTURE_RESPONSE), { headers: { "Content-Type": "application/json" } });
      });

      // First call — fetches from the (live) API
      const result1 = await provider.search({ query: "react", limit: 10 });
      expect(result1.hits).toHaveLength(3);

      // Take the server offline
      live = false;

      // Second call — should use cache
      const result2 = await provider.search({ query: "react", limit: 10 });
      expect(result2.hits).toHaveLength(3);
      expect(result2.hits[0].id).toBe(result1.hits[0].id);
    });
  });
});
