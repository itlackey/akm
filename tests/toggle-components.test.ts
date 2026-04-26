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

  test("akm enable context-hub exits with usage error directing user to akm add", () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = runCli(["enable", "context-hub", "--format=json"], {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("akm add");
    expect(combined).toContain("context-hub");
  });

  test("akm disable context-hub exits with usage error directing user to akm add", () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = runCli(["disable", "context-hub", "--format=json"], {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("akm add");
  });
});
