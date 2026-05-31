import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the shared in-process
// harness (tests/_helpers/cli.ts). `enable`/`disable` persist registry toggles
// to XDG_CONFIG_HOME/akm/config.json, resolved from env not process.cwd(), so
// these run faithfully in-process against a sandboxed XDG triple. Env/temp-dir
// mutation goes through the allowlisted sandbox helpers (withEnv / makeSandboxDir).

const disposers: SandboxedDir[] = [];

function makeTempDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { stdout, stderr, code } = await withEnv(env, () => runCliCapture(args));
  return { status: code, stdout, stderr };
}

describe("component toggles", () => {
  test("akm disable skills.sh marks skills.sh registry as disabled", async () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const xdgData = makeTempDir("akm-toggle-data-");
    const xdgState = makeTempDir("akm-toggle-state-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = await runCli(["disable", "skills.sh", "--format=json"], {
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
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

  test("akm enable <unsupported-target> exits with usage error", async () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const xdgData = makeTempDir("akm-toggle-data-");
    const xdgState = makeTempDir("akm-toggle-state-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = await runCli(["enable", "context-hub", "--format=json"], {
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("Unsupported target");
  });

  test("akm disable <unsupported-target> exits with usage error", async () => {
    const xdgConfig = makeTempDir("akm-toggle-config-");
    const xdgCache = makeTempDir("akm-toggle-cache-");
    const xdgData = makeTempDir("akm-toggle-data-");
    const xdgState = makeTempDir("akm-toggle-state-");
    const stashDir = makeTempDir("akm-toggle-stash-");

    const result = await runCli(["disable", "context-hub", "--format=json"], {
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      AKM_STASH_DIR: stashDir,
    });

    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("Unsupported target");
  });
});
