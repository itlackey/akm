import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentikitList, agentikitRemove, agentikitUpdate } from "../src/stash-registry"
import { saveConfig, loadConfig } from "../src/config"

const createdTmpDirs: string[] = []

function createTmpDir(prefix = "agentikit-registry-"): string {
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
const originalStashDir = process.env.AKM_STASH_DIR
let testCacheDir = ""
let testConfigDir = ""
let stashDir = ""

beforeEach(() => {
  testCacheDir = createTmpDir("agentikit-registry-cache-")
  testConfigDir = createTmpDir("agentikit-registry-config-")
  stashDir = createTmpDir("agentikit-registry-stash-")
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
  }
  process.env.XDG_CACHE_HOME = testCacheDir
  process.env.XDG_CONFIG_HOME = testConfigDir
  process.env.AKM_STASH_DIR = stashDir
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
  if (originalStashDir === undefined) {
    delete process.env.AKM_STASH_DIR
  } else {
    process.env.AKM_STASH_DIR = originalStashDir
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true })
    testCacheDir = ""
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true })
    testConfigDir = ""
  }
})

// ── agentikitList ────────────────────────────────────────────────────────────

describe("agentikitList", () => {
  test("returns empty list when no registry installed", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] })

    const result = await agentikitList({ stashDir })

    expect(result.totalInstalled).toBe(0)
    expect(result.installed).toEqual([])
    expect(result.stashDir).toBe(stashDir)
  })

  test("returns installed entries with status", async () => {
    const cacheDir = createTmpDir("agentikit-registry-cache-entry-")
    const stashRoot = createTmpDir("agentikit-registry-stashroot-")

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      registry: {
        installed: [{
          id: "test-pkg",
          source: "npm",
          ref: "test-pkg",
          artifactUrl: "https://example.com/test-pkg.tgz",
          stashRoot: stashRoot,
          cacheDir: cacheDir,
          installedAt: new Date().toISOString(),
        }],
      },
    })

    const result = await agentikitList({ stashDir })

    expect(result.totalInstalled).toBe(1)
    expect(result.installed.length).toBe(1)
    expect(result.installed[0].id).toBe("test-pkg")
    expect(result.installed[0].source).toBe("npm")
    expect(result.installed[0].ref).toBe("test-pkg")
    expect(result.installed[0].status.cacheDirExists).toBe(true)
    expect(result.installed[0].status.stashRootExists).toBe(true)
  })

  test("reports missing directories in status", async () => {
    const nonExistentCache = path.join(os.tmpdir(), "agentikit-nonexistent-cache-" + Date.now())
    const nonExistentStashRoot = path.join(os.tmpdir(), "agentikit-nonexistent-root-" + Date.now())

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      registry: {
        installed: [{
          id: "missing-pkg",
          source: "npm",
          ref: "missing-pkg",
          artifactUrl: "https://example.com/missing-pkg.tgz",
          stashRoot: nonExistentStashRoot,
          cacheDir: nonExistentCache,
          installedAt: new Date().toISOString(),
        }],
      },
    })

    const result = await agentikitList({ stashDir })

    expect(result.totalInstalled).toBe(1)
    expect(result.installed[0].status.cacheDirExists).toBe(false)
    expect(result.installed[0].status.stashRootExists).toBe(false)
  })
})

// ── agentikitRemove ──────────────────────────────────────────────────────────

describe("agentikitRemove", () => {
  test("throws for empty target", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] })

    await expect(
      agentikitRemove({ target: "", stashDir }),
    ).rejects.toThrow("Target is required.")
  })

  test("throws for whitespace-only target", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] })

    await expect(
      agentikitRemove({ target: "   ", stashDir }),
    ).rejects.toThrow("Target is required.")
  })

  test("throws for unknown target", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] })

    await expect(
      agentikitRemove({ target: "nonexistent-package", stashDir }),
    ).rejects.toThrow("No installed registry entry matched target")
  })

  test("removes entry by id", async () => {
    const cacheDir = createTmpDir("agentikit-registry-remove-cache-")
    const stashRoot = createTmpDir("agentikit-registry-remove-root-")
    for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true })
    }

    const entry = {
      id: "test-pkg",
      source: "npm" as const,
      ref: "npm:test-pkg",
      artifactUrl: "https://example.com/test.tgz",
      stashRoot,
      cacheDir,
      installedAt: new Date().toISOString(),
    }

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      registry: { installed: [entry] },
    })

    const result = await agentikitRemove({ target: entry.id, stashDir })

    expect(result.removed.id).toBe(entry.id)

    const config = loadConfig()
    const remaining = config.registry?.installed ?? []
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined()
  })

  test("removes entry by ref", async () => {
    const cacheDir = createTmpDir("agentikit-registry-remove-cache-ref-")
    const stashRoot = createTmpDir("agentikit-registry-remove-root-ref-")
    for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true })
    }

    const entry = {
      id: "test-pkg-ref",
      source: "npm" as const,
      ref: "npm:test-pkg-ref",
      artifactUrl: "https://example.com/test-ref.tgz",
      stashRoot,
      cacheDir,
      installedAt: new Date().toISOString(),
    }

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      registry: { installed: [entry] },
    })

    const result = await agentikitRemove({ target: entry.ref, stashDir })

    expect(result.removed.id).toBe(entry.id)

    const config = loadConfig()
    const remaining = config.registry?.installed ?? []
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined()
  })

  test("cleans up cache directory", async () => {
    const cacheDir = createTmpDir("agentikit-registry-remove-cache-cleanup-")
    const stashRoot = createTmpDir("agentikit-registry-remove-root-cleanup-")
    for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true })
    }

    const entry = {
      id: "test-pkg-cleanup",
      source: "npm" as const,
      ref: "npm:test-pkg-cleanup",
      artifactUrl: "https://example.com/test-cleanup.tgz",
      stashRoot,
      cacheDir,
      installedAt: new Date().toISOString(),
    }

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      registry: { installed: [entry] },
    })

    await agentikitRemove({ target: entry.id, stashDir })

    expect(fs.existsSync(cacheDir)).toBe(false)
  })
})

// ── selectTargets (tested via agentikitUpdate error paths) ────────────────

describe("selectTargets via agentikitUpdate", () => {
  test("throws when both target and all are specified", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] })

    await expect(
      agentikitUpdate({ target: "some-pkg", all: true, stashDir }),
    ).rejects.toThrow("Specify either <target> or --all, not both.")
  })

  test("throws when neither target nor all is specified", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] })

    await expect(
      agentikitUpdate({ stashDir }),
    ).rejects.toThrow("Either <target> or --all is required.")
  })

  test("--all selects all installed entries", async () => {
    const stashRoot = createTmpDir("agentikit-registry-all-root-")
    for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true })
    }

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      registry: {
        installed: [{
          id: "all-pkg-1",
          source: "npm" as const,
          ref: "npm:nonexistent-pkg-1",
          artifactUrl: "https://example.com/1.tgz",
          stashRoot,
          cacheDir: stashRoot,
          installedAt: new Date().toISOString(),
        }, {
          id: "all-pkg-2",
          source: "npm" as const,
          ref: "npm:nonexistent-pkg-2",
          artifactUrl: "https://example.com/2.tgz",
          stashRoot,
          cacheDir: stashRoot,
          installedAt: new Date().toISOString(),
        }],
      },
    })

    // selectTargets with all:true succeeds (returns both entries),
    // but installRegistryRef will fail for nonexistent packages.
    // The error should NOT be about selectTargets validation.
    try {
      await agentikitUpdate({ all: true, stashDir })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain("Either <target> or --all is required")
      expect(message).not.toContain("Specify either <target> or --all")
    }
  })
})
