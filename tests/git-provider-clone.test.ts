import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneRepo } from "../src/sources/providers/git";

// ── Helpers ──────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function makeTempDir(prefix = "akm-clone-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cloneRepo: safe staging on failure", () => {
  test("leaves an existing destDir untouched when the remote is unreachable", () => {
    const destDir = makeTempDir("akm-clone-dest-");

    // Seed destDir with a sentinel file that proves the directory was already
    // populated before the failed clone attempt.
    const sentinelPath = path.join(destDir, "sentinel.txt");
    fs.writeFileSync(sentinelPath, "cached-content", "utf8");

    // A bogus git URL that will never succeed (no service listening on port 1).
    const bogusUrl = "git://127.0.0.1:1/nothing.git";

    // The clone must throw — network is down.
    expect(() => cloneRepo(bogusUrl, null, destDir)).toThrow();

    // Critical assertion: the previously-valid destDir must still be intact.
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("cached-content");
  });

  test("does not leave orphaned temp dirs after a failed clone", () => {
    const parentDir = makeTempDir("akm-clone-parent-");
    const destDir = path.join(parentDir, "repo");
    // destDir does not pre-exist — fresh clone scenario.

    const bogusUrl = "git://127.0.0.1:1/nothing.git";

    expect(() => cloneRepo(bogusUrl, null, destDir)).toThrow();

    // Ensure no .tmp-* sibling was left behind.
    const siblings = fs.readdirSync(parentDir);
    const tmpSiblings = siblings.filter((f) => f.includes(".tmp-"));
    expect(tmpSiblings).toHaveLength(0);
  });
});
