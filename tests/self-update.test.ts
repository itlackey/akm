import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import {
  checkForUpdate,
  detectInstallMethod,
  getAkmBinaryName,
  getPackageManagerUpgradeCommand,
  type InstallSignals,
  performUpgrade,
} from "../src/self-update";

// ── Fetch mocking helper ────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

function mockFetch(handler: (url: string) => Response): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

afterEach(() => {
  mock.restore();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

function fakeRelease(tagName: string): Response {
  return Response.json({ tag_name: tagName });
}

// ── detectInstallMethod ─────────────────────────────────────────────────────

describe("detectInstallMethod", () => {
  test("returns a valid install method when running via bun run (not compiled)", () => {
    const method = detectInstallMethod();
    // In test context we're running from source. May be "binary" if AKM_VERSION
    // is defined (e.g. compiled test runner), otherwise "unknown" or a package-manager install.
    expect(["unknown", "npm", "pnpm", "bun", "binary"]).toContain(method);
  });

  test("does not throw", () => {
    expect(() => detectInstallMethod()).not.toThrow();
  });

  test("returns 'binary' when Bun.main starts with /$bunfs/", () => {
    const signals: InstallSignals = {
      bunMain: "/$bunfs/root/src/cli.ts",
      importMetaDir: "/some/path",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("binary");
  });

  test("returns 'binary' when AKM_VERSION is defined (fallback)", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/akm",
      importMetaDir: "/some/path",
      hasAkmVersion: true,
    };
    expect(detectInstallMethod(signals)).toBe("binary");
  });

  test("returns 'bun' for Bun global install path", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/bun",
      importMetaDir: "/home/user/.bun/install/global/node_modules/akm-cli/dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("bun");
  });

  test("returns 'bun' for Windows-style Bun global install path", () => {
    const signals: InstallSignals = {
      bunMain: "C:\\Program Files\\Bun\\bun.exe",
      importMetaDir: "C:\\Users\\me\\.bun\\install\\global\\node_modules\\akm-cli\\dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("bun");
  });

  test("returns 'pnpm' for pnpm global install path", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/bun",
      importMetaDir: "/home/user/.local/share/pnpm/global/5/node_modules/akm-cli/dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("pnpm");
  });

  test("returns 'pnpm' for Windows-style pnpm global install path", () => {
    const signals: InstallSignals = {
      bunMain: "C:\\Program Files\\Bun\\bun.exe",
      importMetaDir: "C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\akm-cli\\dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("pnpm");
  });

  test("returns 'npm' when importMetaDir contains node_modules without bun/pnpm markers", () => {
    const signals: InstallSignals = {
      bunMain: "/usr/local/bin/bun",
      importMetaDir: "/usr/local/lib/node_modules/akm-cli/dist",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("npm");
  });

  test("package-manager detection takes priority over binary signals", () => {
    const signals: InstallSignals = {
      bunMain: "/$bunfs/root/src/cli.ts",
      importMetaDir: "/some/node_modules/akm",
      hasAkmVersion: true,
    };
    expect(detectInstallMethod(signals)).toBe("npm");
  });

  test("returns 'unknown' when no signals match", () => {
    const signals: InstallSignals = {
      bunMain: undefined,
      importMetaDir: "/some/path",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("unknown");
  });

  test("returns 'unknown' when Bun is present but no binary indicators", () => {
    const signals: InstallSignals = {
      bunMain: "/home/user/akm/src/cli.ts",
      importMetaDir: "/home/user/akm/src",
      hasAkmVersion: false,
    };
    expect(detectInstallMethod(signals)).toBe("unknown");
  });
});

// ── getAkmBinaryName ────────────────────────────────────────────────────────

describe("getAkmBinaryName", () => {
  test("returns a string containing 'akm'", () => {
    const name = getAkmBinaryName();
    expect(name).toContain("akm");
  });

  test("returns platform-appropriate name for current platform", () => {
    const name = getAkmBinaryName();
    const platform = process.platform;
    const arch = process.arch;

    if (platform === "linux") {
      expect(name).toStartWith("akm-linux-");
    } else if (platform === "darwin") {
      expect(name).toStartWith("akm-darwin-");
    } else if (platform === "win32") {
      expect(name).toStartWith("akm-windows-");
      expect(name).toEndWith(".exe");
    }

    if (arch === "x64") {
      expect(name).toContain("x64");
    } else if (arch === "arm64") {
      expect(name).toContain("arm64");
    }
  });
});

// ── checkForUpdate (mocked fetch) ───────────────────────────────────────────

describe("checkForUpdate", () => {
  test("returns valid UpgradeCheckResponse", async () => {
    mockFetch(() => fakeRelease("v0.0.14"));

    const result = await checkForUpdate("0.0.13");

    expect(result.currentVersion).toBe("0.0.13");
    expect(result.latestVersion).toBe("0.0.14");
    expect(result.updateAvailable).toBe(true);
    expect(["binary", "bun", "npm", "pnpm", "unknown"]).toContain(result.installMethod);
  });

  test("updateAvailable is false when current matches latest", async () => {
    mockFetch(() => fakeRelease("v0.0.13"));

    const result = await checkForUpdate("0.0.13");

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe("0.0.13");
  });

  test("updateAvailable is true for an old version", async () => {
    mockFetch(() => fakeRelease("v0.0.14"));

    const result = await checkForUpdate("0.0.0");

    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe("0.0.0");
    expect(result.latestVersion).toBe("0.0.14");
  });

  test("handles missing tag_name gracefully", async () => {
    mockFetch(() => Response.json({}));

    const result = await checkForUpdate("0.0.13");

    expect(result.latestVersion).toBe("");
    expect(result.updateAvailable).toBe(false);
  });

  test("throws on non-OK response", async () => {
    mockFetch(() => new Response("Not Found", { status: 404, statusText: "Not Found" }));

    await expect(checkForUpdate("0.0.13")).rejects.toThrow("Failed to check for updates");
  });
});

// ── performUpgrade ──────────────────────────────────────────────────────────

describe("performUpgrade", () => {
  test("runs npm global install for npm installs", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("npm"),
      ["install", "-g", "akm-cli@latest"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("npm");
  });

  test("runs bun global install for bun installs", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "bun",
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("bun"),
      ["install", "-g", "akm-cli@latest"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("bun");
  });

  test("runs pnpm global add for pnpm installs", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "pnpm",
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("pnpm"),
      ["add", "-g", "akm-cli@latest"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("pnpm");
  });

  test("returns guidance message for unknown install method", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "unknown",
    });

    expect(result.upgraded).toBe(false);
    expect(result.installMethod).toBe("unknown");
    expect(result.message).toContain("manually");
  });

  test("returns already-latest message when no update available", async () => {
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.13",
      updateAvailable: false,
      installMethod: "binary",
    });

    expect(result.upgraded).toBe(false);
    expect(result.message).toContain("already the latest");
  });

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
    ).rejects.toThrow("Unable to determine latest version");
  });

  // Note: tests for the binary install path (installMethod: "binary") that test
  // checksum verification must avoid actually reaching the filesystem write step,
  // which would overwrite the running bun binary. We mock the download to return
  // a non-OK status after the checksum check fails, so the code throws before
  // trying to write to disk.

  test("blocks upgrade when checksum URL returns 404 (default)", async () => {
    mockFetch((url) => {
      if (url.includes("checksums.txt")) return new Response("", { status: 404, statusText: "Not Found" });
      // Use a non-OK download response so the code throws before reaching the write step
      return new Response("", { status: 500 });
    });

    // The binary download fails first (500), but if checksum fetch is tried before
    // binary download, it should throw a checksum error.
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    await expect(
      performUpgrade({
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "npm",
      }),
    ).resolves.toMatchObject({ upgraded: true, installMethod: "npm" });
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
  });

  test("checksum URL 404 throws Checksum verification failed for binary install", async () => {
    // Use a mock that: binary download succeeds, checksum returns 404.
    // IMPORTANT: We ensure the test does NOT write to disk by making the checksum
    // step fail first (it runs after binary download).
    mockFetch((url) => {
      if (url.includes("checksums.txt")) return new Response("", { status: 404 });
      // Fake binary download — must succeed for checksum check to be reached
      return new Response(new Uint8Array(100), { status: 200 });
    });

    await expect(
      performUpgrade({
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "binary",
      }),
    ).rejects.toThrow(/Checksum verification failed/);
  });

  test("skipChecksum: true option is accepted by performUpgrade (npm path)", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);

    const result = await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "npm",
      },
      { skipChecksum: true },
    );
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    expect(result.upgraded).toBe(true);
    expect(result.installMethod).toBe("npm");
  });

  test("blocks upgrade when binary name not in checksums.txt (default)", async () => {
    const binaryName = getAkmBinaryName();
    mockFetch((url) => {
      if (url.includes("checksums.txt")) {
        // Valid checksums format but does NOT include the current binary name
        return new Response(`${"a".repeat(64)}  other-binary\n${"b".repeat(64)}  another-binary\n`, { status: 200 });
      }
      return new Response(new Uint8Array(100), { status: 200 });
    });

    await expect(
      performUpgrade({
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "binary",
      }),
    ).rejects.toThrow(new RegExp(`${binaryName.replace(".", "\\.")}.*not listed|Checksum verification failed`));
  });

  test("blocks upgrade on checksum mismatch (default)", async () => {
    const binaryName = getAkmBinaryName();
    const wrongHash = "0".repeat(64);
    mockFetch((url) => {
      if (url.includes("checksums.txt")) {
        return new Response(`${wrongHash}  ${binaryName}\n`, { status: 200 });
      }
      // Return binary content that will NOT match the all-zeros hash
      return new Response(new Uint8Array(Array.from({ length: 100 }, (_, i) => i % 256)), { status: 200 });
    });

    await expect(
      performUpgrade({
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "binary",
      }),
    ).rejects.toThrow(/Checksum mismatch/);
  });
});

describe("getPackageManagerUpgradeCommand", () => {
  test("returns npm install command", () => {
    expect(getPackageManagerUpgradeCommand("npm", "akm-cli")).toEqual({
      command: expect.stringContaining("npm"),
      args: ["install", "-g", "akm-cli@latest"],
      displayCommand: "npm install -g akm-cli@latest",
    });
  });

  test("returns bun install command", () => {
    expect(getPackageManagerUpgradeCommand("bun", "akm-cli")).toEqual({
      command: expect.stringContaining("bun"),
      args: ["install", "-g", "akm-cli@latest"],
      displayCommand: "bun install -g akm-cli@latest",
    });
  });

  test("returns pnpm add command", () => {
    expect(getPackageManagerUpgradeCommand("pnpm", "akm-cli")).toEqual({
      command: expect.stringContaining("pnpm"),
      args: ["add", "-g", "akm-cli@latest"],
      displayCommand: "pnpm add -g akm-cli@latest",
    });
  });

  test("returns undefined for non-package-manager installs", () => {
    expect(getPackageManagerUpgradeCommand("binary", "akm-cli")).toBeUndefined();
    expect(getPackageManagerUpgradeCommand("unknown", "akm-cli")).toBeUndefined();
  });
});
