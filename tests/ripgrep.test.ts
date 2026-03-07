import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveRg, isRgAvailable } from "../src/ripgrep"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-rg-"))
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

// ── resolveRg ───────────────────────────────────────────────────────────────

test("resolveRg finds system ripgrep on PATH", () => {
  const originalPath = process.env.PATH
  const stashDir = tmpDir()
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })

  // Create a fake rg binary on PATH so the test does not depend on the host environment
  const rgName = process.platform === "win32" ? "rg.cmd" : "rg"
  const fakeRg = path.join(binDir, rgName)
  const scriptContent =
    process.platform === "win32"
      ? "@echo off\r\necho fake rg\r\n"
      : "#!/bin/sh\necho fake rg\n"
  fs.writeFileSync(fakeRg, scriptContent)
  try {
    // Make sure the fake rg is executable where that concept applies
    if (process.platform !== "win32") {
      fs.chmodSync(fakeRg, 0o755)
    }
  } catch {
    // Ignore chmod errors on platforms/filesystems that do not support it
  }

  // Prepend the fake rg directory to PATH for this test only
  process.env.PATH = binDir + path.delimiter + (originalPath ?? "")
  try {
    const rg = resolveRg()
    expect(rg).not.toBeNull()
    expect(rg!).toContain("rg")
  } finally {
    process.env.PATH = originalPath
  }
})

test("resolveRg prefers stash/bin over system PATH", () => {
  const stashDir = tmpDir()
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })

  // Create a fake rg binary
  const fakeRg = path.join(binDir, "rg")
  fs.writeFileSync(fakeRg, "#!/bin/sh\necho fake rg\n")
  fs.chmodSync(fakeRg, 0o755)

  const rg = resolveRg(stashDir)
  expect(rg).toBe(fakeRg)
})

test("resolveRg skips non-executable files in stash/bin", () => {
  const stashDir = tmpDir()
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })

  // Create a non-executable rg file
  const fakeRg = path.join(binDir, "rg")
  fs.writeFileSync(fakeRg, "not executable")
  fs.chmodSync(fakeRg, 0o644)

  const rg = resolveRg(stashDir)
  // Should fall through to system PATH
  expect(rg).not.toBe(fakeRg)
})

// ── isRgAvailable ───────────────────────────────────────────────────────────

test("isRgAvailable returns true when rg is on PATH", () => {
  const originalPath = process.env.PATH
  const stashDir = tmpDir()
  const binDir = path.join(stashDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })

  const rgName = process.platform === "win32" ? "rg.cmd" : "rg"
  const fakeRg = path.join(binDir, rgName)
  const scriptContent =
    process.platform === "win32"
      ? "@echo off\r\necho fake rg\r\n"
      : "#!/bin/sh\necho fake rg\n"
  fs.writeFileSync(fakeRg, scriptContent)
  if (process.platform !== "win32") {
    fs.chmodSync(fakeRg, 0o755)
  }

  process.env.PATH = binDir + path.delimiter + (originalPath ?? "")
  try {
    expect(isRgAvailable()).toBe(true)
  } finally {
    process.env.PATH = originalPath
  }
})

// ── Integration: indexed search pipeline ────────────────────────────────────

test("search pipeline returns ranked results when index exists", async () => {
  const stashDir = tmpDir()
  for (const sub of ["tools", "skills", "commands", "agents"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true })
  }

  // Create tools with .stash.json metadata
  writeFile(
    path.join(stashDir, "tools", "docker", "build.sh"),
    "#!/bin/bash\necho build\n",
  )
  writeFile(
    path.join(stashDir, "tools", "docker", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "docker-build", type: "tool", description: "build docker images", tags: ["docker", "container"], entry: "build.sh" }],
    }),
  )
  writeFile(
    path.join(stashDir, "tools", "git", "diff.sh"),
    "#!/bin/bash\necho diff\n",
  )
  writeFile(
    path.join(stashDir, "tools", "git", ".stash.json"),
    JSON.stringify({
      entries: [{ name: "git-diff", type: "tool", description: "summarize git changes", tags: ["git", "diff"], entry: "diff.sh" }],
    }),
  )

  // Isolation: ensure index cache is written to a temp directory
  const oldXdgCacheHome = process.env.XDG_CACHE_HOME
  const tempCacheDir = tmpDir()
  process.env.XDG_CACHE_HOME = tempCacheDir

  try {
    // Build index
    process.env.AGENTIKIT_STASH_DIR = stashDir
    const { agentikitIndex } = await import("../src/indexer")
    await agentikitIndex({ stashDir })

    // Search — TF-IDF should rank docker-related results first
    const { agentikitSearch } = await import("../src/stash")
    const result = await agentikitSearch({ query: "docker", type: "any" })

    expect(result.hits.length).toBeGreaterThan(0)
    // Docker-related result should be ranked first
    expect(result.hits[0].name).toContain("docker")
  } finally {
    process.env.XDG_CACHE_HOME = oldXdgCacheHome
  }
})
