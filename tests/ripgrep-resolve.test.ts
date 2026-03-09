import { test, expect, describe, afterAll, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveRg, isRgAvailable } from "../src/ripgrep-resolve"

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rg-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const origPath = process.env.PATH

afterEach(() => {
  if (origPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = origPath
  }
})

// ── resolveRg ───────────────────────────────────────────────────────────────

describe("resolveRg", () => {
  test("finds rg in provided bin directory", () => {
    const binDir = makeTempDir()

    const rgPath = path.join(binDir, "rg")
    fs.writeFileSync(rgPath, "#!/bin/sh\necho rg\n")
    fs.chmodSync(rgPath, 0o755)

    const result = resolveRg(binDir)
    expect(result).toBe(rgPath)
  })

  test("falls back to system PATH", () => {
    const fakeBinDir = makeTempDir()
    const fakeRg = path.join(fakeBinDir, "rg")
    fs.writeFileSync(fakeRg, "#!/bin/sh\necho rg\n")
    fs.chmodSync(fakeRg, 0o755)

    // Put our fake bin dir at the front of PATH
    process.env.PATH = `${fakeBinDir}${path.delimiter}${origPath}`

    // No stash dir provided -- should find from PATH
    const result = resolveRg()
    expect(result).toBeTruthy()
  })

  test("returns null when not found anywhere", () => {
    // Empty stash dir with no rg, and an empty PATH
    const emptyStash = makeTempDir()
    process.env.PATH = ""

    const result = resolveRg(emptyStash)
    expect(result).toBeNull()
  })

  test("returns null for stash dir without bin subdirectory", () => {
    const emptyStash = makeTempDir()
    process.env.PATH = ""

    const result = resolveRg(emptyStash)
    expect(result).toBeNull()
  })

  test("skips non-executable file in bin dir", () => {
    const binDir = makeTempDir()

    // Create an rg file that is NOT executable
    const rgPath = path.join(binDir, "rg")
    fs.writeFileSync(rgPath, "not executable")
    fs.chmodSync(rgPath, 0o644)

    process.env.PATH = ""

    const result = resolveRg(binDir)
    expect(result).toBeNull()
  })
})

// ── isRgAvailable ───────────────────────────────────────────────────────────

describe("isRgAvailable", () => {
  test("returns true when resolveRg finds a binary", () => {
    const binDir = makeTempDir()

    const rgPath = path.join(binDir, "rg")
    fs.writeFileSync(rgPath, "#!/bin/sh\necho rg\n")
    fs.chmodSync(rgPath, 0o755)

    expect(isRgAvailable(binDir)).toBe(true)
  })

  test("returns false when resolveRg finds nothing", () => {
    const emptyDir = makeTempDir()
    process.env.PATH = ""

    expect(isRgAvailable(emptyDir)).toBe(false)
  })

  test("boolean result matches resolveRg truthiness", () => {
    const binDir = makeTempDir()
    process.env.PATH = ""

    const resolved = resolveRg(binDir)
    const available = isRgAvailable(binDir)
    expect(available).toBe(resolved !== null)
  })
})
