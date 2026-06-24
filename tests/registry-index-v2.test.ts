import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RegistryIndex } from "../src/commands/read/registry-search";
import { searchRegistry } from "../src/commands/read/registry-search";
import type { HttpClient } from "../src/core/common";
import { type Cleanup, sandboxXdgCacheHome } from "./_helpers/sandbox";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const V1_INDEX: RegistryIndex = {
  version: 3,
  updatedAt: "2026-03-01T00:00:00Z",
  stashes: [
    {
      id: "npm:legacy-stash",
      name: "Legacy Stash",
      description: "A v1 stash without assets",
      ref: "legacy-stash",
      source: "npm",
      tags: ["legacy", "deploy"],
    },
  ],
};

const V2_INDEX: RegistryIndex = {
  version: 3,
  updatedAt: "2026-03-12T00:00:00Z",
  stashes: [
    {
      id: "github:owner/my-stash",
      name: "My Stash",
      description: "A stash with assets",
      ref: "owner/my-stash",
      source: "github",
      tags: ["automation", "deploy"],
      assets: [
        {
          type: "script",
          name: "deploy.sh",
          description: "Deploy the application",
          tags: ["deploy", "ci"],
          estimatedTokens: 64,
        },
        {
          type: "skill",
          name: "code-review",
          description: "Automated code review skill",
          tags: ["review", "quality"],
          estimatedTokens: 96,
        },
      ],
    },
    {
      id: "npm:no-assets-stash",
      name: "No Assets Stash",
      description: "A v2 stash without asset-level metadata",
      ref: "no-assets-stash",
      source: "npm",
      tags: ["utility"],
    },
    {
      id: "github:owner/empty-assets-stash",
      name: "Empty Assets Stash",
      description: "A stash with an empty assets array",
      ref: "owner/empty-assets-stash",
      source: "github",
      tags: ["test"],
      assets: [],
    },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Non-routable endpoints — the injected fetch never connects (#664 Seam 1).
// The static-index provider caches the parsed index in index.db keyed by URL,
// and that DB is not XDG-cache sandboxed, so each distinct index body needs a
// unique URL to avoid cache collisions (the old Bun.serve servers got this for
// free via unique ports). `uniqueUrl()` mints one per registry under test.
let urlCounter = 0;
function uniqueUrl(): string {
  return `http://test.local/reg-${urlCounter++}/index.json`;
}

/**
 * Build a registry under test: a unique non-routable URL plus a fake
 * HttpClient that serves the given index as JSON (mirroring the body the old
 * `Bun.serve` handler returned).
 */
function fakeRegistry(index: RegistryIndex): { url: string; fetch: HttpClient } {
  const url = uniqueUrl();
  return {
    url,
    fetch: async () =>
      new Response(JSON.stringify(index), {
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/**
 * Build a fake HttpClient that routes by URL to one of several indexes — used
 * for the multi-registry merge test where each URL must return its own body.
 */
function routedFetch(routes: Record<string, RegistryIndex>): HttpClient {
  return async (input) =>
    new Response(JSON.stringify(routes[String(input)]), {
      headers: { "Content-Type": "application/json" },
    });
}

const originalRegistryUrl = process.env.AKM_REGISTRY_URL;

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  envCleanup = cacheResult.cleanup;
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

// ── Parser: v1 index compatibility ──────────────────────────────────────────

describe("parser: v1 index compatibility", () => {
  test("v1 index without assets parses and searches correctly", async () => {
    const reg = fakeRegistry(V1_INDEX);
    const result = await searchRegistry("legacy", {
      registries: [{ url: reg.url }],
      fetch: reg.fetch,
    });
    expect(result.warnings).toEqual([]);
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].id).toBe("npm:legacy-stash");
    expect(result.hits[0].title).toBe("Legacy Stash");
  });

  test("v1 index returns no assetHits even when includeAssets is true", async () => {
    const reg = fakeRegistry(V1_INDEX);
    const result = await searchRegistry("legacy", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.hits.length).toBe(1);
    expect(result.assetHits).toBeUndefined();
  });
});

// ── Parser: v2 index with assets ────────────────────────────────────────────

describe("parser: v2 index with assets", () => {
  test("v2 index parses stashes with assets", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("automation", {
      registries: [{ url: reg.url }],
      fetch: reg.fetch,
    });
    expect(result.warnings).toEqual([]);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].id).toBe("github:owner/my-stash");
  });

  test("v2 index returns assetHits when includeAssets is true", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("deploy", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.warnings).toEqual([]);
    expect(result.assetHits).toBeDefined();
    expect(result.assetHits?.length).toBeGreaterThan(0);

    const deployHit = result.assetHits?.find((h) => h.assetName === "deploy.sh");
    expect(deployHit).toBeDefined();
    expect(deployHit?.type).toBe("registry-asset");
    expect(deployHit?.assetType).toBe("script");
    expect(deployHit?.description).toBe("Deploy the application");
    expect(deployHit?.estimatedTokens).toBe(64);
    expect(deployHit?.stash.id).toBe("github:owner/my-stash");
    expect(deployHit?.stash.name).toBe("My Stash");
    expect(deployHit?.action).toBe("akm add github:owner/my-stash");
  });
});

// ── Asset-level search ──────────────────────────────────────────────────────

describe("asset-level search", () => {
  test("asset search returns hits with stash provenance", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("code-review", {
      registries: [{ url: reg.url, name: "test-reg" }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.warnings).toEqual([]);
    expect(result.assetHits).toBeDefined();
    const reviewHit = result.assetHits?.find((h) => h.assetName === "code-review");
    expect(reviewHit).toBeDefined();
    expect(reviewHit?.stash.id).toBe("github:owner/my-stash");
    expect(reviewHit?.registryName).toBe("test-reg");
  });

  test("stashes without assets are silently skipped in asset search", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("utility", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    // "utility" matches the no-assets-stash but not any asset
    // Asset hits should not include anything from stashes without assets
    expect(result.assetHits).toBeUndefined();
  });

  test("stashes with empty assets array are silently skipped in asset search", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("test", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    // "test" only matches the empty-assets-stash tag, which has no assets
    expect(result.assetHits).toBeUndefined();
  });

  test("no asset hits when includeAssets is false (default)", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("deploy", {
      registries: [{ url: reg.url }],
      fetch: reg.fetch,
    });
    expect(result.assetHits).toBeUndefined();
  });

  test("asset search scores by name match", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("deploy.sh", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.assetHits).toBeDefined();
    expect(result.assetHits?.length).toBeGreaterThan(0);
    // The deploy.sh asset should score higher than code-review for this query
    expect(result.assetHits?.[0].assetName).toBe("deploy.sh");
  });

  test("local source stash uses file: prefix in action string", async () => {
    const localIndex: RegistryIndex = {
      version: 3,
      updatedAt: "2026-03-12T00:00:00Z",
      stashes: [
        {
          id: "local:my-local-stash",
          name: "Local Stash",
          description: "A stash from a local path",
          ref: "/home/user/stashes/my-local-stash",
          source: "local",
          tags: ["local", "dev"],
          assets: [
            {
              type: "script",
              name: "setup.sh",
              description: "Setup script for local development",
              tags: ["setup"],
            },
          ],
        },
      ],
    };
    const reg = fakeRegistry(localIndex);
    const result = await searchRegistry("setup", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.warnings).toEqual([]);
    expect(result.assetHits).toBeDefined();
    expect(result.assetHits?.length).toBe(1);
    const hit = result.assetHits?.[0];
    expect(hit).toBeDefined();
    expect(hit?.assetName).toBe("setup.sh");
    expect(hit?.stash.id).toBe("local:my-local-stash");
    // Local source should use file: prefix, not "github:"
    expect(hit?.action).toBe("akm add file:/home/user/stashes/my-local-stash");
    expect(hit?.action).not.toContain("github:");
  });

  test("asset search scores by tag match", async () => {
    const reg = fakeRegistry(V2_INDEX);
    const result = await searchRegistry("quality", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.assetHits).toBeDefined();
    const qualityHit = result.assetHits?.find((h) => h.assetName === "code-review");
    expect(qualityHit).toBeDefined();
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("missing assets field parsed as undefined", async () => {
    const index: RegistryIndex = {
      version: 3,
      updatedAt: "2026-03-12T00:00:00Z",
      stashes: [
        {
          id: "npm:plain-stash",
          name: "Plain Stash",
          ref: "plain-stash",
          source: "npm",
        },
      ],
    };
    const reg = fakeRegistry(index);
    const result = await searchRegistry("plain", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.hits.length).toBe(1);
    // No asset hits because the stash has no assets
    expect(result.assetHits).toBeUndefined();
  });

  test("empty assets array parsed correctly", async () => {
    const index: RegistryIndex = {
      version: 3,
      updatedAt: "2026-03-12T00:00:00Z",
      stashes: [
        {
          id: "npm:empty-assets",
          name: "Empty Assets",
          ref: "empty-assets",
          source: "npm",
          assets: [],
        },
      ],
    };
    const reg = fakeRegistry(index);
    const result = await searchRegistry("empty", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.hits.length).toBe(1);
    expect(result.assetHits).toBeUndefined();
  });

  test("asset with invalid structure is skipped", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
    const index: any = {
      version: 3,
      updatedAt: "2026-03-12T00:00:00Z",
      stashes: [
        {
          id: "npm:bad-assets",
          name: "Bad Assets Stash",
          ref: "bad-assets",
          source: "npm",
          assets: [
            { type: "script", name: "good.sh", description: "Valid asset" },
            { type: "script" }, // missing name
            { name: "orphan" }, // missing type
            42, // not an object
            null, // null
          ],
        },
      ],
    };
    const reg = fakeRegistry(index as RegistryIndex);
    const result = await searchRegistry("good", {
      registries: [{ url: reg.url }],
      includeAssets: true,
      fetch: reg.fetch,
    });
    expect(result.assetHits).toBeDefined();
    expect(result.assetHits?.length).toBe(1);
    expect(result.assetHits?.[0].assetName).toBe("good.sh");
  });

  test("v1 and v2 indexes from different registries merge correctly", async () => {
    const v1Url = uniqueUrl();
    const v2Url = uniqueUrl();
    const result = await searchRegistry("deploy", {
      registries: [
        { url: v1Url, name: "v1-reg" },
        { url: v2Url, name: "v2-reg" },
      ],
      includeAssets: true,
      fetch: routedFetch({ [v1Url]: V1_INDEX, [v2Url]: V2_INDEX }),
    });
    // Both v1 stash hits and v2 stash hits should be present
    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("npm:legacy-stash");
    expect(ids).toContain("github:owner/my-stash");

    // Asset hits should come only from v2
    expect(result.assetHits).toBeDefined();
    const assetKitIds = result.assetHits?.map((h) => h.stash.id);
    expect(assetKitIds).toContain("github:owner/my-stash");
    expect(assetKitIds).not.toContain("npm:legacy-stash");
  });
});
