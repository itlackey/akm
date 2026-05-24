import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRgAvailable, resolveRg } from "../src/setup/ripgrep-resolve";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rg-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// HOME / XDG_* are snapshotted and restored by tests/_preload.ts. PATH is
// not part of the harness contract, so this file still owns its restore.
const origPath = process.env.PATH;

afterEach(() => {
  if (origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = origPath;
  }
});

/** Isolate cache so getBinDir() never finds a real rg binary. */
function isolateCache(): void {
  process.env.XDG_CACHE_HOME = makeTempDir();
  process.env.XDG_DATA_HOME = makeTempDir();
  process.env.XDG_STATE_HOME = makeTempDir();
}

// ── resolveRg ───────────────────────────────────────────────────────────────

describe("resolveRg", () => {
  test("finds rg in provided bin directory", () => {
    const binDir = makeTempDir();

    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, "#!/bin/sh\necho rg\n");
    fs.chmodSync(rgPath, 0o755);

    const result = resolveRg(binDir);
    expect(result).toBe(rgPath);
  });

  test("falls back to system PATH", () => {
    const fakeBinDir = makeTempDir();
    const fakeRg = path.join(fakeBinDir, "rg");
    fs.writeFileSync(fakeRg, "#!/bin/sh\necho rg\n");
    fs.chmodSync(fakeRg, 0o755);

    // Put our fake bin dir at the front of PATH
    process.env.PATH = `${fakeBinDir}${path.delimiter}${origPath}`;

    // No bin dir provided -- should find from PATH
    const result = resolveRg();
    expect(result).toBeTruthy();
  });

  test("returns null when not found anywhere", () => {
    const emptyDir = makeTempDir();
    process.env.PATH = "";
    isolateCache();

    const result = resolveRg(emptyDir);
    expect(result).toBeNull();
  });

  test("skips non-executable file in bin dir", () => {
    const binDir = makeTempDir();

    // Create an rg file that is NOT executable
    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, "not executable");
    fs.chmodSync(rgPath, 0o644);

    process.env.PATH = "";
    isolateCache();

    const result = resolveRg(binDir);
    expect(result).toBeNull();
  });
});

// ── isRgAvailable ───────────────────────────────────────────────────────────

describe("isRgAvailable", () => {
  test("returns true when resolveRg finds a binary", () => {
    const binDir = makeTempDir();

    const rgPath = path.join(binDir, "rg");
    fs.writeFileSync(rgPath, "#!/bin/sh\necho rg\n");
    fs.chmodSync(rgPath, 0o755);

    expect(isRgAvailable(binDir)).toBe(true);
  });

  test("returns false when resolveRg finds nothing", () => {
    const emptyDir = makeTempDir();
    process.env.PATH = "";
    isolateCache();

    expect(isRgAvailable(emptyDir)).toBe(false);
  });

  test("boolean result matches resolveRg truthiness", () => {
    const binDir = makeTempDir();
    process.env.PATH = "";
    isolateCache();

    const resolved = resolveRg(binDir);
    const available = isRgAvailable(binDir);
    expect(available).toBe(resolved !== null);
  });
});
