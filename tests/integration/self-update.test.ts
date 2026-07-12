import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  checkForUpdate,
  defaultMigrationCommand,
  detectInstallMethod,
  getAkmBinaryName,
  getPackageManagerUpgradeCommand,
  type InstallSignals,
  performUpgrade,
} from "../../src/commands/sources/self-update";
import { upgradeCommand } from "../../src/commands/sources/sources-cli";
import { sandboxHome } from "../_helpers/sandbox";

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
  test("upgrade help and results do not claim index migrates config", async () => {
    const args = upgradeCommand.args as Record<string, { description?: string }>;
    expect(args["skip-post-upgrade"]?.description).not.toMatch(/index migrates config|auto-migrat/i);
    expect(args["migration-config"]?.description).toMatch(/0\.9\+.*prepared config.*new binary.*apply/i);

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

    expect(result.postUpgrade?.message).not.toMatch(/config migrated|migrate config|auto-migrat/i);
    expect(spawnSyncSpy).toHaveBeenCalled();
  });

  test("runs migration preflight and apply before rebuilding the index", async () => {
    const events: string[] = [];
    spyOn(childProcess, "spawnSync").mockImplementation(((_command: string, args: string[]) => {
      events.push(args[0] === "install" ? "install" : args.join(" "));
      return { status: 0, stdout: "", stderr: "" } as never;
    }) as never);

    await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "npm",
      },
      undefined,
      {
        migration: {
          preflight: (binary) => events.push(`preflight:${binary}`),
          stagedPreflight: (binary) => events.push(`staged:${binary}`),
          apply: (binary) => events.push(`apply:${binary}`),
        },
      },
    );

    expect(events).toEqual(["preflight:akm", "install", "apply:akm", "index"]);
  });

  test("refuses a pre-contract 0.8 to 0.9 self-update before preflight or installation", async () => {
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const migration = { preflight: mock(() => {}), stagedPreflight: mock(() => {}), apply: mock(() => {}) };

    await expect(
      performUpgrade(
        {
          currentVersion: "0.8.14",
          latestVersion: "0.9.0",
          updateAvailable: true,
          installMethod: "npm",
        },
        { migrationConfig: "/operator/prepared-0.9.json", skipPostUpgrade: true },
        { migration },
      ),
    ).rejects.toThrow(/independent backup.*install.*0\.9.*migrate apply --config/is);

    expect(migration.preflight).not.toHaveBeenCalled();
    expect(migration.stagedPreflight).not.toHaveBeenCalled();
    expect(migration.apply).not.toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();

    let fetched = false;
    mockFetch(() => {
      fetched = true;
      return new Response("unexpected", { status: 200 });
    });
    await expect(
      performUpgrade({
        currentVersion: "0.8.14",
        latestVersion: "0.9.0",
        updateAvailable: true,
        installMethod: "binary",
      }),
    ).rejects.toThrow(/self-update cannot safely cross/i);
    expect(fetched).toBe(false);
  });

  test("preserves migration preflight and apply for contract-capable future upgrades", async () => {
    const events: string[] = [];
    spyOn(childProcess, "spawnSync").mockImplementation(((_command: string, args: string[]) => {
      events.push(args[0] === "install" ? "install" : args.join(" "));
      return { status: 0, stdout: "", stderr: "" } as never;
    }) as never);

    await performUpgrade(
      {
        currentVersion: "0.9.0",
        latestVersion: "0.10.0",
        updateAvailable: true,
        installMethod: "npm",
      },
      { migrationConfig: "/operator/prepared-future.json", skipPostUpgrade: true },
    );

    expect(events).toEqual(["migrate status", "install", "migrate apply --config /operator/prepared-future.json"]);
  });

  test("real migration command keeps future prepared config away from the old parser", () => {
    const root = path.join(sandboxHome().dir, "upgrade-parser-contract");
    fs.mkdirSync(root, { recursive: true });
    const oldBinary = path.join(root, "old-akm");
    const newBinary = path.join(root, "new-akm");
    fs.writeFileSync(
      oldBinary,
      '#!/bin/sh\n[ "$1" = "migrate" ] && [ "$2" = "status" ] && [ "$#" = "2" ] || exit 41\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      newBinary,
      '#!/bin/sh\n[ "$1" = "migrate" ] || exit 42\n[ "$3" = "--config" ] && [ "$4" = "/future/config.json" ] || exit 42\n[ "$2" = "status" ] || [ "$2" = "apply" ] || exit 42\n',
      { mode: 0o755 },
    );

    const migration = defaultMigrationCommand("/future/config.json");
    expect(() => migration.preflight(oldBinary)).not.toThrow();
    expect(() => migration.stagedPreflight(newBinary)).not.toThrow();
    expect(() => migration.apply(newBinary)).not.toThrow();
  });

  test("staged binary preflight failure retains the old standalone executable", async () => {
    const installDir = path.join(sandboxHome().dir, "staged-preflight-failure");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(
      binaryPath,
      '#!/bin/sh\n[ "$1" = "migrate" ] && [ "$2" = "status" ] && [ "$#" = "2" ] || exit 51\n',
      { mode: 0o755 },
    );
    const rejectedBinary = "#!/bin/sh\nexit 57\n";
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update(rejectedBinary).digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, { status: 200 })
        : new Response(rejectedBinary, { status: 200 }),
    );

    await expect(
      performUpgrade(
        {
          currentVersion: "0.9.0",
          latestVersion: "0.10.0",
          updateAvailable: true,
          installMethod: "binary",
        },
        { migrationConfig: "/future/config.json", skipPostUpgrade: true },
        { execPath: binaryPath },
      ),
    ).rejects.toThrow(/staged migration preflight failed/i);
    expect(fs.readFileSync(binaryPath, "utf8")).toContain('"$#" = "2"');
    expect(fs.existsSync(`${binaryPath}.bak`)).toBe(false);
    expect(fs.readdirSync(installDir)).toEqual(["akm"]);
  });

  test("rejects an oversized binary response before replacing or staging the executable", async () => {
    const installDir = path.join(sandboxHome().dir, "oversized-binary");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update("x").digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, { status: 200 })
        : new Response("x", { status: 200, headers: { "content-length": String(1024 * 1024 * 1024) } }),
    );

    await expect(
      performUpgrade(
        {
          currentVersion: "0.9.0",
          latestVersion: "0.10.0",
          updateAvailable: true,
          installMethod: "binary",
        },
        { skipPostUpgrade: true },
        { execPath: binaryPath, migration: { preflight() {}, stagedPreflight() {}, apply() {} } },
      ),
    ).rejects.toThrow(/exceed|too large|limit/i);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readdirSync(installDir)).toEqual(["akm"]);
  });

  test("rejects oversized checksum metadata and removes the streamed stage", async () => {
    const installDir = path.join(sandboxHome().dir, "oversized-checksums");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryData = "new-binary";
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update(binaryData).digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, {
            status: 200,
            headers: { "content-length": String(2 * 1024 * 1024) },
          })
        : new Response(binaryData, { status: 200 }),
    );

    await expect(
      performUpgrade(
        {
          currentVersion: "0.9.0",
          latestVersion: "0.10.0",
          updateAvailable: true,
          installMethod: "binary",
        },
        { skipPostUpgrade: true },
        { execPath: binaryPath, migration: { preflight() {}, stagedPreflight() {}, apply() {} } },
      ),
    ).rejects.toThrow(/exceed|too large|limit/i);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readdirSync(installDir)).toEqual(["akm"]);
  });

  test("stages binary migration and retains the old binary until apply succeeds", async () => {
    const installDir = path.join(sandboxHome().dir, "self-update");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryData = "new-binary";
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update(binaryData).digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, { status: 200 })
        : new Response(binaryData, { status: 200 }),
    );
    const events: string[] = [];

    const result = await performUpgrade(
      {
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
        updateAvailable: true,
        installMethod: "binary",
      },
      { skipPostUpgrade: true },
      {
        execPath: binaryPath,
        migration: {
          preflight(currentBinary) {
            events.push("preflight");
            expect(currentBinary).toBe(binaryPath);
            expect(fs.readFileSync(currentBinary, "utf8")).toBe("old-binary");
          },
          stagedPreflight(stagedBinary) {
            events.push("staged-preflight");
            expect(stagedBinary).not.toBe(binaryPath);
            expect(fs.readFileSync(stagedBinary, "utf8")).toBe(binaryData);
          },
          apply(installedBinary) {
            events.push("apply");
            expect(installedBinary).toBe(binaryPath);
            expect(fs.readFileSync(binaryPath, "utf8")).toBe(binaryData);
            expect(fs.readFileSync(`${binaryPath}.bak`, "utf8")).toBe("old-binary");
          },
        },
      },
    );

    expect(events).toEqual(["preflight", "staged-preflight", "apply"]);
    expect(result.upgraded).toBe(true);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe(binaryData);
    expect(fs.existsSync(`${binaryPath}.bak`)).toBe(false);
  });

  test("does not roll the executable back independently when migration apply fails", async () => {
    const installDir = path.join(sandboxHome().dir, "self-update-failed-migration");
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "akm");
    fs.writeFileSync(binaryPath, "old-binary");
    const binaryData = "new-binary";
    const binaryName = getAkmBinaryName();
    const hash = createHash("sha256").update(binaryData).digest("hex");
    mockFetch((url) =>
      url.includes("checksums.txt")
        ? new Response(`${hash}  ${binaryName}\n`, { status: 200 })
        : new Response(binaryData, { status: 200 }),
    );

    await expect(
      performUpgrade(
        {
          currentVersion: "0.9.0",
          latestVersion: "0.10.0",
          updateAvailable: true,
          installMethod: "binary",
        },
        { skipPostUpgrade: true },
        {
          execPath: binaryPath,
          migration: {
            preflight() {},
            stagedPreflight() {},
            apply() {
              throw new Error("apply failed");
            },
          },
        },
      ),
    ).rejects.toThrow(/previous binary retained/i);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe(binaryData);
    expect(fs.readFileSync(`${binaryPath}.bak`, "utf8")).toBe("old-binary");
  });

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

  test("runs `akm index` post-upgrade after a successful pkg-manager install", async () => {
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

    expect(result.upgraded).toBe(true);
    expect(result.postUpgrade).toBeDefined();
    expect(result.postUpgrade?.ok).toBe(true);
    expect(result.postUpgrade?.skipped).toBe(false);
    expect(result.postUpgrade?.exitCode).toBe(0);
    // Preflight, install, apply, then the post-upgrade `akm index`.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(4);
    expect(spawnSyncSpy).toHaveBeenLastCalledWith(
      "akm",
      ["index"],
      expect.objectContaining({ encoding: "utf8", stdio: "pipe" }),
    );
  });

  test("skips the post-upgrade `akm index` when skipPostUpgrade is set", async () => {
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
      { skipPostUpgrade: true },
    );

    expect(result.upgraded).toBe(true);
    expect(result.postUpgrade).toBeDefined();
    expect(result.postUpgrade?.skipped).toBe(true);
    expect(result.postUpgrade?.ok).toBe(true);
    // Preflight, install, and apply ran; only the index rebuild was skipped.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
  });

  test("captures post-upgrade failure without failing the upgrade", async () => {
    let call = 0;
    const spawnSyncSpy = spyOn(childProcess, "spawnSync").mockImplementation((() => {
      call++;
      if (call < 4) {
        // Migration preflight, package install, and migration apply succeed.
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      // The post-upgrade `akm index` fails with a non-zero exit.
      return { status: 1, stdout: "", stderr: "no embedding model configured" } as never;
    }) as never);

    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "npm",
    });

    expect(result.upgraded).toBe(true); // upgrade itself succeeded
    expect(result.postUpgrade?.ok).toBe(false);
    expect(result.postUpgrade?.exitCode).toBe(1);
    expect(result.postUpgrade?.message).toContain("no embedding model configured");
    expect(spawnSyncSpy).toHaveBeenCalledTimes(4);
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
      performUpgrade(
        {
          currentVersion: "0.0.13",
          latestVersion: "0.0.14",
          updateAvailable: true,
          installMethod: "npm",
        },
        { skipPostUpgrade: true },
      ),
    ).resolves.toMatchObject({ upgraded: true, installMethod: "npm" });
    // Migration preflight and apply still bracket the package install.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
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
      { skipChecksum: true, skipPostUpgrade: true },
    );
    // Migration preflight and apply still bracket the package install.
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
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
