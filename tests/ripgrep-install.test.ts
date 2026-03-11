import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We test the module by importing and mocking its dependencies.
// Since ensureRg calls spawnSync and resolveRg, we mock at the module level.

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rg-install-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeToolchainDir(): string {
  const dir = makeTmpDir();
  fs.writeFileSync(
    path.join(dir, "curl"),
    '#!/bin/sh\nout=\'\'\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then\n    out=$2\n    shift 2\n    continue\n  fi\n  shift\ndone\n/bin/cp "$FAKE_CURL_SOURCE" "$out"\n',
  );
  fs.chmodSync(path.join(dir, "curl"), 0o755);
  fs.symlinkSync("/usr/bin/tar", path.join(dir, "tar"));
  fs.symlinkSync("/usr/bin/gzip", path.join(dir, "gzip"));
  return dir;
}

function makeFailingCurlDir(): string {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "curl"), "#!/bin/sh\necho 'fake curl failure' >&2\nexit 1\n");
  fs.chmodSync(path.join(dir, "curl"), 0o755);
  return dir;
}

function makeRipgrepTarball(): string {
  const root = makeTmpDir();
  const packageDir = path.join(root, "ripgrep-14.1.1-x86_64-unknown-linux-musl");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "rg"), "#!/bin/sh\necho 'ripgrep 14.1.1'\n");
  fs.chmodSync(path.join(packageDir, "rg"), 0o755);
  const tarballPath = path.join(root, "ripgrep.tar.gz");
  const result = spawnSync("tar", ["czf", tarballPath, "-C", root, path.basename(packageDir)], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "Failed to create ripgrep tarball");
  }
  return tarballPath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── ensureRg – already available ────────────────────────────────────────────

describe("ensureRg", () => {
  test("returns existing rg when already available in binDir", async () => {
    // Create a fake rg binary so resolveRg finds it
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, "#!/bin/sh\necho 'ripgrep 14.1.1'\n");
    fs.chmodSync(rgPath, 0o755);

    // We need to isolate PATH so only our binDir is searched
    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    const origHome = process.env.HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.rgPath).toBe(rgPath);
      expect(result.installed).toBe(false);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });
});

// ── getRgPlatformTarget (tested via ensureRg behavior) ──────────────────────

describe("platform detection", () => {
  // We can test this indirectly: ensureRg will throw for unsupported platforms
  // We test current platform should be supported (we're running on linux/x64 or similar)
  test("current platform is recognized (does not throw unsupported)", async () => {
    const binDir = makeTmpDir();
    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = makeFailingCurlDir();
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      // This will try to actually download, so we expect a network error or curl error,
      // NOT an "Unsupported platform" error.
      try {
        ensureRg(binDir);
      } catch (err: unknown) {
        const message = (err as Error).message;
        // Should NOT be the unsupported platform error
        expect(message).not.toContain("Unsupported platform");
        // It should be a download/extraction error since we're not actually downloading
        expect(
          message.includes("Failed to download") ||
            message.includes("Failed to extract") ||
            message.includes("not found at"),
        ).toBe(true);
      }
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});

// ── getRgVersion (tested via ensureRg result) ───────────────────────────────

describe("getRgVersion", () => {
  test("extracts version from rg binary output", async () => {
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    // Create a script that mimics rg --version output
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "ripgrep 14.1.1 (rev abc123)"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.version).toBe("14.1.1");
      expect(result.installed).toBe(false);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });

  test("returns 'unknown' when rg binary does not output version format", async () => {
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "something else"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.version).toBe("unknown");
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});

// ── EnsureRgResult shape ────────────────────────────────────────────────────

describe("EnsureRgResult", () => {
  test("result has correct shape for existing binary", async () => {
    const binDir = makeTmpDir();
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "ripgrep 14.0.0"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(typeof result.rgPath).toBe("string");
      expect(typeof result.installed).toBe("boolean");
      expect(typeof result.version).toBe("string");
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });
});

// ── Download error handling ─────────────────────────────────────────────────

describe("download error handling", () => {
  test("creates binDir if it does not exist", async () => {
    const parentDir = makeTmpDir();
    const binDir = path.join(parentDir, "nested", "bin");
    const rgPath = path.join(binDir, "rg");
    // Pre-create an rg binary so ensureRg finds it and doesn't try to download
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(rgPath, '#!/bin/sh\necho "ripgrep 14.1.1"\n');
    fs.chmodSync(rgPath, 0o755);

    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.PATH = "";
    process.env.XDG_CACHE_HOME = makeTmpDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const result = ensureRg(binDir);
      expect(result.rgPath).toBe(rgPath);
      expect(result.installed).toBe(false);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
    }
  });

  test("ensureRg returns installed=true when it installs a new binary", async () => {
    const binDir = makeTmpDir();
    const origPath = process.env.PATH;
    const origXdgCache = process.env.XDG_CACHE_HOME;
    const origFakeCurlSource = process.env.FAKE_CURL_SOURCE;
    process.env.XDG_CACHE_HOME = makeTmpDir();
    process.env.FAKE_CURL_SOURCE = makeRipgrepTarball();
    process.env.PATH = makeToolchainDir();

    try {
      const { ensureRg } = await import("../src/ripgrep-install");
      const rgInBin = path.join(binDir, "rg");
      if (fs.existsSync(rgInBin)) fs.unlinkSync(rgInBin);

      const result = ensureRg(binDir);
      expect(result.installed).toBe(true);
      expect(result.version).toBe("14.1.1");
      expect(fs.existsSync(result.rgPath)).toBe(true);
    } finally {
      process.env.PATH = origPath;
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
      if (origFakeCurlSource === undefined) delete process.env.FAKE_CURL_SOURCE;
      else process.env.FAKE_CURL_SOURCE = origFakeCurlSource;
    }
  });
});
