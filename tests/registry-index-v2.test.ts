import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegistryIndex } from "../src/commands/registry-search";
import { searchRegistry } from "../src/commands/registry-search";

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

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-v2-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
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

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalRegistryUrl = process.env.AKM_REGISTRY_URL;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-v2-cache-");
  delete process.env.AKM_REGISTRY_URL;
});

afterEach(() => {
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

// ── Parser: v1 index compatibility ──────────────────────────────────────────

describe("parser: v1 index compatibility", () => {
  test("v1 index without assets parses and searches correctly", async () => {
    const srv = serveIndex(V1_INDEX);
    try {
      const result = await searchRegistry("legacy", { registries: [{ url: srv.url }] });
      expect(result.warnings).toEqual([]);
      expect(result.hits.length).toBe(1);
      expect(result.hits[0].id).toBe("npm:legacy-stash");
      expect(result.hits[0].title).toBe("Legacy Stash");
    } finally {
      srv.close();
    }
  });

  test("v1 index returns no assetHits even when includeAssets is true", async () => {
    const srv = serveIndex(V1_INDEX);
    try {
      const result = await searchRegistry("legacy", { registries: [{ url: srv.url }], includeAssets: true });
      expect(result.hits.length).toBe(1);
      expect(result.assetHits).toBeUndefined();
    } finally {
      srv.close();
    }
  });
});

// ── Parser: v2 index with assets ────────────────────────────────────────────

describe("parser: v2 index with assets", () => {
  test("v2 index parses stashes with assets", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("automation", { registries: [{ url: srv.url }] });
      expect(result.warnings).toEqual([]);
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0].id).toBe("github:owner/my-stash");
    } finally {
      srv.close();
    }
  });

  test("v2 index returns assetHits when includeAssets is true", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("deploy", { registries: [{ url: srv.url }], includeAssets: true });
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
    } finally {
      srv.close();
    }
  });
});

// ── Asset-level search ──────────────────────────────────────────────────────

describe("asset-level search", () => {
  test("asset search returns hits with stash provenance", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("code-review", {
        registries: [{ url: srv.url, name: "test-reg" }],
        includeAssets: true,
      });
      expect(result.warnings).toEqual([]);
      expect(result.assetHits).toBeDefined();
      const reviewHit = result.assetHits?.find((h) => h.assetName === "code-review");
      expect(reviewHit).toBeDefined();
      expect(reviewHit?.stash.id).toBe("github:owner/my-stash");
      expect(reviewHit?.registryName).toBe("test-reg");
    } finally {
      srv.close();
    }
  });

  test("stashes without assets are silently skipped in asset search", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("utility", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      // "utility" matches the no-assets-stash but not any asset
      // Asset hits should not include anything from stashes without assets
      expect(result.assetHits).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  test("stashes with empty assets array are silently skipped in asset search", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("test", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      // "test" only matches the empty-assets-stash tag, which has no assets
      expect(result.assetHits).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  test("no asset hits when includeAssets is false (default)", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("deploy", { registries: [{ url: srv.url }] });
      expect(result.assetHits).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  test("asset search scores by name match", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("deploy.sh", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      expect(result.assetHits).toBeDefined();
      expect(result.assetHits?.length).toBeGreaterThan(0);
      // The deploy.sh asset should score higher than code-review for this query
      expect(result.assetHits?.[0].assetName).toBe("deploy.sh");
    } finally {
      srv.close();
    }
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
    const srv = serveIndex(localIndex);
    try {
      const result = await searchRegistry("setup", {
        registries: [{ url: srv.url }],
        includeAssets: true,
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
    } finally {
      srv.close();
    }
  });

  test("asset search scores by tag match", async () => {
    const srv = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("quality", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      expect(result.assetHits).toBeDefined();
      const qualityHit = result.assetHits?.find((h) => h.assetName === "code-review");
      expect(qualityHit).toBeDefined();
    } finally {
      srv.close();
    }
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
    const srv = serveIndex(index);
    try {
      const result = await searchRegistry("plain", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      expect(result.hits.length).toBe(1);
      // No asset hits because the stash has no assets
      expect(result.assetHits).toBeUndefined();
    } finally {
      srv.close();
    }
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
    const srv = serveIndex(index);
    try {
      const result = await searchRegistry("empty", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      expect(result.hits.length).toBe(1);
      expect(result.assetHits).toBeUndefined();
    } finally {
      srv.close();
    }
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
    const srv = serveIndex(index);
    try {
      const result = await searchRegistry("good", {
        registries: [{ url: srv.url }],
        includeAssets: true,
      });
      expect(result.assetHits).toBeDefined();
      expect(result.assetHits?.length).toBe(1);
      expect(result.assetHits?.[0].assetName).toBe("good.sh");
    } finally {
      srv.close();
    }
  });

  test("v1 and v2 indexes from different registries merge correctly", async () => {
    const srv1 = serveIndex(V1_INDEX);
    const srv2 = serveIndex(V2_INDEX);
    try {
      const result = await searchRegistry("deploy", {
        registries: [
          { url: srv1.url, name: "v1-reg" },
          { url: srv2.url, name: "v2-reg" },
        ],
        includeAssets: true,
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
    } finally {
      srv1.close();
      srv2.close();
    }
  });
});
