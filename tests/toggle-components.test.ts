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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("component toggles", () => {
  test("akm disable skills.sh marks skills.sh registry as disabled", () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = runCli(["disable", "skills.sh", "--format=json"], {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).enabled).toBe(false);

    const configPath = path.join(xdgConfig, "akm", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      registries?: Array<{ name?: string; provider?: string; enabled?: boolean }>;
    };
    const skillsRegistry = config.registries?.find(
      (entry) => entry.name === "skills.sh" || entry.provider === "skills-sh",
    );
    expect(skillsRegistry).toBeDefined();
    expect(skillsRegistry?.enabled).toBe(false);
  });

  test("akm enable context-hub adds context-hub stash when missing", () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = runCli(["enable", "context-hub", "--format=json"], {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).enabled).toBe(true);

    const configPath = path.join(xdgConfig, "akm", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      stashes?: Array<{ type?: string; url?: string; name?: string; enabled?: boolean }>;
    };
    expect(config.stashes).toContainEqual({
      type: "git",
      url: "https://github.com/andrewyng/context-hub",
      name: "context-hub",
      enabled: true,
    });
  });

  test("akm enable context-hub is idempotent when already enabled", () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const stashDir = makeTempDir("akm-toggle-stash-");
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      AKM_STASH_DIR: stashDir,
    };

    const first = runCli(["enable", "context-hub", "--format=json"], env);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).changed).toBe(true);

    const second = runCli(["enable", "context-hub", "--format=json"], env);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).changed).toBe(false);
  });

  test("akm disable context-hub marks matching stash as disabled", () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const stashDir = makeTempDir("akm-toggle-stash-");
    const configDir = path.join(xdgConfig, "akm");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      `${JSON.stringify(
        {
          semanticSearchMode: "auto",
          stashes: [{ type: "git", url: "https://github.com/andrewyng/context-hub", name: "context-hub" }],
        },
        null,
        2,
      )}\n`,
    );

    const result = runCli(["disable", "context-hub", "--format=json"], {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).enabled).toBe(false);

    const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")) as {
      stashes?: Array<{ name?: string; url?: string; enabled?: boolean }>;
    };
    const contextHub = config.stashes?.find(
      (stash) => stash.name === "context-hub" || stash.url === "https://github.com/andrewyng/context-hub",
    );
    expect(contextHub?.enabled).toBe(false);
  });
});
