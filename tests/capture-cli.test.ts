import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedStoredGraph } from "./helpers/graph-store";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], options?: { stashDir?: string; input?: string; env?: NodeJS.ProcessEnv }) {
  const stashDir = options?.stashDir ?? makeTempDir("akm-capture-stash-");
  const xdgCache = makeTempDir("akm-capture-cache-");
  const xdgConfig = makeTempDir("akm-capture-config-");
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: options?.input,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      ...options?.env,
    },
  });
  return { stashDir, result };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("capture commands", () => {
  function expectInitFlagUsesCustomDir(flag: "--dir" | "--stashDir") {
    const parentDir = makeTempDir("akm-init-parent-");
    const customDir = path.join(parentDir, "custom-stash");
    const homeDir = makeTempDir("akm-init-home-");
    const { result } = runCli(["init", flag, customDir], { env: { HOME: homeDir } });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { stashDir: string; configPath: string; created: boolean };
    expect(json.created).toBe(true);
    expect(json.stashDir).toBe(path.resolve(customDir));
    expect(fs.existsSync(path.join(customDir, "knowledge"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, "akm"))).toBe(false);

    const config = JSON.parse(fs.readFileSync(json.configPath, "utf8")) as { stashDir?: string };
    expect(config.stashDir).toBe(path.resolve(customDir));
  }

  test("init honors --dir for a custom stash path", () => {
    expectInitFlagUsesCustomDir("--dir");
  });

  test("init honors legacy --stashDir as an alias for --dir", () => {
    expectInitFlagUsesCustomDir("--stashDir");
  });

  test("remember stores a memory in the stash and returns its ref", () => {
    const { stashDir, result } = runCli(["remember", "Deployment needs VPN access"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memory:deployment-needs-vpn-access");
    expect(fs.existsSync(path.join(stashDir, "memories", "deployment-needs-vpn-access.md"))).toBe(true);

    const show = runCli(["show", json.ref], { stashDir }).result;
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Deployment needs VPN access");
  });

  test("remember prints a helpful error when no content is provided", () => {
    const { result } = runCli(["remember"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("Memory content is required");
  });

  test("remember rejects names with parent-directory traversal", () => {
    const { result } = runCli(["remember", "Sensitive note", "--name", "../../etc/passwd"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("relative path without '.' or '..' segments");
  });

  test("import stores a knowledge document using the source filename by default", () => {
    const sourceDir = makeTempDir("akm-capture-source-");
    const sourcePath = path.join(sourceDir, "release-notes.md");
    fs.writeFileSync(sourcePath, "# Release Notes\n\nShip it.\n", "utf8");

    const { stashDir, result } = runCli(["import", sourcePath]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge:release-notes");
    expect(fs.existsSync(path.join(stashDir, "knowledge", "release-notes.md"))).toBe(true);

    const show = runCli(["show", json.ref], { stashDir }).result;
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("# Release Notes");
  });

  test("import accepts stdin when source is '-'", () => {
    const { stashDir, result } = runCli(["import", "-", "--name", "scratch-notes"], {
      input: "# Scratch Notes\n\nRemember the rollout freeze.\n",
    });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ref: string };
    expect(json.ref).toBe("knowledge:scratch-notes");
    expect(fs.existsSync(path.join(stashDir, "knowledge", "scratch-notes.md"))).toBe(true);
  });

  test("import rejects an empty normalized knowledge name", () => {
    const sourceDir = makeTempDir("akm-capture-source-");
    const sourcePath = path.join(sourceDir, "notes.md");
    fs.writeFileSync(sourcePath, "# Notes\n", "utf8");

    const { result } = runCli(["import", sourcePath, "--name", ".md"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("Asset name cannot be empty");
  });

  test("graph summary and entities commands return structured output", () => {
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

    const summary = runCli(["graph", "summary", "--format=json"], {
      stashDir,
      env: { XDG_DATA_HOME: xdgData },
    }).result;
    expect(summary.status).toBe(0);
    const summaryJson = JSON.parse(summary.stdout) as { shape: string; entityCount: number; relationCount: number };
    expect(summaryJson.shape).toBe("graph-summary");
    expect(summaryJson.entityCount).toBe(2);
    expect(summaryJson.relationCount).toBe(1);

    const entities = runCli(["graph", "entities", "--limit", "1", "--format=json"], {
      stashDir,
      env: { XDG_DATA_HOME: xdgData },
    }).result;
    expect(entities.status).toBe(0);
    const entitiesJson = JSON.parse(entities.stdout) as {
      shape: string;
      entities: Array<{ name: string; fileCount: number }>;
    };
    expect(entitiesJson.shape).toBe("graph-entities");
    expect(entitiesJson.entities).toEqual([{ name: "alpha", fileCount: 1 }]);
  });
});
