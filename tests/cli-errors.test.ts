import { test, expect, describe, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cli-err-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** Isolated temp dirs so the CLI never touches real user config/cache. */
const xdgCache = makeTempDir()
const xdgConfig = makeTempDir()

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", ["./src/cli.ts", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
    },
  })
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CLI error handling", () => {
  test("search without AKM_STASH_DIR prints JSON error with hint", () => {
    const { stderr, status } = runCli("search", "test")
    expect(status).not.toBe(0)
    expect(stderr).toContain("AKM_STASH_DIR")
    expect(stderr).toContain("hint")
  })

  test("show with invalid ref prints JSON error", () => {
    const { stderr, status } = runCli("show", "invalid-ref-no-colon")
    expect(status).not.toBe(0)
    const parsed = JSON.parse(stderr.trim())
    expect(parsed.ok).toBe(false)
    expect(typeof parsed.error).toBe("string")
  })

  test("search --source invalid prints hint about source", () => {
    const { stderr, status } = runCli("search", "test", "--source", "invalid")
    expect(status).not.toBe(0)
    expect(stderr).toContain("Invalid value for --source")
    expect(stderr).toContain("hint")
  })

  test("search --usage invalid prints hint about usage", () => {
    const { stderr, status } = runCli("search", "test", "--usage", "invalid")
    expect(status).not.toBe(0)
    expect(stderr).toContain("Invalid value for --usage")
    expect(stderr).toContain("hint")
  })

  test("error output is valid JSON", () => {
    const { stderr } = runCli("search", "test")
    // stderr may contain multiple lines; the JSON error is the last block
    const trimmed = stderr.trim()
    const parsed = JSON.parse(trimmed)
    expect(parsed.ok).toBe(false)
    expect(typeof parsed.error).toBe("string")
  })

  test("config set with invalid JSON prints hint about quoting", () => {
    const { stderr, status } = runCli("config", "embedding", "not-valid-json")
    expect(status).not.toBe(0)
    const parsed = JSON.parse(stderr.trim())
    expect(parsed.ok).toBe(false)
    expect(parsed.hint).toContain("Quote JSON values")
  })
})
