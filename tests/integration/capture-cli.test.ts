import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import { seedStoredGraph } from "../_helpers/graph-store";
import { withEnv } from "../_helpers/sandbox";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface CliRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// In-process replacement for the former spawnSync("bun", [CLI, ...]). Each call
// gets fresh, isolated XDG dirs and a temp stash (unless one is supplied via
// options.stashDir so a follow-up `show` reads the same stash). Env is set via
// the allowlisted `withEnv` wrapper and restored after the run, and the harness
// (runCliCapture) resets the config/output singletons per call. The returned
// shape mirrors spawnSync's `{ status, stdout, stderr }` so the existing
// assertions are byte-identical.
async function runCli(
  args: string[],
  options?: { stashDir?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stashDir: string; result: CliRunResult }> {
  const stashDir = options?.stashDir ?? makeTempDir("akm-capture-stash-");
  const xdgCache = makeTempDir("akm-capture-cache-");
  const xdgConfig = makeTempDir("akm-capture-config-");
  // Pair AKM_STASH_DIR with XDG_DATA_HOME / XDG_STATE_HOME so the
  // test-isolation guard in src/core/paths.ts stays inert.
  const xdgData = makeTempDir("akm-capture-data-");
  const xdgState = makeTempDir("akm-capture-state-");
  const result = await withEnv(
    {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      ...(options?.env as Record<string, string | undefined> | undefined),
    },
    async (): Promise<CliRunResult> => {
      const { code, stdout, stderr } = await runCliCapture(args);
      return { status: code, stdout, stderr };
    },
  );
  return { stashDir, result };
}

// KEPT AS A SUBPROCESS: the in-process harness has no stdin support, and `import
// -` reads piped content via fs.readFileSync(0) (real fd 0). Spawning a real
// subprocess is the faithful way to feed stdin, so the one `import -` test
// continues to shell out through this helper.
function spawnCli(
  args: string[],
  options?: { stashDir?: string; input?: string; env?: NodeJS.ProcessEnv },
): { stashDir: string; result: { status: number | null; stdout: string; stderr: string } } {
  const stashDir = options?.stashDir ?? makeTempDir("akm-capture-stash-");
  const xdgCache = makeTempDir("akm-capture-cache-");
  const xdgConfig = makeTempDir("akm-capture-config-");
  const xdgData = makeTempDir("akm-capture-data-");
  const xdgState = makeTempDir("akm-capture-state-");
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: options?.input,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      ...options?.env,
    },
  });
  return { stashDir, result: { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" } };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("capture commands", () => {
  async function expectInitFlagUsesCustomDir(flag: "--dir" | "--stashDir") {
    const parentDir = makeTempDir("akm-init-parent-");
    const customDir = path.join(parentDir, "custom-stash");
    const homeDir = makeTempDir("akm-init-home-");
    // Init's sandbox guard (item 6) refuses explicit --dir /tmp/... under a
    // test runner; this test legitimately exercises that flag, so opt out.
    const { result } = await runCli(["init", flag, customDir], {
      env: { HOME: homeDir, AKM_FORCE_INIT_TMP_STASH: "1" },
    });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { stashDir: string; configPath: string; created: boolean };
    expect(json.created).toBe(true);
    expect(json.stashDir).toBe(path.resolve(customDir));
    expect(fs.existsSync(path.join(customDir, "knowledge"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "akm"))).toBe(false);

    // #37: init persists the primary as a bundle (never the retired stashDir key).
    const config = JSON.parse(fs.readFileSync(json.configPath, "utf8")) as {
      stashDir?: string;
      defaultBundle?: string;
      bundles?: Record<string, { path?: string }>;
    };
    expect(config.stashDir).toBeUndefined();
    const primary = config.defaultBundle ? config.bundles?.[config.defaultBundle] : undefined;
    expect(primary?.path).toBe(path.resolve(customDir));
  }

  test("init honors --dir for a custom stash path", async () => {
    await expectInitFlagUsesCustomDir("--dir");
  });

  test("init honors legacy --stashDir as an alias for --dir", async () => {
    await expectInitFlagUsesCustomDir("--stashDir");
  });

  test("remember stores a memory in the stash and returns its ref", async () => {
    const { stashDir, result } = await runCli(["remember", "Deployment needs VPN access"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memories/deployment-needs-vpn-access");
    expect(fs.existsSync(path.join(stashDir, "memories", "deployment-needs-vpn-access.md"))).toBe(true);

    const show = (await runCli(["show", json.ref], { stashDir })).result;
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Deployment needs VPN access");
  });

  test("remember prints a helpful error when no content is provided", async () => {
    const { result } = await runCli(["remember"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("Memory content is required");
  });

  test("remember rejects a `/` in --name (flat names only; traversal blocked)", async () => {
    const { result } = await runCli(["remember", "Sensitive note", "--name", "../../etc/passwd"]);
    expect(result.status).toBe(2);

    // `--name` is a flat name now; any `/` (including traversal) is rejected
    // and the user is pointed at `--path` for subdirectories.
    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("--path");
  });

  test("remember rejects parent-directory traversal in --path", async () => {
    const { result } = await runCli(["remember", "Sensitive note", "--path", "../../etc", "--name", "passwd"]);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("relative directory without '.' or '..' segments");
  });

  test("import stores a knowledge document using the source filename by default", async () => {
    const sourceDir = makeTempDir("akm-capture-source-");
    const sourcePath = path.join(sourceDir, "release-notes.md");
    fs.writeFileSync(sourcePath, "# Release Notes\n\nShip it.\n", "utf8");

    const { stashDir, result } = await runCli(["import", sourcePath]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge/release-notes");
    expect(fs.existsSync(path.join(stashDir, "knowledge", "release-notes.md"))).toBe(true);

    const show = (await runCli(["show", json.ref], { stashDir })).result;
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("# Release Notes");
  });

  test("import accepts stdin when source is '-'", () => {
    // KEPT AS A SUBPROCESS: `import -` reads stdin via fs.readFileSync(0); the
    // in-process harness has no stdin shim. spawnCli feeds the piped input.
    const { stashDir, result } = spawnCli(["import", "-", "--name", "scratch-notes"], {
      input: "# Scratch Notes\n\nRemember the rollout freeze.\n",
    });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ref: string };
    expect(json.ref).toBe("knowledge/scratch-notes");
    expect(fs.existsSync(path.join(stashDir, "knowledge", "scratch-notes.md"))).toBe(true);
  });

  test("import rejects an empty normalized knowledge name", async () => {
    const sourceDir = makeTempDir("akm-capture-source-");
    const sourcePath = path.join(sourceDir, "notes.md");
    fs.writeFileSync(sourcePath, "# Notes\n", "utf8");

    const { result } = await runCli(["import", sourcePath, "--name", ".md"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("Asset name cannot be empty");
  });

  test("graph summary and entities commands return structured output", async () => {
    const stashDir = makeTempDir("akm-capture-graph-stash-");
    const xdgData = makeTempDir("akm-capture-graph-data-");
    seedStoredGraph(
      {
        schemaVersion: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          {
            path: path.join(stashDir, "knowledge", "k1.md"),
            type: "knowledge",
            entities: ["alpha", "beta"],
            relations: [{ from: "alpha", to: "beta", type: "uses" }],
          },
        ],
        entities: ["alpha", "beta"],
        relations: [{ from: "alpha", to: "beta", type: "uses" }],
        quality: {
          consideredFiles: 1,
          extractedFiles: 1,
          entityCount: 2,
          relationCount: 1,
          extractionCoverage: 1,
          density: 1,
        },
      },
      path.join(xdgData, "akm", "index.db"),
    );

    const summary = (
      await runCli(["graph", "summary", "--format=json"], {
        stashDir,
        env: { XDG_DATA_HOME: xdgData },
      })
    ).result;
    expect(summary.status).toBe(0);
    const summaryJson = JSON.parse(summary.stdout) as { shape: string; entityCount: number; relationCount: number };
    expect(summaryJson.shape).toBe("graph-summary");
    expect(summaryJson.entityCount).toBe(2);
    expect(summaryJson.relationCount).toBe(1);

    const entities = (
      await runCli(["graph", "entities", "--limit", "1", "--format=json"], {
        stashDir,
        env: { XDG_DATA_HOME: xdgData },
      })
    ).result;
    expect(entities.status).toBe(0);
    const entitiesJson = JSON.parse(entities.stdout) as {
      shape: string;
      entities: Array<{ name: string; fileCount: number }>;
    };
    expect(entitiesJson.shape).toBe("graph-entities");
    expect(entitiesJson.entities).toEqual([{ name: "alpha", fileCount: 1 }]);
  });
});
