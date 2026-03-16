import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRegistryIndex } from "../src/registry-build-index";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
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
                name: "agent-kit",
                version: "1.2.3",
                description: "npm description",
                keywords: ["agentikit", "deploy"],
                links: {
                  homepage: "https://example.test/agent-kit",
                  repository: "https://github.com/acme/agent-kit",
                },
                author: { name: "acme" },
              },
            },
          ],
        });
      }

      if (pathname === "/agent-kit/latest") {
        return Response.json({
          version: "1.2.3",
          description: "npm latest description",
          keywords: ["agentikit", "deploy", "review"],
          license: "MIT",
          dist: {
            tarball: `${url.origin}/archives/npm-agent-kit.tgz`,
          },
        });
      }

      if (pathname === "/search/repositories") {
        return Response.json({
          items: [
            {
              full_name: "acme/release-kit",
              name: "release-kit",
              description: "github description",
              html_url: "https://github.com/acme/release-kit",
              owner: { login: "acme" },
              license: { spdx_id: "Apache-2.0" },
              topics: ["agentikit", "release"],
              default_branch: "main",
            },
          ],
        });
      }

      if (pathname === "/repos/acme/release-kit/tarball/main") {
        return new Response(Bun.file(githubArchivePath), {
          headers: { "Content-Type": "application/gzip" },
        });
      }

      if (pathname === "/archives/npm-agent-kit.tgz") {
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

describe("buildRegistryIndex", () => {
  test("builds a v2 index from discovery and manual entries", async () => {
    const fixtureRoot = makeTempDir("akm-registry-build-fixture-");

    const npmPackageDir = path.join(fixtureRoot, "package");
    writeFile(
      path.join(npmPackageDir, "package.json"),
      JSON.stringify({
        name: "agent-kit",
        version: "1.2.3",
        description: "package archive description",
        keywords: ["agentikit", "deploy", "review"],
        license: "MIT",
      }),
    );
    writeFile(path.join(npmPackageDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\n");
    writeFile(path.join(npmPackageDir, "skills", "review", "SKILL.md"), "---\ndescription: Review code\n---\n");
    const npmArchivePath = path.join(fixtureRoot, "npm-agent-kit.tgz");
    createTarball(npmPackageDir, npmArchivePath);

    const githubRepoDir = path.join(fixtureRoot, "release-kit-main");
    writeFile(
      path.join(githubRepoDir, "package.json"),
      JSON.stringify({
        name: "release-kit",
        version: "0.4.0",
        description: "repo archive description",
        keywords: ["agentikit", "release", "automation"],
      }),
    );
    writeFile(path.join(githubRepoDir, "agents", "planner.md"), "---\ndescription: Plan releases\n---\n");
    writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
    const githubArchivePath = path.join(fixtureRoot, "github-release-kit.tgz");
    createTarball(githubRepoDir, githubArchivePath);

    const serverBase = createRegistryServer(npmArchivePath, githubArchivePath);
    const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
    fs.writeFileSync(
      manualEntriesPath,
      `${JSON.stringify(
        [
          {
            id: "npm:agent-kit",
            name: "Agent Kit",
            description: "manual description",
            ref: "agent-kit",
            source: "npm",
            tags: ["curated"],
            assets: [{ type: "knowledge", name: "guide", description: "Manual guide" }],
            curated: true,
          },
          {
            id: "github:manual/only",
            name: "Manual Only",
            description: "manual only entry",
            ref: "manual/only",
            source: "github",
            assetTypes: ["skill"],
            curated: true,
          },
        ],
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await buildRegistryIndex({
      manualEntriesPath,
      npmRegistryBase: serverBase,
      githubApiBase: serverBase,
    });

    expect(result.index.version).toBe(2);
    expect(result.counts).toEqual({ manual: 2, npm: 1, github: 1, total: 3 });

    const npmKit = result.index.kits.find((kit) => kit.id === "npm:agent-kit");
    expect(npmKit).toBeDefined();
    expect(npmKit?.description).toBe("manual description");
    expect(npmKit?.curated).toBe(true);
    expect(npmKit?.assetTypes).toEqual(["knowledge", "script", "skill"]);
    expect(npmKit?.tags).toEqual(["curated", "deploy", "review"]);
    expect(npmKit?.assets?.map((asset) => `${asset.type}:${asset.name}`)).toEqual([
      "knowledge:guide",
      "script:deploy.sh",
      "skill:review",
    ]);

    const githubKit = result.index.kits.find((kit) => kit.id === "github:acme/release-kit");
    expect(githubKit).toBeDefined();
    expect(githubKit?.assetTypes).toEqual(["agent", "command"]);
    expect(githubKit?.assets?.map((asset) => `${asset.type}:${asset.name}`)).toEqual([
      "agent:planner",
      "command:release",
    ]);
    expect(githubKit?.latestVersion).toBe("0.4.0");
    expect(githubKit?.tags).toEqual(["automation", "release"]);

    const manualOnlyKit = result.index.kits.find((kit) => kit.id === "github:manual/only");
    expect(manualOnlyKit?.curated).toBe(true);
    expect(manualOnlyKit?.assetTypes).toEqual(["skill"]);
  });

  test("respects .stash.json metadata and akm.include when enriching assets", async () => {
    const fixtureRoot = makeTempDir("akm-registry-build-include-");
    const npmPackageDir = path.join(fixtureRoot, "package");

    writeFile(
      path.join(npmPackageDir, "package.json"),
      JSON.stringify({
        name: "agent-kit",
        version: "1.2.3",
        akm: { include: ["skills", "docs"] },
      }),
    );
    writeFile(path.join(npmPackageDir, "scripts", "ignored.sh"), "#!/usr/bin/env bash\n");
    writeFile(path.join(npmPackageDir, "skills", "review", "SKILL.md"), "# Review\n");
    writeFile(
      path.join(npmPackageDir, "skills", "review", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "review",
            type: "skill",
            filename: "SKILL.md",
            description: "Curated review workflow",
            tags: ["quality", "code-review"],
          },
        ],
      }),
    );
    writeFile(path.join(npmPackageDir, "docs", "guide.md"), "# Guide\n");
    const npmArchivePath = path.join(fixtureRoot, "npm-agent-kit.tgz");
    createTarball(npmPackageDir, npmArchivePath);

    const githubRepoDir = path.join(fixtureRoot, "release-kit-main");
    writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
    const githubArchivePath = path.join(fixtureRoot, "github-release-kit.tgz");
    createTarball(githubRepoDir, githubArchivePath);

    const serverBase = createRegistryServer(npmArchivePath, githubArchivePath);
    const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
    fs.writeFileSync(manualEntriesPath, "[]\n", "utf8");

    const result = await buildRegistryIndex({
      manualEntriesPath,
      npmRegistryBase: serverBase,
      githubApiBase: serverBase,
    });

    const npmKit = result.index.kits.find((kit) => kit.id === "npm:agent-kit");
    expect(npmKit?.assetTypes).toEqual(["knowledge", "skill"]);
    expect(npmKit?.assets?.map((asset) => `${asset.type}:${asset.name}`)).toEqual([
      "knowledge:docs/guide",
      "skill:review",
    ]);

    const reviewAsset = npmKit?.assets?.find((asset) => asset.type === "skill" && asset.name === "review");
    expect(reviewAsset?.description).toBe("Curated review workflow");
    expect(reviewAsset?.tags).toEqual(["quality", "code-review"]);
    expect(npmKit?.assets?.some((asset) => asset.name === "ignored.sh")).toBe(false);
  });
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
      writeFile(path.join(npmPackageDir, "package.json"), JSON.stringify({ name: "agent-kit", version: "1.2.3" }));
      writeFile(path.join(npmPackageDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\n");
      const npmArchivePath = path.join(fixtureRoot, "npm-agent-kit.tgz");
      createTarball(npmPackageDir, npmArchivePath);

      const githubRepoDir = path.join(fixtureRoot, "release-kit-main");
      writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
      const githubArchivePath = path.join(fixtureRoot, "github-release-kit.tgz");
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
          cwd: path.join(import.meta.dir, ".."),
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
        kits: Array<{ id: string }>;
      };
      expect(written.version).toBe(2);
      expect(written.kits.map((kit) => kit.id)).toEqual(["npm:agent-kit", "github:acme/release-kit"]);
    },
    { timeout: 60_000 },
  );
});
