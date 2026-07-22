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
 *
 * Migrated from per-test spawnSync/spawn("bun", ["src/cli.ts", ...]) to the
 * shared in-process harness (tests/_helpers/cli.ts). Every case here imports
 * from a file path or a URL (never the "-" stdin source), so none needs to feed
 * process.stdin — they all run in-process. The URL case still performs a real
 * fetch against a local HTTP server, which the in-process CLI does natively.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resetGraphBoostCache } from "../../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../../src/llm/embedder";
import { runCliCapture } from "../../_helpers/cli";
import { withEnv } from "../../_helpers/sandbox";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(configDir: string, body: Record<string, unknown>): void {
  const akmDir = path.join(configDir, "akm");
  fs.mkdirSync(akmDir, { recursive: true });
  fs.writeFileSync(
    path.join(akmDir, "config.json"),
    JSON.stringify({ configVersion: "0.9.0", ...body }, null, 2),
    "utf8",
  );
}

/**
 * In-process CLI runner. Pins the test's isolated stash + config dirs for the
 * duration of the call (via the allowlisted withEnv helper) and resets the
 * embedder/graph singletons so the run reads the pinned env, matching what a
 * fresh subprocess got for free. runCliCapture resets the config and
 * output-mode singletons itself.
 */
async function runCli(args: string[], options: { stashDir?: string; configDir: string }) {
  const stashDir = options.stashDir ?? makeTempDir("akm-import-stash-");
  const xdgCache = makeTempDir("akm-import-cache-");
  const xdgData = makeTempDir("akm-import-data-");
  const xdgState = makeTempDir("akm-import-state-");
  const result = await withEnv(
    {
      AKM_STASH_DIR: stashDir,
      AKM_CONFIG_DIR: path.join(options.configDir, "akm"),
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
    async () => {
      clearEmbeddingCache();
      resetLocalEmbedder();
      resetGraphBoostCache();
      const { stdout, stderr, code } = await runCliCapture(args);
      return { status: code, stdout, stderr };
    },
  );
  return { stashDir, result };
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
  test("--target resolves to a configured filesystem source", async () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      bundles: { "writable-target": { path: targetDir, writable: true } },
    });
    const sourcePath = makeKnowledgeFile("auth-flow.md", "# Auth flow\n\nOAuth2 walk-through.\n");

    const { stashDir, result } = await runCli(["import", sourcePath, "--target", "writable-target"], { configDir });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge/auth-flow");

    const expectedPath = path.join(targetDir, "knowledge", "auth-flow.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "auth-flow.md"))).toBe(false);
  });

  test("--target with an unknown source name throws a usage error", async () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      bundles: { "real-target": { path: targetDir, writable: true } },
    });
    const sourcePath = makeKnowledgeFile("notes.md", "# Notes\n\nSomething.\n");

    const { result } = await runCli(["import", sourcePath, "--target", "ghost"], { configDir });
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "ghost" is configured');
    expect(json.error).toContain("--target must reference a source name");
  });

  test("--target on a non-writable source throws a config error", async () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      bundles: { "read-only": { path: targetDir, writable: false } },
    });
    const sourcePath = makeKnowledgeFile("notes.md", "# Notes\n\nSomething.\n");

    const { result } = await runCli(["import", sourcePath, "--target", "read-only"], { configDir });
    expect(result.status).not.toBe(0);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("source read-only is not writable");
  });

  test("--target routes to a configured filesystem source", async () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      bundles: { "secondary-stash": { path: targetDir, writable: true } },
    });
    const sourcePath = makeKnowledgeFile("overview.md", "# Overview\n\nSome content.\n");

    const { stashDir, result } = await runCli(["import", sourcePath, "--target", "secondary-stash"], { configDir });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge/overview");

    const expectedPath = path.join(targetDir, "knowledge", "overview.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "overview.md"))).toBe(false);
  });

  test("default stash is used when --target is omitted", async () => {
    const configDir = makeTempDir("akm-import-config-");
    writeConfig(configDir, { semanticSearchMode: "off" });
    const sourcePath = makeKnowledgeFile("default-stash.md", "# Default stash\n\nContent.\n");

    const { stashDir, result } = await runCli(["import", sourcePath], { configDir });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge/default-stash");

    const expectedPath = path.join(stashDir, "knowledge", "default-stash.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  test("--target with an unknown source name throws a usage error", async () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      bundles: { "real-stash": { path: targetDir, writable: true } },
    });
    const sourcePath = makeKnowledgeFile("notes.md", "# Notes\n\nSomething.\n");

    const { result } = await runCli(["import", sourcePath, "--target", "no-such-stash"], { configDir });
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "no-such-stash" is configured');
    expect(json.error).toContain("--target must reference a source name");
  });

  test("--target on a non-writable source throws a config error", async () => {
    const configDir = makeTempDir("akm-import-config-");
    const targetDir = makeTempDir("akm-import-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      bundles: { "locked-stash": { path: targetDir, writable: false } },
    });
    const sourcePath = makeKnowledgeFile("notes.md", "# Notes\n\nSomething.\n");

    const { result } = await runCli(["import", sourcePath, "--target", "locked-stash"], { configDir });
    expect(result.status).not.toBe(0);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("source locked-stash is not writable");
  });

  test("imports a URL into knowledge using a URL-path-derived name", async () => {
    const configDir = makeTempDir("akm-import-config-");
    writeConfig(configDir, { semanticSearchMode: "off" });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(
        "<html><head><title>Guide Title</title></head><body><h1>Guide Title</h1><p>Hello <strong>world</strong>.</p></body></html>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");

    try {
      const url = `http://127.0.0.1:${address.port}/docs/guide`;
      const { stashDir, result } = await runCli(["import", url], { configDir });
      expect(result.status).toBe(0);

      const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
      expect(json.ok).toBe(true);
      expect(json.ref).toBe("knowledge/docs/guide");

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
