import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { formatSearchPlain } from "../../src/output/text";
import { seedStoredGraph } from "../_helpers/graph-store";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");
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

function writeConfig(configDir: string, config: Record<string, unknown>): void {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function ensureFreshRecoveryBundle(stashDir: string, dirs: Required<CliEnvDirs>): void {
  const result = spawnSync("bun", [CLI, "backup", "create", "--for", "0.9.0"], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: dirs.xdgCache,
      XDG_CONFIG_HOME: dirs.xdgConfig,
      XDG_DATA_HOME: dirs.xdgData,
      XDG_STATE_HOME: dirs.xdgState,
    },
  });
  expect(result.status).toBe(0);
}

interface CliEnvDirs {
  xdgCache: string;
  xdgConfig: string;
  xdgData?: string;
  xdgState?: string;
}

function envDirsForStash(_stashDir: string): Required<CliEnvDirs> {
  return {
    xdgCache: makeTempDir("akm-output-cache-shared-"),
    xdgConfig: makeTempDir("akm-output-config-shared-"),
    xdgData: makeTempDir("akm-output-data-shared-"),
    xdgState: makeTempDir("akm-output-state-shared-"),
  };
}

function runCli(stashDir: string, args: string[], config?: Record<string, unknown>, envDirs?: CliEnvDirs): string {
  const xdgCache = envDirs?.xdgCache ?? makeTempDir("akm-output-cache-");
  const xdgConfig = envDirs?.xdgConfig ?? makeTempDir("akm-output-config-");
  const xdgData = envDirs?.xdgData ?? makeTempDir("akm-output-data-");
  const xdgState = envDirs?.xdgState ?? makeTempDir("akm-output-state-");
  const dirs = { xdgCache, xdgConfig, xdgData, xdgState };
  if (config) ensureFreshRecoveryBundle(stashDir, dirs);
  if (config) writeConfig(xdgConfig, config);
  const result = spawnSync("bun", [CLI, ...args], {
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
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

async function runCliAsync(stashDir: string, args: string[], config?: Record<string, unknown>): Promise<string> {
  const xdgCache = makeTempDir("akm-output-cache-");
  const xdgConfig = makeTempDir("akm-output-config-");
  const xdgData = makeTempDir("akm-output-data-");
  const xdgState = makeTempDir("akm-output-state-");
  const dirs = { xdgCache, xdgConfig, xdgData, xdgState };
  // Semantic off keeps auto-index stderr deterministic: with the default
  // ("auto") the local embedder fetches its model from huggingface.co and a
  // blocked/offline fetch emits "Embedding generation failed" on stderr,
  // tripping the stderr-cleanliness check below. This test suite pins output
  // shapes, not semantic ranking.
  ensureFreshRecoveryBundle(stashDir, dirs);
  writeConfig(xdgConfig, { configVersion: "0.9.0", semanticSearchMode: "off", ...(config ?? {}) });

  const child = spawn("bun", [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  expect(exitCode).toBe(0);
  // Auto-index may produce progress output on stderr; only fail on actual errors
  const isAutoIndexOutput =
    stderr.includes("Starting") ||
    stderr.includes("Scanned") ||
    stderr.includes("Rebuilt") ||
    stderr.includes("[embed]");
  if (stderr.trim() && !isAutoIndexOutput) {
    expect(stderr.trim()).toBe("");
  }
  return stdout.trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("output baseline", () => {
  test("show full JSON can include related graph neighbors", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const envDirs = envDirsForStash(stashDir);
    writeFile(path.join(stashDir, "knowledge", "guide.md"), "# Guide\nUse this.\n");
    writeFile(path.join(stashDir, "memories", "incident.md"), "# Incident\nFollow guide.\n");
    seedStoredGraph(
      {
        schemaVersion: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          {
            path: path.join(stashDir, "knowledge", "guide.md"),
            type: "knowledge",
            entities: ["Guide", "Deploy"],
            relations: [{ from: "Guide", to: "Deploy" }],
          },
          {
            path: path.join(stashDir, "memories", "incident.md"),
            type: "memory",
            entities: ["Guide"],
            relations: [{ from: "Guide", to: "Incident" }],
          },
        ],
      },
      path.join(envDirs.xdgData, "akm", "index.db"),
    );

    const output = runCli(
      stashDir,
      ["show", "knowledge:guide.md", "--format=json", "--detail=full"],
      undefined,
      envDirs,
    );
    const json = JSON.parse(output) as Record<string, unknown>;

    expect(json.related).toBeTruthy();
  });

  test("show full JSON includes empty related object when no graph neighbors exist", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const envDirs = envDirsForStash(stashDir);
    writeFile(path.join(stashDir, "knowledge", "guide.md"), "# Guide\nUse this.\n");
    seedStoredGraph(
      {
        schemaVersion: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          {
            path: path.join(stashDir, "knowledge", "guide.md"),
            type: "knowledge",
            entities: ["Guide"],
            relations: [],
          },
        ],
      },
      path.join(envDirs.xdgData, "akm", "index.db"),
    );

    const output = runCli(
      stashDir,
      ["show", "knowledge:guide.md", "--format=json", "--detail=full"],
      undefined,
      envDirs,
    );
    const json = JSON.parse(output) as { related?: { total?: number; hits?: unknown[] } };

    expect(json.related).toEqual({ total: 0, hits: [] });
  });

  test("show text output uses compact related labels", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const envDirs = envDirsForStash(stashDir);
    writeFile(path.join(stashDir, "knowledge", "guide.md"), "# Guide\nUse this.\n");
    writeFile(path.join(stashDir, "memories", "incident.md"), "# Incident\nFollow guide.\n");
    seedStoredGraph(
      {
        schemaVersion: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          {
            path: path.join(stashDir, "knowledge", "guide.md"),
            type: "knowledge",
            entities: ["Guide", "Deploy"],
            relations: [{ from: "Guide", to: "Deploy" }],
          },
          {
            path: path.join(stashDir, "memories", "incident.md"),
            type: "memory",
            entities: ["Guide"],
            relations: [{ from: "Guide", to: "Incident" }],
          },
        ],
      },
      path.join(envDirs.xdgData, "akm", "index.db"),
    );

    const output = runCli(
      stashDir,
      ["show", "knowledge:guide.md", "--format=text", "--detail=full"],
      undefined,
      envDirs,
    );

    expect(output).toContain("related: 1");
    // Schema v2: listRelatedPathsForFile populates `ref` via entries.entry_key,
    // and formatRelatedLabel prefers it over basename. Output is now canonical
    // ref form (`memory:incident`) instead of `incident.md`.
    expect(output).toContain("  - memory: memory:incident");
    expect(output).toContain("    shared: Guide");
    expect(output).not.toContain(path.join(stashDir, "memories", "incident.md"));
  });

  test("search text output uses query match and neighbors graph labels", () => {
    const output = formatSearchPlain(
      {
        hits: [
          {
            type: "knowledge",
            name: "guide",
            action: "akm show knowledge:guide -> read reference material",
            score: 1,
            graph: {
              entities: [
                { name: "Guide", kind: "matched" },
                { name: "Incident", kind: "connected" },
              ],
              relations: [{ from: "Guide", to: "Incident" }],
            },
          },
        ],
      },
      "normal",
    );

    expect(output).toContain("graph: query match=");
    expect(output).toContain("neighbors=");
  });

  test("config defaults drive output mode and CLI flags override them", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const config = { configVersion: "0.9.0", output: { format: "text", detail: "normal" } };
    const configDriven = runCli(stashDir, ["search", "deploy"], config);
    expect(configDriven).toContain("score:");

    const overridden = runCli(stashDir, ["search", "deploy", "--format=json", "--detail=brief"], config);
    const json = JSON.parse(overridden) as { hits: Array<Record<string, unknown>> };
    // hits is always present; warnings may appear when semantic search is pending
    expect(Object.keys(json)).toContain("hits");
    expect(Object.keys(json.hits[0] ?? {})).not.toContain("origin");
  });

  test("search shaped output includes action for local and registry hits", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const registryDir = makeTempDir("akm-output-registry-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(
      path.join(registryDir, "index.json"),
      JSON.stringify({
        version: 3,
        updatedAt: "2026-03-11T00:00:00Z",
        stashes: [
          {
            id: "npm:@scope/deploy-stash",
            name: "deploy-stash",
            description: "Registry deploy stash",
            ref: "@scope/deploy-stash",
            source: "npm",
            tags: ["deploy"],
          },
        ],
      }),
    );
    const server = http.createServer((req, res) => {
      if (req.url === "/index.json") {
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(fs.readFileSync(path.join(registryDir, "index.json"), "utf8"));
        return;
      }
      res.writeHead(404, { Connection: "close" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start test registry server");
    }

    try {
      const output = await runCliAsync(
        stashDir,
        ["search", "deploy", "--format=json", "--detail=brief", "--source=both"],
        {
          configVersion: "0.9.0",
          registries: [{ url: `http://127.0.0.1:${address.port}/index.json` }],
        },
      );
      const json = JSON.parse(output) as {
        hits: Array<Record<string, unknown>>;
        registryHits?: Array<Record<string, unknown>>;
      };
      // Brief local hits have type; registry hits are in registryHits
      const localHit = json.hits.find((hit) => hit.type === "script");
      const registryHit = (json.registryHits ?? []).find((hit) => hit.name === "deploy-stash");

      expect(localHit?.action).toBeTruthy();
      // QA #28: registry brief no longer includes action (use installRef instead)
      expect(registryHit?.name).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
