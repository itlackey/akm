import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { searchRegistry } from "../../../src/commands/read/registry-search";
import type { RegistryIndex } from "../../../src/registry/providers/static-index";
import { type Cleanup, sandboxEnvDir, sandboxXdgCacheHome } from "../../_helpers/sandbox";

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

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  // Registry indexes are disk-cached in index.db KEYED BY URL. The local test
  // servers get OS-assigned ports, and a recycled port would resurrect a
  // previous test's cached index (observed: a v2 query returning a stale v1
  // index — duplicate hits). A per-test AKM_DATA_DIR keeps the cache empty.
  const dataResult = sandboxEnvDir("akm-registry-v2-data", "AKM_DATA_DIR", cacheResult.cleanup);
  const originalRegistryUrl = process.env.AKM_REGISTRY_URL;
  delete process.env.AKM_REGISTRY_URL;
  envCleanup = () => {
    dataResult.cleanup();
    if (originalRegistryUrl === undefined) {
      delete process.env.AKM_REGISTRY_URL;
    } else {
      process.env.AKM_REGISTRY_URL = originalRegistryUrl;
    }
  };
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Parser: v1 index compatibility ──────────────────────────────────────────

describe("parser: v1 index compatibility", () => {
  test("v1 index without assets parses and searches correctly", async () => {
    const srv = serveIndex(V1_INDEX);
    try {
      const result = await searchRegistry("legacy", { registries: [{ url: srv.url }] });
      expect(result.warnings).toEqual([]);
      expect(result.hits.length).toBe(1);
      expect(result.hits[0]!.id).toBe("npm:legacy-stash");
      expect(result.hits[0]!.title).toBe("Legacy Stash");
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
      expect(result.hits[0]!.id).toBe("github:owner/my-stash");
    } finally {
      srv.close();
    }
  });
});

// ── Install refs ────────────────────────────────────────────────────────────

describe("install refs", () => {
  test("local source stash uses file: prefix in installRef", async () => {
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
        },
      ],
    };
    const srv = serveIndex(localIndex);
    try {
      const result = await searchRegistry("local", { registries: [{ url: srv.url }] });
      expect(result.warnings).toEqual([]);
      expect(result.hits.length).toBe(1);
      // Local source should use file: prefix, not "github:"
      expect(result.hits[0]!.installRef).toBe("file:/home/user/stashes/my-local-stash");
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
      const result = await searchRegistry("plain", { registries: [{ url: srv.url }] });
      expect(result.hits.length).toBe(1);
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
      const result = await searchRegistry("empty", { registries: [{ url: srv.url }] });
      expect(result.hits.length).toBe(1);
    } finally {
      srv.close();
    }
  });

  test("asset entries with invalid structure do not break the stash hit", async () => {
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
      const result = await searchRegistry("bad", { registries: [{ url: srv.url }] });
      expect(result.warnings).toEqual([]);
      expect(result.hits.length).toBe(1);
      expect(result.hits[0]!.id).toBe("npm:bad-assets");
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
      });
      // Both v1 stash hits and v2 stash hits should be present
      const ids = result.hits.map((h) => h.id);
      expect(ids).toContain("npm:legacy-stash");
      expect(ids).toContain("github:owner/my-stash");
    } finally {
      srv1.close();
      srv2.close();
    }
  });
});
