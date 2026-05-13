import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-graph-cli-neg-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts", "memories", ".akm"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

function runCli(args: string[], stashDir: string): { status: number; stdout: string; stderr: string } {
  const xdgCache = makeTempDir("akm-graph-cli-neg-cache-");
  const xdgConfig = makeTempDir("akm-graph-cli-neg-config-");
  const xdgData = makeTempDir("akm-graph-cli-neg-data-");
  const xdgState = makeTempDir("akm-graph-cli-neg-state-");
  const cliPath = path.join(path.resolve(import.meta.dir, "..", ".."), "src", "cli.ts");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("graph CLI negative paths", () => {
  test("export rejects invalid --format value", () => {
    const stash = makeStashDir();
    const outPath = path.join(stash, "graph-export.json");
    const result = runCli(["graph", "export", "--out", outPath, "--format", "yaml"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("--format");
  });

  test("export requires --out", () => {
    const stash = makeStashDir();
    const result = runCli(["graph", "export"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(parsed.error).toContain("requires --out");
  });

  test("summary fails when graph artifact is missing", () => {
    const stash = makeStashDir();
    const result = runCli(["graph", "summary"], stash);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("FILE_NOT_FOUND");
    expect(parsed.error).toContain("Graph artifact not found");
  });

  test("summary fails when graph artifact is invalid JSON", () => {
    const stash = makeStashDir();
    fs.writeFileSync(path.join(stash, ".akm", "graph.json"), "not-json\n", "utf8");
    const result = runCli(["graph", "summary"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("not valid JSON");
  });

  test("summary fails when graph artifact schema is invalid", () => {
    const stash = makeStashDir();
    fs.writeFileSync(
      path.join(stash, ".akm", "graph.json"),
      `${JSON.stringify({ schemaVersion: 999, generatedAt: "2026-01-01T00:00:00.000Z", stashRoot: stash, files: [] })}\n`,
      "utf8",
    );
    const result = runCli(["graph", "summary"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("schema is invalid or unsupported");
  });

  test("entities rejects non-positive --limit", () => {
    const stash = makeStashDir();
    const result = runCli(["graph", "entities", "--limit", "0"], stash);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("Invalid --limit value");
  });
});
