import { test, expect, describe } from "bun:test"
import { detectInstallMethod, getAkmBinaryName } from "../src/self-update"

describe("detectInstallMethod", () => {
  test("returns 'unknown' when running via bun run (not compiled)", () => {
    // When running tests with `bun test`, we're not a compiled binary
    const method = detectInstallMethod()
    // In test context, Bun.main !== process.execPath, so it won't be "binary".
    // And import.meta.dir won't contain node_modules for this project's own source.
    expect(["unknown", "npm"]).toContain(method)
  })

  test("does not throw", () => {
    expect(() => detectInstallMethod()).not.toThrow()
  })
})

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

describe("checkForUpdate", () => {
  test("returns valid UpgradeCheckResponse", async () => {
    // Import dynamically so we can test the actual network call
    const { checkForUpdate } = await import("../src/self-update")
    const result = await checkForUpdate("0.0.13")

    expect(result.currentVersion).toBe("0.0.13")
    expect(typeof result.latestVersion).toBe("string")
    expect(result.latestVersion.length).toBeGreaterThan(0)
    expect(typeof result.updateAvailable).toBe("boolean")
    expect(["binary", "npm", "unknown"]).toContain(result.installMethod)
  })

  test("updateAvailable is false when current matches latest", async () => {
    const { checkForUpdate } = await import("../src/self-update")
    const result = await checkForUpdate("0.0.13")

    // If 0.0.13 is the latest, updateAvailable should be false.
    // If it's not, updateAvailable should be true. Either is valid.
    if (result.latestVersion === "0.0.13") {
      expect(result.updateAvailable).toBe(false)
    } else {
      expect(result.updateAvailable).toBe(true)
    }
  })

  test("updateAvailable is true for an old version", async () => {
    const { checkForUpdate } = await import("../src/self-update")
    const result = await checkForUpdate("0.0.0")

    expect(result.updateAvailable).toBe(true)
    expect(result.currentVersion).toBe("0.0.0")
  })
})

describe("performUpgrade", () => {
  test("returns guidance message for non-binary installs", async () => {
    const { performUpgrade } = await import("../src/self-update")

    const npmResult = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    })

    expect(npmResult.upgraded).toBe(false)
    expect(npmResult.installMethod).toBe("npm")
    expect(npmResult.message).toContain("npm")
  })

  test("returns guidance message for unknown install method", async () => {
    const { performUpgrade } = await import("../src/self-update")

    const unknownResult = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "unknown",
    })

    expect(unknownResult.upgraded).toBe(false)
    expect(unknownResult.installMethod).toBe("unknown")
    expect(unknownResult.message).toContain("manually")
  })

  test("returns already-latest message when no update available", async () => {
    const { performUpgrade } = await import("../src/self-update")

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.13",
      updateAvailable: false,
      installMethod: "binary",
    })

    expect(result.upgraded).toBe(false)
    expect(result.message).toContain("already the latest")
  })
})
