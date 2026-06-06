import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../src/core/config";
import { runCliCapture } from "./_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome, withEnv } from "./_helpers/sandbox";

// In-process harness (tests/_helpers/cli.ts): each runCli pins a fresh isolated
// set of XDG dirs plus AKM_STASH_DIR and resets the config cache before driving
// the CLI. `akm move` relocates an existing asset and reindexes (index.db, not
// state.db), so the in-process write does not contend with the suite's open
// state DB.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function runCli(stashDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const xdgCache = makeTempDir("akm-move-cache-");
  const xdgConfig = makeTempDir("akm-move-config-");
  const xdgData = makeTempDir("akm-move-data-");
  return withEnv(
    {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
    },
    async () => {
      resetConfigCache();
      const res = await runCliCapture(args);
      return { code: res.code, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
    },
  );
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("move command", () => {
  function makeStash(): string {
    const stashDir = makeTempDir("akm-move-stash-");
    writeFile(path.join(stashDir, "knowledge", "guide.md"), "# Guide\n\nHow to do the thing.\n");
    writeFile(path.join(stashDir, "knowledge", "other.md"), "# Other\n\nAnother doc.\n");
    writeFile(
      path.join(stashDir, "skills", "release-review", "SKILL.md"),
      "---\ndescription: Review a release plan\n---\n# Release Review\nCheck rollout.\n",
    );
    return stashDir;
  }

  test("relocates a knowledge asset into a subdirectory and reindexes", async () => {
    const stashDir = makeStash();
    const oldPath = path.join(stashDir, "knowledge", "guide.md");
    const newPath = path.join(stashDir, "knowledge", "personal", "guide.md");

    const res = await runCli(stashDir, ["move", "knowledge:guide.md", "knowledge:personal/guide.md", "--format=json"]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as { ok: boolean; from: string; to: string; toPath: string };
    expect(json.ok).toBe(true);
    expect(json.from).toBe("knowledge:guide.md");
    expect(json.to).toBe("knowledge:personal/guide.md");

    // File physically moved; old path gone, new path present.
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.readFileSync(newPath, "utf8")).toContain("How to do the thing.");

    // show resolves the new subpath (reindex occurred).
    const shown = await runCli(stashDir, ["show", "knowledge:personal/guide.md", "--format=json"]);
    expect(shown.code).toBe(0);
    const shownJson = JSON.parse(shown.stdout) as { content?: string };
    expect(shownJson.content ?? "").toContain("How to do the thing.");
  });

  test("accepts a bare subpath destination (inherits source type)", async () => {
    const stashDir = makeStash();
    const res = await runCli(stashDir, ["move", "knowledge:guide.md", "team/guide.md", "--format=json"]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "team", "guide.md"))).toBe(true);
  });

  test("moves a directory-style skill asset as a unit", async () => {
    const stashDir = makeStash();
    const res = await runCli(stashDir, ["move", "skill:release-review", "skill:ops/release-review", "--format=json"]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(stashDir, "skills", "release-review"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "skills", "ops", "release-review", "SKILL.md"))).toBe(true);
  });

  test("refuses when the source asset does not exist", async () => {
    const stashDir = makeStash();
    const res = await runCli(stashDir, ["move", "knowledge:nope.md", "knowledge:sub/nope.md", "--format=json"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/not found/i);
  });

  test("refuses when the destination already exists", async () => {
    const stashDir = makeStash();
    const res = await runCli(stashDir, ["move", "knowledge:guide.md", "knowledge:other.md", "--format=json"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/already exists/i);
    // Source untouched after a refused move.
    expect(fs.existsSync(path.join(stashDir, "knowledge", "guide.md"))).toBe(true);
  });

  test("refuses a destination that would change the asset type", async () => {
    const stashDir = makeStash();
    const res = await runCli(stashDir, ["move", "knowledge:guide.md", "command:guide.md", "--format=json"]);
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/type/i);
  });

  test("rejects a path-traversal destination", async () => {
    const stashDir = makeStash();
    const res = await runCli(stashDir, ["move", "knowledge:guide.md", "knowledge:../escape.md", "--format=json"]);
    expect(res.code).not.toBe(0);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "guide.md"))).toBe(true);
  });
});
