import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { searchRegistry } from "../src/registry-search"
import type { RegistryIndex } from "../src/registry-search"

// ── Test fixtures ───────────────────────────────────────────────────────────

const FIXTURE_INDEX: RegistryIndex = {
  version: 1,
  updatedAt: "2026-03-09T00:00:00Z",
  kits: [
    {
      id: "npm:@itlackey/openkit",
      name: "@itlackey/openkit",
      description: "Starter kit for building OpenCode extensions with Bun.js",
      ref: "@itlackey/openkit",
      source: "npm",
      homepage: "https://github.com/itlackey/openkit-starter",
      tags: ["opencode", "bun", "typescript", "starter"],
      assetTypes: ["skill", "tool", "command"],
      author: "itlackey",
      license: "MIT",
      latestVersion: "1.2.0",
    },
    {
      id: "github:itlackey/dimm-city-kit",
      name: "Dimm City TTRPG Kit",
      description: "Agent skills for Dimm City creaturepunk TTRPG content generation",
      ref: "itlackey/dimm-city-kit",
      source: "github",
      tags: ["ttrpg", "dimm-city", "creaturepunk", "print", "markdown"],
      assetTypes: ["skill", "command", "knowledge"],
      author: "itlackey",
      license: "CC-BY-4.0",
      curated: true,
    },
    {
      id: "github:someone/azure-ops-kit",
      name: "Azure Ops Kit",
      description: "CLI skills for managing Azure Container Apps and DevOps",
      ref: "someone/azure-ops-kit",
      source: "github",
      tags: ["azure", "devops", "container-apps", "infrastructure"],
      assetTypes: ["skill", "tool"],
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = []

function createTmpDir(prefix = "agentikit-search-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdTmpDirs.push(dir)
  return dir
}

/** Start a minimal HTTP server that serves the fixture index. */
function serveIndex(index: RegistryIndex): { url: string; close: () => void } {
  const body = JSON.stringify(index)
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, {
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/index.json`,
    close: () => server.stop(true),
  }
}

/** Start a server that always returns an error. */
function serveError(status: number): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("error", { status })
    },
  })
  return {
    url: `http://localhost:${server.port}/index.json`,
    close: () => server.stop(true),
  }
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const originalRegistryUrl = process.env.AKM_REGISTRY_URL

beforeEach(() => {
  // Isolate cache per test
  process.env.XDG_CACHE_HOME = createTmpDir("agentikit-search-cache-")
  delete process.env.AKM_REGISTRY_URL
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  if (originalRegistryUrl === undefined) {
    delete process.env.AKM_REGISTRY_URL
  } else {
    process.env.AKM_REGISTRY_URL = originalRegistryUrl
  }
})

// ── Empty / blank queries ───────────────────────────────────────────────────

describe("searchRegistry", () => {
  test("returns empty for blank query", async () => {
    const result = await searchRegistry("")
    expect(result).toEqual({ query: "", hits: [], warnings: [] })
  })

  test("returns empty for whitespace query", async () => {
    const result = await searchRegistry("   ")
    expect(result).toEqual({ query: "", hits: [], warnings: [] })
  })
})

// ── Scoring and ranking ─────────────────────────────────────────────────────

describe("scoring", () => {
  test("exact name match ranks highest", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("Azure Ops Kit", {
        registryUrls: srv.url,
      })
      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits[0].id).toBe("github:someone/azure-ops-kit")
    } finally {
      srv.close()
    }
  })

  test("tag match surfaces relevant kits", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("creaturepunk", {
        registryUrls: srv.url,
      })
      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits[0].id).toBe("github:itlackey/dimm-city-kit")
    } finally {
      srv.close()
    }
  })

  test("description substring matches", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("Container Apps", {
        registryUrls: srv.url,
      })
      expect(result.hits.some((h) => h.id === "github:someone/azure-ops-kit")).toBe(true)
    } finally {
      srv.close()
    }
  })

  test("no match returns empty hits without error", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("zzz-nonexistent-xxy", {
        registryUrls: srv.url,
      })
      expect(result.hits).toEqual([])
      expect(result.warnings).toEqual([])
    } finally {
      srv.close()
    }
  })

  test("multi-token query scores across fields", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("bun typescript starter", {
        registryUrls: srv.url,
      })
      expect(result.hits.length).toBeGreaterThan(0)
      // openkit has all three in its tags
      expect(result.hits[0].id).toBe("npm:@itlackey/openkit")
    } finally {
      srv.close()
    }
  })

  test("author match works", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("devperson", {
        registryUrls: srv.url,
      })
      expect(result.hits.length).toBe(1)
      expect(result.hits[0].id).toBe("npm:generic-agent-utils")
    } finally {
      srv.close()
    }
  })
})

// ── Limit enforcement ───────────────────────────────────────────────────────

describe("limit enforcement", () => {
  test("limit: 1 returns at most 1 hit", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("kit", {
        registryUrls: srv.url,
        limit: 1,
      })
      expect(result.hits.length).toBeLessThanOrEqual(1)
    } finally {
      srv.close()
    }
  })

  test("limit: 0 falls back to default", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("kit", {
        registryUrls: srv.url,
        limit: 0,
      })
      // Should not crash, uses default of 20
      expect(result.hits.length).toBeLessThanOrEqual(20)
    } finally {
      srv.close()
    }
  })

  test("limit: NaN falls back to default", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("kit", {
        registryUrls: srv.url,
        limit: NaN,
      })
      expect(result.hits.length).toBeLessThanOrEqual(20)
    } finally {
      srv.close()
    }
  })
})

// ── Caching ─────────────────────────────────────────────────────────────────

describe("caching", () => {
  test("second call uses cached index (no network needed)", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    const url = srv.url

    // First call — fetches from server
    const result1 = await searchRegistry("openkit", { registryUrls: url })
    expect(result1.hits.length).toBeGreaterThan(0)

    // Kill the server
    srv.close()

    // Second call — should use cache
    const result2 = await searchRegistry("openkit", { registryUrls: url })
    expect(result2.hits.length).toBeGreaterThan(0)
    expect(result2.hits[0].id).toBe(result1.hits[0].id)
  })
})

// ── Error handling ──────────────────────────────────────────────────────────

describe("error handling", () => {
  test("server error produces warning, not exception", async () => {
    const srv = serveError(500)
    try {
      const result = await searchRegistry("test", { registryUrls: srv.url })
      expect(result.hits).toEqual([])
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0]).toContain("HTTP 500")
    } finally {
      srv.close()
    }
  })

  test("unreachable server produces warning", async () => {
    const result = await searchRegistry("test", {
      registryUrls: "http://127.0.0.1:1/nonexistent",
    })
    expect(result.hits).toEqual([])
    expect(result.warnings.length).toBe(1)
  })

  test("invalid JSON produces warning", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not json", {
          headers: { "Content-Type": "application/json" },
        })
      },
    })
    try {
      const result = await searchRegistry("test", {
        registryUrls: `http://localhost:${server.port}/index.json`,
      })
      expect(result.hits).toEqual([])
      expect(result.warnings.length).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})

// ── Multiple registries ─────────────────────────────────────────────────────

describe("multiple registries", () => {
  test("merges kits from multiple registry URLs", async () => {
    const index1: RegistryIndex = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "npm:kit-a",
          name: "Kit A",
          description: "First kit",
          ref: "kit-a",
          source: "npm",
          tags: ["deploy"],
        },
      ],
    }
    const index2: RegistryIndex = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "github:org/kit-b",
          name: "Kit B",
          description: "Second kit for deploy workflows",
          ref: "org/kit-b",
          source: "github",
          tags: ["deploy"],
        },
      ],
    }

    const srv1 = serveIndex(index1)
    const srv2 = serveIndex(index2)
    try {
      const result = await searchRegistry("deploy", {
        registryUrls: [srv1.url, srv2.url],
      })
      expect(result.hits.length).toBe(2)
      const ids = result.hits.map((h) => h.id)
      expect(ids).toContain("npm:kit-a")
      expect(ids).toContain("github:org/kit-b")
    } finally {
      srv1.close()
      srv2.close()
    }
  })

  test("one failing registry does not block others", async () => {
    const goodIndex: RegistryIndex = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "npm:good-kit",
          name: "Good Kit",
          ref: "good-kit",
          source: "npm",
          tags: ["works"],
        },
      ],
    }

    const good = serveIndex(goodIndex)
    const bad = serveError(500)
    try {
      const result = await searchRegistry("works", {
        registryUrls: [good.url, bad.url],
      })
      expect(result.hits.length).toBe(1)
      expect(result.hits[0].id).toBe("npm:good-kit")
      expect(result.warnings.length).toBe(1)
    } finally {
      good.close()
      bad.close()
    }
  })
})

// ── Hit shape ───────────────────────────────────────────────────────────────

describe("hit shape", () => {
  test("includes metadata fields from index", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("openkit", { registryUrls: srv.url })
      const hit = result.hits.find((h) => h.id === "npm:@itlackey/openkit")
      expect(hit).toBeDefined()
      expect(hit!.source).toBe("npm")
      expect(hit!.title).toBe("@itlackey/openkit")
      expect(hit!.ref).toBe("@itlackey/openkit")
      expect(hit!.metadata?.version).toBe("1.2.0")
      expect(hit!.metadata?.author).toBe("itlackey")
      expect(hit!.metadata?.license).toBe("MIT")
      expect(hit!.metadata?.assetTypes).toBe("skill, tool, command")
      expect(typeof hit!.score).toBe("number")
    } finally {
      srv.close()
    }
  })

  test("curated field is true for manual entries and undefined for auto-discovered", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    try {
      const result = await searchRegistry("itlackey", { registryUrls: srv.url })
      const curatedHit = result.hits.find((h) => h.id === "github:itlackey/dimm-city-kit")
      expect(curatedHit).toBeDefined()
      expect(curatedHit!.curated).toBe(true)

      const autoHit = result.hits.find((h) => h.id === "npm:@itlackey/openkit")
      expect(autoHit).toBeDefined()
      expect(autoHit!.curated).toBeUndefined()
    } finally {
      srv.close()
    }
  })
})

// ── Environment variable override ───────────────────────────────────────────

describe("AKM_REGISTRY_URL env var", () => {
  test("uses env var when no explicit URLs provided", async () => {
    const srv = serveIndex(FIXTURE_INDEX)
    process.env.AKM_REGISTRY_URL = srv.url
    try {
      const result = await searchRegistry("azure")
      expect(result.hits.length).toBeGreaterThan(0)
    } finally {
      srv.close()
    }
  })

  test("supports comma-separated URLs in env var", async () => {
    const srv1 = serveIndex(FIXTURE_INDEX)
    const srv2 = serveIndex({
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      kits: [
        {
          id: "npm:extra-kit",
          name: "extra-kit",
          ref: "extra-kit",
          source: "npm",
          tags: ["azure"],
        },
      ],
    })
    process.env.AKM_REGISTRY_URL = `${srv1.url},${srv2.url}`
    try {
      const result = await searchRegistry("azure")
      const ids = result.hits.map((h) => h.id)
      expect(ids).toContain("github:someone/azure-ops-kit")
      expect(ids).toContain("npm:extra-kit")
    } finally {
      srv1.close()
      srv2.close()
    }
  })
})
