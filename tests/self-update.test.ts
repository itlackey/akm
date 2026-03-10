import { test, expect, describe, afterEach } from "bun:test"
import { detectInstallMethod, getAkmBinaryName, checkForUpdate, performUpgrade } from "../src/self-update"

// ── Fetch mocking helper ────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch

function mockFetch(handler: (url: string) => Response): void {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    return handler(url)
  }) as typeof fetch
}

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch
  }
})

function fakeRelease(tagName: string): Response {
  return Response.json({ tag_name: tagName })
}

// ── detectInstallMethod ─────────────────────────────────────────────────────

describe("detectInstallMethod", () => {
  test("returns 'unknown' when running via bun run (not compiled)", () => {
    const method = detectInstallMethod()
    // In test context, Bun.main !== process.execPath, so it won't be "binary".
    expect(["unknown", "npm"]).toContain(method)
  })

  test("does not throw", () => {
    expect(() => detectInstallMethod()).not.toThrow()
  })
})

// ── getAkmBinaryName ────────────────────────────────────────────────────────

describe("getAkmBinaryName", () => {
  test("returns a string containing 'akm'", () => {
    const name = getAkmBinaryName()
    expect(name).toContain("akm")
  })

  test("returns platform-appropriate name for current platform", () => {
    const name = getAkmBinaryName()
    const platform = process.platform
    const arch = process.arch

    if (platform === "linux") {
      expect(name).toStartWith("akm-linux-")
    } else if (platform === "darwin") {
      expect(name).toStartWith("akm-darwin-")
    } else if (platform === "win32") {
      expect(name).toStartWith("akm-windows-")
      expect(name).toEndWith(".exe")
    }

    if (arch === "x64") {
      expect(name).toContain("x64")
    } else if (arch === "arm64") {
      expect(name).toContain("arm64")
    }
  })
})

// ── checkForUpdate (mocked fetch) ───────────────────────────────────────────

describe("checkForUpdate", () => {
  test("returns valid UpgradeCheckResponse", async () => {
    mockFetch(() => fakeRelease("v0.0.14"))

    const result = await checkForUpdate("0.0.13")

    expect(result.currentVersion).toBe("0.0.13")
    expect(result.latestVersion).toBe("0.0.14")
    expect(result.updateAvailable).toBe(true)
    expect(["binary", "npm", "unknown"]).toContain(result.installMethod)
  })

  test("updateAvailable is false when current matches latest", async () => {
    mockFetch(() => fakeRelease("v0.0.13"))

    const result = await checkForUpdate("0.0.13")

    expect(result.updateAvailable).toBe(false)
    expect(result.latestVersion).toBe("0.0.13")
  })

  test("updateAvailable is true for an old version", async () => {
    mockFetch(() => fakeRelease("v0.0.14"))

    const result = await checkForUpdate("0.0.0")

    expect(result.updateAvailable).toBe(true)
    expect(result.currentVersion).toBe("0.0.0")
    expect(result.latestVersion).toBe("0.0.14")
  })

  test("handles missing tag_name gracefully", async () => {
    mockFetch(() => Response.json({}))

    const result = await checkForUpdate("0.0.13")

    expect(result.latestVersion).toBe("")
    expect(result.updateAvailable).toBe(false)
  })

  test("throws on non-OK response", async () => {
    mockFetch(() => new Response("Not Found", { status: 404, statusText: "Not Found" }))

    await expect(checkForUpdate("0.0.13")).rejects.toThrow("Failed to check for updates")
  })
})

// ── performUpgrade ──────────────────────────────────────────────────────────

describe("performUpgrade", () => {
  test("returns guidance message for npm installs", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    })

    expect(result.upgraded).toBe(false)
    expect(result.installMethod).toBe("npm")
    expect(result.message).toContain("npm")
  })

  test("returns guidance message for unknown install method", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "unknown",
    })

    expect(result.upgraded).toBe(false)
    expect(result.installMethod).toBe("unknown")
    expect(result.message).toContain("manually")
  })

  test("returns already-latest message when no update available", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.13",
      updateAvailable: false,
      installMethod: "binary",
    })

    expect(result.upgraded).toBe(false)
    expect(result.message).toContain("already the latest")
  })

  test("throws when latestVersion is empty and force is used", async () => {
    await expect(
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "",
          updateAvailable: false,
          installMethod: "binary",
        },
        { force: true },
      ),
    ).rejects.toThrow("Unable to determine latest version")
  })
})
