import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { searchRegistry } from "../src/registry-search"

// ── XDG isolation ───────────────────────────────────────────────────────────

const createdTmpDirs: string[] = []

function createTmpDir(prefix = "agentikit-search-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdTmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("agentikit-search-cache-")
  process.env.XDG_CONFIG_HOME = createTmpDir("agentikit-search-config-")
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
})

// ── searchRegistry – blank / whitespace queries ─────────────────────────────

describe("searchRegistry", () => {
  test("returns empty for blank query", async () => {
    const result = await searchRegistry("")
    expect(result).toEqual({ query: "", hits: [], warnings: [] })
  })

  test("returns empty for whitespace query", async () => {
    const result = await searchRegistry("   ")
    expect(result).toEqual({ query: "", hits: [], warnings: [] })
  })

  // Integration test: requires network access to npm registry and GitHub API.
  // searchRegistry calls hardcoded external URLs so we cannot redirect to a
  // local mock server without refactoring the source.  The test verifies the
  // function never throws even when APIs fail or return unexpected data.
  test("handles npm/github failures gracefully (no exception thrown)", async () => {
    const result = await searchRegistry("agentikit-test-query")
    expect(result).toBeDefined()
    expect(result.query).toBe("agentikit-test-query")
    expect(Array.isArray(result.hits)).toBe(true)
    expect(Array.isArray(result.warnings)).toBe(true)
  })
})

// ── clampLimit enforcement (indirect — clampLimit is not exported) ────────────
// clampLimit: if (!limit || !Number.isFinite(limit)) return 20
//             return Math.min(100, Math.max(1, Math.trunc(limit)))
// We test indirectly via searchRegistry which uses clampLimit on the limit option.

describe("clampLimit enforcement via searchRegistry", () => {
  test("limit: 0 is treated as invalid and falls back to default", async () => {
    const result = await searchRegistry("test", { limit: 0 })
    expect(result).toBeDefined()
    // clampLimit(0) → 20 (falsy value triggers default)
    // No crash, results are bounded
    expect(Array.isArray(result.hits)).toBe(true)
    expect(result.hits.length).toBeLessThanOrEqual(40) // limit*2 = 40
  })

  test("limit: -5 is clamped to 1", async () => {
    const result = await searchRegistry("test", { limit: -5 })
    expect(result).toBeDefined()
    // clampLimit(-5) → Math.max(1, -5) = 1, hits ≤ limit*2 = 2
    expect(result.hits.length).toBeLessThanOrEqual(2)
  })

  test("limit: NaN falls back to default 20", async () => {
    const result = await searchRegistry("test", { limit: NaN })
    expect(result).toBeDefined()
    // clampLimit(NaN) → 20 (not finite triggers default)
    expect(result.hits.length).toBeLessThanOrEqual(40)
  })

  test("limit: Infinity falls back to default 20", async () => {
    const result = await searchRegistry("test", { limit: Infinity })
    expect(result).toBeDefined()
    // clampLimit(Infinity) → 20 (not finite triggers default)
    expect(result.hits.length).toBeLessThanOrEqual(40)
  })

  test("limit: 1 returns at most 2 hits (limit*2)", async () => {
    const result = await searchRegistry("test", { limit: 1 })
    expect(result).toBeDefined()
    expect(result.hits.length).toBeLessThanOrEqual(2)
  })
})
