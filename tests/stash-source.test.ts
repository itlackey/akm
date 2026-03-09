import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveStashSources, resolveAllStashDirs, findSourceForPath } from "../src/stash-source"
import { saveConfig } from "../src/config"

const originalStashDir = process.env.AGENTIKIT_STASH_DIR
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
let testConfigDir = ""
let stashDir = ""

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-source-config-"))
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-source-stash-"))
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
  }
  process.env.XDG_CONFIG_HOME = testConfigDir
  process.env.AGENTIKIT_STASH_DIR = stashDir
})

afterEach(() => {
  process.env.AGENTIKIT_STASH_DIR = originalStashDir ?? undefined
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  if (testConfigDir) fs.rmSync(testConfigDir, { recursive: true, force: true })
  if (stashDir) fs.rmSync(stashDir, { recursive: true, force: true })
})

describe("resolveStashSources", () => {
  test("returns working stash as first source", () => {
    saveConfig({ semanticSearch: false, mountedStashDirs: [] })
    const sources = resolveStashSources()
    expect(sources.length).toBeGreaterThanOrEqual(1)
    expect(sources[0].kind).toBe("working")
    expect(sources[0].writable).toBe(true)
    expect(sources[0].path).toBe(stashDir)
  })

  test("includes valid mounted directories", () => {
    const mountedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-mounted-"))
    try {
      saveConfig({ semanticSearch: false, mountedStashDirs: [mountedDir] })
      const sources = resolveStashSources()
      const mounted = sources.find((s) => s.kind === "mounted")
      expect(mounted).toBeDefined()
      expect(mounted!.path).toBe(mountedDir)
      expect(mounted!.writable).toBe(false)
    } finally {
      fs.rmSync(mountedDir, { recursive: true, force: true })
    }
  })

  test("skips non-existent mounted directories", () => {
    saveConfig({ semanticSearch: false, mountedStashDirs: ["/nonexistent/path/should/not/exist"] })
    const sources = resolveStashSources()
    expect(sources.length).toBe(1)
    expect(sources[0].kind).toBe("working")
  })

  test("includes installed registry entries", () => {
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-installed-"))
    try {
      saveConfig({
        semanticSearch: false,
        mountedStashDirs: [],
        registry: {
          installed: [{
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: installedDir,
            cacheDir: installedDir,
            installedAt: new Date().toISOString(),
          }],
        },
      })
      const sources = resolveStashSources()
      const installed = sources.find((s) => s.kind === "installed")
      expect(installed).toBeDefined()
      expect(installed!.path).toBe(installedDir)
      expect(installed!.registryId).toBe("npm:test-pkg")
      expect(installed!.writable).toBe(false)
    } finally {
      fs.rmSync(installedDir, { recursive: true, force: true })
    }
  })

  test("preserves three-tier ordering: working, mounted, installed", () => {
    const mountedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-mounted-"))
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-installed-"))
    try {
      saveConfig({
        semanticSearch: false,
        mountedStashDirs: [mountedDir],
        registry: {
          installed: [{
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: installedDir,
            cacheDir: installedDir,
            installedAt: new Date().toISOString(),
          }],
        },
      })
      const sources = resolveStashSources()
      expect(sources[0].kind).toBe("working")
      expect(sources[1].kind).toBe("mounted")
      expect(sources[2].kind).toBe("installed")
    } finally {
      fs.rmSync(mountedDir, { recursive: true, force: true })
      fs.rmSync(installedDir, { recursive: true, force: true })
    }
  })

  test("accepts overrideStashDir parameter", () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-override-"))
    try {
      saveConfig({ semanticSearch: false, mountedStashDirs: [] })
      const sources = resolveStashSources(overrideDir)
      expect(sources[0].kind).toBe("working")
      expect(sources[0].path).toBe(overrideDir)
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true })
    }
  })
})

describe("resolveAllStashDirs", () => {
  test("returns just paths in correct order", () => {
    saveConfig({ semanticSearch: false, mountedStashDirs: [] })
    const dirs = resolveAllStashDirs()
    expect(dirs[0]).toBe(stashDir)
  })
})

describe("findSourceForPath", () => {
  test("finds working source for file inside working stash", () => {
    const sources = [
      { kind: "working" as const, path: stashDir, writable: true },
      { kind: "mounted" as const, path: "/other/dir", writable: false },
    ]
    const filePath = path.join(stashDir, "tools", "deploy.sh")
    const result = findSourceForPath(filePath, sources)
    expect(result).toBeDefined()
    expect(result!.kind).toBe("working")
  })

  test("finds mounted source for file inside mounted dir", () => {
    const mountedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-mounted-"))
    try {
      const sources = [
        { kind: "working" as const, path: stashDir, writable: true },
        { kind: "mounted" as const, path: mountedDir, writable: false },
      ]
      const filePath = path.join(mountedDir, "tools", "test.sh")
      const result = findSourceForPath(filePath, sources)
      expect(result).toBeDefined()
      expect(result!.kind).toBe("mounted")
    } finally {
      fs.rmSync(mountedDir, { recursive: true, force: true })
    }
  })

  test("returns undefined for file not in any source", () => {
    const sources = [
      { kind: "working" as const, path: stashDir, writable: true },
    ]
    const result = findSourceForPath("/completely/unrelated/path.sh", sources)
    expect(result).toBeUndefined()
  })
})
