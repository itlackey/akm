import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractTarGzSecure } from "../src/source-providers/tar-utils";

/**
 * Regression tests for the post-extraction scanner in `tar-utils.ts`.
 *
 * PR #168 review flagged that the previous `entry.name.includes("..")`
 * check rejected legitimate filenames like `archive..2024.tar` or
 * `foo..bar.md`. The scanner now only rejects exact "." / ".." segments
 * and instead enforces containment via `isWithin`.
 *
 * These tests construct real tarballs in a temp directory and run them
 * through the actual extraction path so the post-scan logic is exercised
 * end-to-end.
 */

const tmpDirs: string[] = [];

function tmpDir(prefix = "akm-tar-scan-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a tarball where the inner directory wraps two files. Returns the
 * tarball path and the destination dir for `extractTarGzSecure`.
 */
function buildTarball(rootName: string, entries: Array<{ name: string; body: string }>): string {
  const work = tmpDir("akm-tar-build-");
  const root = path.join(work, rootName);
  fs.mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.body, "utf8");
  }
  const tarPath = path.join(work, `${rootName}.tar.gz`);
  // Use system tar — present on macOS, Linux. The scanner is what we care
  // about; building the archive itself is incidental.
  const proc = Bun.spawnSync(["tar", "-czf", tarPath, "-C", work, rootName]);
  if (proc.exitCode !== 0) {
    throw new Error(`tar build failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
  return tarPath;
}

describe("scanExtractedFiles — filename .. substring guard (PR #168 review #8)", () => {
  test("accepts filenames containing `..` substrings (no false positive)", () => {
    const tarPath = buildTarball("pkg", [
      { name: "archive..2024.tar", body: "tar body bytes" },
      { name: "notes/foo..bar.md", body: "# notes" },
    ]);
    const dest = tmpDir("akm-tar-extract-");
    // Should NOT throw — these names previously failed the substring check.
    expect(() => extractTarGzSecure(tarPath, dest)).not.toThrow();
    expect(fs.existsSync(path.join(dest, "archive..2024.tar"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "notes/foo..bar.md"))).toBe(true);
  });

  test("accepts ordinary filenames", () => {
    const tarPath = buildTarball("pkg", [
      { name: "README.md", body: "# README" },
      { name: "src/main.ts", body: "export const x = 1;" },
    ]);
    const dest = tmpDir("akm-tar-extract-ok-");
    expect(() => extractTarGzSecure(tarPath, dest)).not.toThrow();
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "src/main.ts"))).toBe(true);
  });
});
