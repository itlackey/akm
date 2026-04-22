import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createWorkingStash(): string {
  const dir = makeTempDir("akm-add-context-hub-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm add context-hub alias", () => {
  test("routes to stash add for the official Context Hub repository", () => {
    const stashDir = createWorkingStash();
    const xdgCache = makeTempDir("akm-add-context-hub-cache-");
    const xdgConfig = makeTempDir("akm-add-context-hub-config-");

    const result = spawnSync("bun", [CLI, "add", "context-hub", "--format=json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
      },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      added: boolean;
      entry?: { type?: string; url?: string; name?: string };
    };
    expect(parsed.added).toBe(true);
    expect(parsed.entry).toEqual({
      type: "git",
      url: "https://github.com/andrewyng/context-hub",
      name: "context-hub",
    });

    const configPath = path.join(xdgConfig, "akm", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      stashes?: Array<{ type?: string; url?: string; name?: string }>;
    };
    expect(config.stashes).toContainEqual({
      type: "git",
      url: "https://github.com/andrewyng/context-hub",
      name: "context-hub",
    });
  });
});
