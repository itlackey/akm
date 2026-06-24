import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RegistryIndex } from "../src/commands/read/registry-search";
import { searchRegistry } from "../src/commands/read/registry-search";
import type { HttpClient } from "../src/core/common";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgDataHome } from "./_helpers/sandbox";

// ── Test fixtures ───────────────────────────────────────────────────────────

// One entry intentionally carries the legacy `curated` boolean to exercise
// the v1 parse-and-ignore rule (spec §4.2). The cast is necessary because
// `curated` was removed from `RegistryStashEntry` in v1.
const FIXTURE_INDEX: RegistryIndex = {
  version: 3,
  updatedAt: "2026-03-09T00:00:00Z",
  stashes: [
    {
      id: "npm:@itlackey/openkit",
      name: "@itlackey/openkit",
      description: "Starter stash for building OpenCode extensions with Bun.js",
      ref: "@itlackey/openkit",
      source: "npm",
      homepage: "https://github.com/itlackey/openkit-starter",
      tags: ["opencode", "bun", "typescript", "starter"],
      assetTypes: ["skill", "script", "command"],
      author: "itlackey",
      license: "MIT",
      latestVersion: "1.2.0",
    },
    {
      id: "github:itlackey/dimm-city-stash",
      name: "Dimm City TTRPG Stash",
      description: "Agent skills for Dimm City creaturepunk TTRPG content generation",
      ref: "itlackey/dimm-city-stash",
      source: "github",
      tags: ["ttrpg", "dimm-city", "creaturepunk", "print", "markdown"],
      assetTypes: ["skill", "command", "knowledge"],
      author: "itlackey",
      license: "CC-BY-4.0",
      // Legacy v0.6.x field — kept here to verify v1 parse-and-ignore.
      curated: true,
    } as RegistryIndex["stashes"][number] & { curated: boolean },
    {
      id: "github:someone/azure-ops-stash",
      name: "Azure Ops Stash",
      description: "CLI skills for managing Azure Container Apps and DevOps",
      ref: "someone/azure-ops-stash",
      source: "github",
      tags: ["azure", "devops", "container-apps", "infrastructure"],
      assetTypes: ["skill", "script"],
      author: "someone",
      license: "MIT",
      latestVersion: "v0.3.1",
    },
    {
      id: "npm:generic-agent-utils",
      name: "generic-agent-utils",
      description: "Utility functions for agent development",
      ref: "generic-agent-utils",
      source: "npm",
      tags: ["utility", "agent"],
      author: "devperson",
    },
  ],
};

// ── Injected fetch (#664 Seam 1) ──────────────────────────────────────────────
//
// Non-routable endpoints — the injected fetch never opens a socket, so these
// URLs serve only to key the route table. `searchRegistry({ fetch })` threads
// the fake into every provider, replacing the per-test Bun.serve instances.

const FIXTURE_URL = "http://test.local/index.json";

/** A skills.sh API response body (matches the shape the old server returned). */
function skillsBody(skills: Array<{ id: string; name: string; installs: number; source: string }>): string {
  return JSON.stringify({ skills });
}

/**
 * Build an `HttpClient` that routes by request URL to a registered body.
 *
 * - A `string` route returns `200` with that JSON body.
 * - A `{ status, body }` route returns the given status (for error paths).
 * - skills.sh providers append `/api/search?…` to their base URL, so routes
 *   match by URL prefix.
 * - Unmatched URLs reject (mimics an unreachable host) so error-path tests work.
 */
function fakeFetch(routes: Record<string, string | { status: number; body?: string }>): HttpClient {
  return async (input) => {
    const url = String(input);
    for (const [base, route] of Object.entries(routes)) {
      if (url === base || url.startsWith(base)) {
        if (typeof route === "string") {
          return new Response(route, { headers: { "Content-Type": "application/json" } });
        }
        return new Response(route.body ?? "error", {
          status: route.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw new Error(`fakeFetch: no route for ${url}`);
  };
}

/** The common case: one static-index endpoint serving the constant fixture. */
const fetchFixture: HttpClient = fakeFetch({ [FIXTURE_URL]: JSON.stringify(FIXTURE_INDEX) });

// ── Per-test XDG sandbox ──────────────────────────────────────────────────────

const originalRegistryUrl = process.env.AKM_REGISTRY_URL;

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  // Isolate cache per test.
  const cacheResult = sandboxXdgCacheHome();
  // Also isolate the data dir per test. The registry-index cache lives in
  // index.db under getDataDir() (XDG_DATA_HOME/HOME), NOT XDG_CACHE_HOME. That
  // cache is keyed solely on the registry URL with a 1-hour TTL, so a fresh data
  // dir per test keeps a cached index from one test out of the next.
  const dataResult = sandboxXdgDataHome(cacheResult.cleanup);
  envCleanup = dataResult.cleanup;
  delete process.env.AKM_REGISTRY_URL;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  if (originalRegistryUrl === undefined) {
    delete process.env.AKM_REGISTRY_URL;
  } else {
    process.env.AKM_REGISTRY_URL = originalRegistryUrl;
  }
});

// ── Empty / blank queries ───────────────────────────────────────────────────

describe("searchRegistry", () => {
  test("returns empty for blank query", async () => {
    const result = await searchRegistry("");
    expect(result).toEqual({ query: "", hits: [], warnings: [] });
  });

  test("returns empty for whitespace query", async () => {
    const result = await searchRegistry("   ");
    expect(result).toEqual({ query: "", hits: [], warnings: [] });
  });
});

// ── Scoring and ranking ─────────────────────────────────────────────────────

describe("scoring", () => {
  test("exact name match ranks highest", async () => {
    const result = await searchRegistry("Azure Ops Stash", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe("github:someone/azure-ops-stash");
  });

  test("tag match surfaces relevant stashes", async () => {
    const result = await searchRegistry("creaturepunk", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe("github:itlackey/dimm-city-stash");
  });

  test("description substring matches", async () => {
    const result = await searchRegistry("Container Apps", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.some((h) => h.id === "github:someone/azure-ops-stash")).toBe(true);
  });

  test("no match returns empty hits without error", async () => {
    const result = await searchRegistry("zzz-nonexistent-xxy", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("multi-token query scores across fields", async () => {
    const result = await searchRegistry("bun typescript starter", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    // openkit has all three in its tags
    expect(result.hits[0].id).toBe("npm:@itlackey/openkit");
  });

  test("author match works", async () => {
    const result = await searchRegistry("devperson", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].id).toBe("npm:generic-agent-utils");
  });
});

// ── Limit enforcement ───────────────────────────────────────────────────────

describe("limit enforcement", () => {
  test("limit: 1 returns at most 1 hit", async () => {
    const result = await searchRegistry("stash", {
      registries: [{ url: FIXTURE_URL }],
      limit: 1,
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeLessThanOrEqual(1);
  });

  test("limit: 0 falls back to default", async () => {
    const result = await searchRegistry("stash", {
      registries: [{ url: FIXTURE_URL }],
      limit: 0,
      fetch: fetchFixture,
    });
    // Should not crash, uses default of 20
    expect(result.hits.length).toBeLessThanOrEqual(20);
  });

  test("limit: NaN falls back to default", async () => {
    const result = await searchRegistry("stash", {
      registries: [{ url: FIXTURE_URL }],
      limit: NaN,
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeLessThanOrEqual(20);
  });
});

// ── Caching ─────────────────────────────────────────────────────────────────

describe("caching", () => {
  test("second call uses cached index (no network needed)", async () => {
    // Prove the cache path: the first call populates the index cache, then the
    // injected fetch is swapped for one that always throws. A second call that
    // still returns hits can only have read from cache.
    const url = FIXTURE_URL;

    const result1 = await searchRegistry("openkit", {
      registries: [{ url }],
      fetch: fetchFixture,
    });
    expect(result1.hits.length).toBeGreaterThan(0);

    const exploding: HttpClient = async () => {
      throw new Error("network is down");
    };
    const result2 = await searchRegistry("openkit", {
      registries: [{ url }],
      fetch: exploding,
    });
    expect(result2.hits.length).toBeGreaterThan(0);
    expect(result2.hits[0].id).toBe(result1.hits[0].id);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("error handling", () => {
  test("server error produces warning, not exception", async () => {
    const result = await searchRegistry("test", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fakeFetch({ [FIXTURE_URL]: { status: 500 } }),
    });
    expect(result.hits).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("HTTP 500");
  });

  test("unreachable server produces warning", async () => {
    const unreachable: HttpClient = async () => {
      throw new Error("connection refused");
    };
    const result = await searchRegistry("test", {
      registries: [{ url: "http://test.local/nonexistent" }],
      fetch: unreachable,
    });
    expect(result.hits).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  test("invalid JSON produces warning", async () => {
    const result = await searchRegistry("test", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fakeFetch({ [FIXTURE_URL]: "not json" }),
    });
    expect(result.hits).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });
});

// ── Multiple registries ─────────────────────────────────────────────────────

describe("multiple registries", () => {
  test("merges stashes from multiple registry URLs", async () => {
    const url1 = "http://test.local/index-1.json";
    const url2 = "http://test.local/index-2.json";
    const index1: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:stash-a",
          name: "Stash A",
          description: "First stash",
          ref: "stash-a",
          source: "npm",
          tags: ["deploy"],
        },
      ],
    };
    const index2: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "github:org/stash-b",
          name: "Stash B",
          description: "Second stash for deploy workflows",
          ref: "org/stash-b",
          source: "github",
          tags: ["deploy"],
        },
      ],
    };

    const result = await searchRegistry("deploy", {
      registries: [{ url: url1 }, { url: url2 }],
      fetch: fakeFetch({ [url1]: JSON.stringify(index1), [url2]: JSON.stringify(index2) }),
    });
    expect(result.hits.length).toBe(2);
    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("npm:stash-a");
    expect(ids).toContain("github:org/stash-b");
  });

  test("one failing registry does not block others", async () => {
    const goodUrl = "http://test.local/good.json";
    const badUrl = "http://test.local/bad.json";
    const goodIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:good-stash",
          name: "Good Stash",
          ref: "good-stash",
          source: "npm",
          tags: ["works"],
        },
      ],
    };

    const result = await searchRegistry("works", {
      registries: [{ url: goodUrl }, { url: badUrl }],
      fetch: fakeFetch({ [goodUrl]: JSON.stringify(goodIndex), [badUrl]: { status: 500 } }),
    });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].id).toBe("npm:good-stash");
    expect(result.warnings.length).toBe(1);
  });
});

// ── Hit shape ───────────────────────────────────────────────────────────────

describe("hit shape", () => {
  test("includes metadata fields from index", async () => {
    const result = await searchRegistry("openkit", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    const hit = result.hits.find((h) => h.id === "npm:@itlackey/openkit");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("npm");
    expect(hit?.title).toBe("@itlackey/openkit");
    expect(hit?.ref).toBe("@itlackey/openkit");
    expect(hit?.installRef).toBe("npm:@itlackey/openkit");
    expect(hit?.metadata?.version).toBe("1.2.0");
    expect(hit?.metadata?.author).toBe("itlackey");
    expect(hit?.metadata?.license).toBe("MIT");
    expect(hit?.metadata?.assetTypes).toBe("skill, script, command");
    expect(typeof hit?.score).toBe("number");
  });

  test("installRef is prefixed with source type for github stashes", async () => {
    const result = await searchRegistry("azure", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    const hit = result.hits.find((h) => h.id === "github:someone/azure-ops-stash");
    expect(hit).toBeDefined();
    expect(hit?.installRef).toBe("github:someone/azure-ops-stash");
  });

  test("legacy `curated` key in registry JSON parses and is silently ignored", async () => {
    // Spec §4.2: the legacy registry boolean `curated` is removed in v1.
    // Legacy index JSON containing it MUST parse without error and the key
    // MUST NOT appear on emitted hits.
    const result = await searchRegistry("itlackey", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    const legacyCuratedHit = result.hits.find((h) => h.id === "github:itlackey/dimm-city-stash");
    expect(legacyCuratedHit).toBeDefined();
    expect(legacyCuratedHit as unknown as Record<string, unknown>).not.toHaveProperty("curated");

    const autoHit = result.hits.find((h) => h.id === "npm:@itlackey/openkit");
    expect(autoHit).toBeDefined();
    expect(autoHit as unknown as Record<string, unknown>).not.toHaveProperty("curated");
  });
});

// ── Environment variable override ───────────────────────────────────────────

describe("AKM_REGISTRY_URL env var", () => {
  test("uses env var when no explicit URLs provided", async () => {
    process.env.AKM_REGISTRY_URL = FIXTURE_URL;
    const result = await searchRegistry("azure", { fetch: fetchFixture });
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("supports comma-separated URLs in env var", async () => {
    const extraUrl = "http://test.local/extra.json";
    const extraIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:extra-stash",
          name: "extra-stash",
          ref: "extra-stash",
          source: "npm",
          tags: ["azure"],
        },
      ],
    };
    process.env.AKM_REGISTRY_URL = `${FIXTURE_URL},${extraUrl}`;
    const result = await searchRegistry("azure", {
      fetch: fakeFetch({ [FIXTURE_URL]: JSON.stringify(FIXTURE_INDEX), [extraUrl]: JSON.stringify(extraIndex) }),
    });
    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("github:someone/azure-ops-stash");
    expect(ids).toContain("npm:extra-stash");
  });

  // Problem A: env-based override must preserve provider type
  test("provider::url syntax routes to the declared provider type", async () => {
    const skillsUrl = "http://test.local/skills";
    process.env.AKM_REGISTRY_URL = `skills-sh::${skillsUrl}`;
    const result = await searchRegistry("my-skill", {
      fetch: fakeFetch({
        [skillsUrl]: skillsBody([{ id: "org/tools/my-skill", name: "my-skill", installs: 200, source: "org/tools" }]),
      }),
    });
    // skills-sh provider should have handled this — hits use skills-sh id format
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe("skills-sh:org/tools/my-skill");
    expect(result.hits[0].installRef).toBe("github:org/tools");
    expect(result.warnings).toEqual([]);
  });

  test("bare URL in env var defaults to static-index provider", async () => {
    process.env.AKM_REGISTRY_URL = FIXTURE_URL;
    const result = await searchRegistry("openkit", { fetch: fetchFixture });
    expect(result.hits.length).toBeGreaterThan(0);
    // static-index uses the stash id directly
    expect(result.hits[0].id).toBe("npm:@itlackey/openkit");
  });

  test("unknown provider type in env var produces warning, not crash", async () => {
    process.env.AKM_REGISTRY_URL = `no-such-provider::http://test.local/index.json`;
    const result = await searchRegistry("anything");
    expect(result.hits).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("no-such-provider");
  });

  test("mixed provider types in comma-separated env var", async () => {
    const staticUrl = "http://test.local/static.json";
    const skillsUrl = "http://test.local/skills";
    const staticIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:env-static-stash",
          name: "env-static-stash",
          ref: "env-static-stash",
          source: "npm",
          tags: ["deploy"],
        },
      ],
    };
    process.env.AKM_REGISTRY_URL = `${staticUrl},skills-sh::${skillsUrl}`;
    const result = await searchRegistry("env", {
      fetch: fakeFetch({
        [staticUrl]: JSON.stringify(staticIndex),
        [skillsUrl]: skillsBody([
          { id: "user/tools/env-skill", name: "env-skill", installs: 100, source: "user/tools" },
        ]),
      }),
    });
    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("npm:env-static-stash");
    expect(ids).toContain("skills-sh:user/tools/env-skill");
    expect(result.warnings).toEqual([]);
  });
});

// ── Score normalization (Problem B) ─────────────────────────────────────────

describe("cross-provider score normalization", () => {
  test("scores from all providers are in [0, 1] after normalization", async () => {
    // static-index raw scores can exceed 1 (e.g. exact name + tag + description).
    // After normalization, all scores in the merged response must be <= 1.
    const result = await searchRegistry("openkit bun typescript starter", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    for (const hit of result.hits) {
      if (hit.score !== undefined) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    }
  });

  test("top hit within a provider batch retains score = 1 after normalization", async () => {
    // The highest-scored hit in each provider batch should map to exactly 1.0.
    const result = await searchRegistry("openkit", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    const topScore = result.hits[0].score;
    expect(topScore).toBe(1);
  });

  test("merged multi-provider results are ordered by normalized score", async () => {
    // Provider A: static-index with a moderate-relevance match.
    // Provider B: skills-sh with a high-installs match.
    // After normalization each batch has max=1; the better-matched kit wins.
    const staticUrl = "http://test.local/static.json";
    const skillsUrl = "http://test.local/skills";
    const staticIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:exact-name-match",
          name: "deploy",
          description: "exact match",
          ref: "exact-name-match",
          source: "npm",
          tags: ["deploy"],
        },
        {
          id: "npm:partial-match",
          name: "deployment-helper",
          description: "partial",
          ref: "partial-match",
          source: "npm",
          tags: [],
        },
      ],
    };
    const result = await searchRegistry("deploy", {
      registries: [{ url: staticUrl }, { url: skillsUrl, provider: "skills-sh" }],
      fetch: fakeFetch({
        [staticUrl]: JSON.stringify(staticIndex),
        [skillsUrl]: skillsBody([
          { id: "org/deploy-skill", name: "deploy-skill", installs: 1000, source: "org/deploy-skill" },
          { id: "org/other-skill", name: "other-skill", installs: 100, source: "org/other" },
        ]),
      }),
    });
    // All scores in [0, 1]
    for (const hit of result.hits) {
      if (hit.score !== undefined) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    }
    // Results should be sorted descending
    for (let i = 1; i < result.hits.length; i++) {
      expect((result.hits[i - 1].score ?? 0) >= (result.hits[i].score ?? 0)).toBe(true);
    }
  });

  test("single-hit provider batch normalizes to score 1", async () => {
    const url = "http://test.local/only.json";
    const onlyIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:only-stash",
          name: "only-stash",
          description: "only one",
          ref: "only-stash",
          source: "npm",
          tags: ["unique"],
        },
      ],
    };
    const result = await searchRegistry("unique", {
      registries: [{ url }],
      fetch: fakeFetch({ [url]: JSON.stringify(onlyIndex) }),
    });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].score).toBe(1);
  });
});

// ── Provenance tagging ──────────────────────────────────────────────────────

describe("provenance tagging", () => {
  test("hits include registryName from entry config", async () => {
    const result = await searchRegistry("openkit", {
      registries: [{ url: FIXTURE_URL, name: "test-registry" }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].registryName).toBe("test-registry");
  });

  test("registryName is undefined when entry has no name", async () => {
    const result = await searchRegistry("openkit", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].registryName).toBeUndefined();
  });
});

// ── Provider-based routing ──────────────────────────────────────────────────

describe("provider routing", () => {
  test("unknown provider type produces warning, not crash", async () => {
    const result = await searchRegistry("test", {
      registries: [{ url: "http://test.local", provider: "nonexistent-type" }],
    });
    expect(result.hits).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("nonexistent-type");
  });

  test("mixed static-index and skills-sh registries return merged results", async () => {
    const staticUrl = "http://test.local/static.json";
    const skillsUrl = "http://test.local/skills";
    const staticIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:deploy-stash",
          name: "deploy-stash",
          description: "Deployment tools",
          ref: "deploy-stash",
          source: "npm",
          tags: ["deploy"],
        },
      ],
    };

    const result = await searchRegistry("deploy", {
      registries: [
        { url: staticUrl, name: "static" },
        { url: skillsUrl, name: "skills.sh", provider: "skills-sh" },
      ],
      fetch: fakeFetch({
        [staticUrl]: JSON.stringify(staticIndex),
        [skillsUrl]: skillsBody([
          { id: "org/skills/deploy-vercel", name: "deploy-vercel", installs: 500, source: "org/skills" },
        ]),
      }),
    });

    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("npm:deploy-stash");
    expect(ids).toContain("skills-sh:org/skills/deploy-vercel");

    // installRef should be directly usable with `akm add`
    const npmHit = result.hits.find((h) => h.id === "npm:deploy-stash");
    expect(npmHit?.installRef).toBe("npm:deploy-stash");
    const skillsHit = result.hits.find((h) => h.id === "skills-sh:org/skills/deploy-vercel");
    expect(skillsHit?.installRef).toBe("github:org/skills");

    expect(result.warnings).toEqual([]);
  });

  test("one provider fails, other succeeds — partial results + warning", async () => {
    const goodUrl = "http://test.local/good.json";
    const badUrl = "http://test.local/bad";
    const goodIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-01-01T00:00:00Z",
      stashes: [
        {
          id: "npm:good-stash",
          name: "good-stash",
          ref: "good-stash",
          source: "npm",
          tags: ["test"],
        },
      ],
    };

    const failing: HttpClient = async (input) => {
      const url = String(input);
      if (url.startsWith(goodUrl)) {
        return new Response(JSON.stringify(goodIndex), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error("connection refused");
    };

    const result = await searchRegistry("test", {
      registries: [
        { url: goodUrl, name: "good" },
        { url: badUrl, name: "bad", provider: "skills-sh" },
      ],
      fetch: failing,
    });

    expect(result.hits.length).toBe(1);
    expect(result.hits[0].id).toBe("npm:good-stash");
    expect(result.warnings.length).toBe(1);
  });

  test("default provider is static-index when omitted", async () => {
    // No provider field — should use static-index
    const result = await searchRegistry("openkit", {
      registries: [{ url: FIXTURE_URL }],
      fetch: fetchFixture,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe("npm:@itlackey/openkit");
  });
});

// ── Issue #159: incomplete hits must never appear in JSON output ────────────

describe("incomplete hits filter (#159)", () => {
  test("hits missing required fields are dropped from response", async () => {
    const { registerProvider } = await import("../src/registry/factory");
    const goodHit = {
      source: "github" as const,
      id: "github:owner/good",
      title: "Good Hit",
      ref: "github:owner/good",
      installRef: "github:owner/good",
    };
    registerProvider("incomplete-hits-test", (() => ({
      type: "incomplete-hits-test",
      async search() {
        return {
          // {} = empty placeholder; missing-id = partial; goodHit = valid
          hits: [{} as never, { source: "github", title: "x" } as never, goodHit],
        };
      },
    })) as unknown as Parameters<typeof registerProvider>[1]);

    const result = await searchRegistry("anything", {
      registries: [{ url: "http://test.local/unused", provider: "incomplete-hits-test" }],
    });

    expect(result.hits).toEqual([goodHit]);
    expect(result.hits.every((h) => h && typeof h === "object" && Object.keys(h).length > 0)).toBe(true);
    expect(result.warnings.some((w) => /incomplete hit/i.test(w))).toBe(true);
  });

  test("incomplete asset hits are dropped from assetHits", async () => {
    const { registerProvider } = await import("../src/registry/factory");
    registerProvider("incomplete-assets-test", (() => ({
      type: "incomplete-assets-test",
      async search() {
        return {
          hits: [],
          assetHits: [
            {} as never,
            { type: "registry-asset", assetType: "skill" } as never,
            {
              type: "registry-asset" as const,
              assetType: "skill",
              assetName: "deploy",
              action: "akm show skill:deploy",
              stash: { id: "x", name: "x" },
            },
          ],
        };
      },
    })) as unknown as Parameters<typeof registerProvider>[1]);

    const result = await searchRegistry("anything", {
      registries: [{ url: "http://test.local/unused", provider: "incomplete-assets-test" }],
    });

    expect(result.assetHits).toBeDefined();
    expect(result.assetHits?.length).toBe(1);
    expect(result.assetHits?.[0].assetName).toBe("deploy");
  });

  // PR #168 review #9: asset hits with missing/empty `stash.id` or `stash.name`
  // are also incomplete and must not propagate to JSON output.
  test("asset hits with missing or empty stash fields are dropped", async () => {
    const { registerProvider } = await import("../src/registry/factory");
    registerProvider("incomplete-stash-test", (() => ({
      type: "incomplete-stash-test",
      async search() {
        return {
          hits: [],
          assetHits: [
            // stash entirely missing
            {
              type: "registry-asset",
              assetType: "skill",
              assetName: "no-stash",
              action: "akm show skill:no-stash",
            } as never,
            // stash present but id is empty
            {
              type: "registry-asset",
              assetType: "skill",
              assetName: "empty-id",
              action: "akm show skill:empty-id",
              stash: { id: "", name: "x" },
            } as never,
            // stash present but name is missing
            {
              type: "registry-asset",
              assetType: "skill",
              assetName: "no-name",
              action: "akm show skill:no-name",
              stash: { id: "x" },
            } as never,
            // valid — only this one should survive
            {
              type: "registry-asset" as const,
              assetType: "skill",
              assetName: "good",
              action: "akm show skill:good",
              stash: { id: "x", name: "x" },
            },
          ],
        };
      },
    })) as unknown as Parameters<typeof registerProvider>[1]);

    const result = await searchRegistry("anything", {
      registries: [{ url: "http://test.local/unused", provider: "incomplete-stash-test" }],
    });

    expect(result.assetHits?.length).toBe(1);
    expect(result.assetHits?.[0].assetName).toBe("good");
  });
});
