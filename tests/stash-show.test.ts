import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentikitShow } from "../src/stash-show"
import { saveConfig } from "../src/config"

const createdTmpDirs: string[] = []

function createTmpDir(prefix = "agentikit-show-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdTmpDirs.push(dir)
  return dir
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
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
  testCacheDir = createTmpDir("agentikit-show-cache-")
  testConfigDir = createTmpDir("agentikit-show-config-")
  stashDir = createTmpDir("agentikit-show-stash-")
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

// ── Installed ref with missing asset ─────────────────────────────────────────

describe("agentikitShow installed ref", () => {
  test("throws with installCmd when registryId present and asset not found", async () => {
    const installedStashRoot = createTmpDir("agentikit-show-installed-root-")
    // Create the type subdirectory so it is a valid stash root, but do NOT
    // create the actual asset file.
    fs.mkdirSync(path.join(installedStashRoot, "tools"), { recursive: true })

    saveConfig({
      semanticSearch: false,
      mountedStashDirs: [],
      registry: {
        installed: [{
          id: "test-pkg",
          source: "npm",
          ref: "test-pkg",
          artifactUrl: "https://example.com/test-pkg.tgz",
          stashRoot: installedStashRoot,
          cacheDir: installedStashRoot,
          installedAt: new Date().toISOString(),
        }],
      },
    })

    // Use an origin that is NOT installed so resolveSourcesForOrigin returns
    // empty, triggering the installCmd error path.
    await expect(
      agentikitShow({ ref: "npm:@other/missing-pkg//tool:missing.sh" }),
    ).rejects.toThrow(/akm add/)
  })
})

// ── Mounted stash resolution ─────────────────────────────────────────────────

describe("agentikitShow mounted stash", () => {
  test("resolves from mounted stash directories", async () => {
    const mountedStashDir = createTmpDir("agentikit-show-mounted-")
    writeFile(
      path.join(mountedStashDir, "tools", "deploy.sh"),
      "#!/usr/bin/env bash\necho deploy\n",
    )

    saveConfig({ semanticSearch: false, mountedStashDirs: [mountedStashDir] })

    const result = await agentikitShow({ ref: "tool:deploy.sh" })

    expect(result.type).toBe("tool")
    expect(result.name).toBe("deploy.sh")
    expect(result.path).toContain(mountedStashDir)
  })
})

// ── sourceKind and editable flags ────────────────────────────────────────────

describe("agentikitShow sourceKind and editable", () => {
  test("working stash asset has editable true", async () => {
    writeFile(
      path.join(stashDir, "tools", "local.sh"),
      "#!/usr/bin/env bash\necho local\n",
    )

    saveConfig({ semanticSearch: false, mountedStashDirs: [] })

    const result = await agentikitShow({ ref: "tool:local.sh" })

    expect(result.type).toBe("tool")
    expect(result.editable).toBe(true)
  })

  test("mounted stash asset has editable false", async () => {
    const mountedStashDir = createTmpDir("agentikit-show-mounted-editable-")
    writeFile(
      path.join(mountedStashDir, "tools", "remote.sh"),
      "#!/usr/bin/env bash\necho remote\n",
    )

    saveConfig({ semanticSearch: false, mountedStashDirs: [mountedStashDir] })

    // The asset only exists in the mounted dir, not in working stash.
    const result = await agentikitShow({ ref: "tool:remote.sh" })

    expect(result.type).toBe("tool")
    expect(result.editable).toBe(false)
  })

  test("resolves from installed stash directories", async () => {
    const installedStashRoot = createTmpDir("agentikit-show-installed-resolve-")
    writeFile(
      path.join(installedStashRoot, "tools", "deploy.sh"),
      "#!/usr/bin/env bash\necho deploy\n",
    )

    saveConfig({
      semanticSearch: false,
      mountedStashDirs: [],
      registry: {
        installed: [{
          id: "installed-pkg",
          source: "npm",
          ref: "npm:installed-pkg",
          artifactUrl: "https://example.com/installed-pkg.tgz",
          stashRoot: installedStashRoot,
          cacheDir: installedStashRoot,
          installedAt: new Date().toISOString(),
        }],
      },
    })

    const result = await agentikitShow({ ref: "tool:deploy.sh" })

    expect(result.type).toBe("tool")
    expect(result.editable).toBe(false)
  })
})
