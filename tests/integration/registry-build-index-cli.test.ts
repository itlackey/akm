/**
 * CLI subprocess + real-server integration for `akm registry build-index`.
 *
 * Relocated from `tests/registry-build-index.test.ts` (#664). The in-process
 * `buildRegistryIndex` unit tests now inject a fake `HttpClient` (the
 * `fetchImpl` seam) and need no socket. This case is inherently a real
 * subprocess: the spawned `bun src/cli.ts` child cannot receive an injected
 * fetch, so it must dial a real `Bun.serve` endpoint. It stays in the
 * integration tier.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createTarball(sourceDir: string, archivePath: string): void {
  const result = spawnSync("tar", ["czf", archivePath, "-C", path.dirname(sourceDir), path.basename(sourceDir)], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
}

function createRegistryServer(npmArchivePath: string, githubArchivePath: string) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (pathname === "/-/v1/search") {
        return Response.json({
          objects: [
            {
              package: {
                name: "agent-stash",
                version: "1.2.3",
                description: "npm description",
                keywords: ["akm-stash", "deploy"],
                links: {
                  homepage: "https://example.test/agent-stash",
                  repository: "https://github.com/acme/agent-stash",
                },
                author: { name: "acme" },
              },
            },
          ],
        });
      }

      if (pathname === "/agent-stash/latest") {
        return Response.json({
          version: "1.2.3",
          description: "npm latest description",
          keywords: ["akm-stash", "deploy", "review"],
          license: "MIT",
          dist: {
            tarball: `${url.origin}/archives/npm-agent-stash.tgz`,
          },
        });
      }

      if (pathname === "/search/repositories") {
        return Response.json({
          items: [
            {
              full_name: "acme/release-stash",
              name: "release-stash",
              description: "github description",
              html_url: "https://github.com/acme/release-stash",
              owner: { login: "acme" },
              license: { spdx_id: "Apache-2.0" },
              topics: ["akm-stash", "release"],
              default_branch: "main",
            },
          ],
        });
      }

      if (pathname === "/repos/acme/release-stash/tarball/main") {
        return new Response(Bun.file(githubArchivePath), {
          headers: { "Content-Type": "application/gzip" },
        });
      }

      if (pathname === "/archives/npm-agent-stash.tgz") {
        return new Response(Bun.file(npmArchivePath), {
          headers: { "Content-Type": "application/gzip" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

afterAll(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Child process timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

describe("akm registry build-index", () => {
  test(
    "writes the generated index to disk",
    async () => {
      const fixtureRoot = makeTempDir("akm-registry-build-cli-");
      const npmPackageDir = path.join(fixtureRoot, "package");
      writeFile(path.join(npmPackageDir, "package.json"), JSON.stringify({ name: "agent-stash", version: "1.2.3" }));
      writeFile(path.join(npmPackageDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\n");
      const npmArchivePath = path.join(fixtureRoot, "npm-agent-stash.tgz");
      createTarball(npmPackageDir, npmArchivePath);

      const githubRepoDir = path.join(fixtureRoot, "release-stash-main");
      writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
      const githubArchivePath = path.join(fixtureRoot, "github-release-stash.tgz");
      createTarball(githubRepoDir, githubArchivePath);

      const serverBase = createRegistryServer(npmArchivePath, githubArchivePath);
      const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
      fs.writeFileSync(manualEntriesPath, "[]\n", "utf8");
      const outPath = path.join(fixtureRoot, "out", "index.json");
      const xdgCache = makeTempDir("akm-registry-build-cache-");
      const xdgConfig = makeTempDir("akm-registry-build-config-");
      const homeDir = makeTempDir("akm-registry-build-home-");

      const child = spawn(
        "bun",
        [
          CLI,
          "registry",
          "build-index",
          "--format=json",
          "--out",
          outPath,
          "--manual",
          manualEntriesPath,
          "--npmRegistry",
          serverBase,
          "--githubApi",
          serverBase,
        ],
        {
          cwd: path.join(import.meta.dir, "..", ".."),
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: homeDir,
            NO_PROXY: "127.0.0.1,localhost",
            GITHUB_TOKEN: "",
            XDG_CACHE_HOME: xdgCache,
            XDG_CONFIG_HOME: xdgConfig,
          },
        },
      );

      const result = await waitForChild(child, 30_000);

      if (result.code !== 0) {
        console.error("stderr:", result.stderr);
        console.error("stdout:", result.stdout);
      }
      expect(result.code).toBe(0);
      expect(result.stderr.trim()).toBe("");
      const stdout = JSON.parse(result.stdout.trim()) as { outPath: string; totalKits: number };
      expect(stdout.outPath).toBe(outPath);
      expect(stdout.totalKits).toBe(2);

      const written = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
        version: number;
        stashes: Array<{ id: string }>;
      };
      expect(written.version).toBe(3);
      expect(written.stashes.map((stash) => stash.id)).toEqual(["npm:agent-stash", "github:acme/release-stash"]);
    },
    { timeout: 60_000 },
  );
});
