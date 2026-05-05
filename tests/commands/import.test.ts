/**
 * import --target tests
 *
 * Verifies the `--target` flag added to `akm import` per v1 implementation
 * plan §6 decision 3. Resolution order is:
 *   --target → defaultWriteTarget → working stash → ConfigError
 *
 * These tests exercise the explicit-target path:
 *   - resolves to a configured filesystem source by name
 *   - errors on unknown target names (UsageError)
 *   - errors on non-writable targets (ConfigError)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(configDir: string, body: Record<string, unknown>): void {
  const akmDir = path.join(configDir, "akm");
  fs.mkdirSync(akmDir, { recursive: true });
  fs.writeFileSync(path.join(akmDir, "config.json"), JSON.stringify(body, null, 2), "utf8");
}

function runCli(args: string[], options: { stashDir?: string; configDir: string; input?: string }) {
  const stashDir = options.stashDir ?? makeTempDir("akm-import-stash-");
  const xdgCache = makeTempDir("akm-import-cache-");
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: options.input,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      AKM_CONFIG_DIR: path.join(options.configDir, "akm"),
      XDG_CACHE_HOME: xdgCache,
    },
  });
  return { stashDir, result };
}

async function runCliAsync(args: string[], options: { stashDir?: string; configDir: string; input?: string }) {
  const stashDir = options.stashDir ?? makeTempDir("akm-import-stash-");
  const xdgCache = makeTempDir("akm-import-cache-");
  const child = spawn("bun", [CLI, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      AKM_CONFIG_DIR: path.join(options.configDir, "akm"),
      XDG_CACHE_HOME: xdgCache,
    },
  });
  let stdout = "";
  let stderr = "";
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const status = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CLI timed out after 30000ms"));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return { stashDir, result: { status, stdout, stderr } };
}

function makeKnowledgeFile(name: string, body: string): string {
  const dir = makeTempDir("akm-import-source-");
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("import --target", () => {
  test("--target resolves to a configured filesystem source", () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "writable-target", path: targetDir, writable: true }],
    });
    const sourcePath = makeKnowledgeFile("auth-flow.md", "# Auth flow\n\nOAuth2 walk-through.\n");

    const { stashDir, result } = runCli(["import", sourcePath, "--target", "writable-target"], { configDir });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge:auth-flow");

    const expectedPath = path.join(targetDir, "knowledge", "auth-flow.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "auth-flow.md"))).toBe(false);
  });

  test("--target with an unknown source name throws a usage error", () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "real-target", path: targetDir, writable: true }],
    });
    const sourcePath = makeKnowledgeFile("notes.md", "# Notes\n\nSomething.\n");

    const { result } = runCli(["import", sourcePath, "--target", "ghost"], { configDir });
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "ghost" is configured');
    expect(json.error).toContain("--target must reference a source name");
  });

  test("--target on a non-writable source throws a config error", () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "read-only", path: targetDir, writable: false }],
    });
    const sourcePath = makeKnowledgeFile("notes.md", "# Notes\n\nSomething.\n");

    const { result } = runCli(["import", sourcePath, "--target", "read-only"], { configDir });
    expect(result.status).not.toBe(0);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("source read-only is not writable");
  });

  test("imports a URL into knowledge using a URL-path-derived name", async () => {
    const configDir = makeTempDir("akm-import-config-");
    writeConfig(configDir, { semanticSearchMode: "off" });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><title>Guide Title</title></head><body><h1>Guide Title</h1><p>Hello <strong>world</strong>.</p></body></html>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");

    try {
      const url = `http://127.0.0.1:${address.port}/docs/guide`;
      const { stashDir, result } = await runCliAsync(["import", url], { configDir });
      expect(result.status).toBe(0);

      const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
      expect(json.ok).toBe(true);
      expect(json.ref).toBe("knowledge:docs/guide");

      const expectedPath = path.join(stashDir, "knowledge", "docs", "guide.md");
      expect(json.path).toBe(expectedPath);
      const body = fs.readFileSync(expectedPath, "utf8");
      expect(body).toContain('sourceUrl: "http://127.0.0.1:');
      expect(body).toContain("# Guide Title");
      expect(body).toContain("Hello");
      expect(body).toContain("world");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
