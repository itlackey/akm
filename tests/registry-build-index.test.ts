import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRegistryIndex, writeRegistryIndex } from "../src/registry/build-index";

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

describe("buildRegistryIndex", () => {
  test("writeRegistryIndex defaults under the cache registry-build directory", () => {
    const cacheHome = makeTempDir("akm-registry-cache-");
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      const outPath = writeRegistryIndex({ version: 3, updatedAt: "2026-05-01T00:00:00.000Z", stashes: [] });
      expect(outPath).toBe(path.join(cacheHome, "akm", "registry-build", "index.json"));
      expect(fs.existsSync(outPath)).toBe(true);
    } finally {
      if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = originalCacheHome;
    }
  });

  test("builds a v2 index from discovery and manual entries", async () => {
    const fixtureRoot = makeTempDir("akm-registry-build-fixture-");

    const npmPackageDir = path.join(fixtureRoot, "package");
    writeFile(
      path.join(npmPackageDir, "package.json"),
      JSON.stringify({
        name: "agent-stash",
        version: "1.2.3",
        description: "package archive description",
        keywords: ["akm-stash", "deploy", "review"],
        license: "MIT",
      }),
    );
    writeFile(path.join(npmPackageDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\n");
    writeFile(path.join(npmPackageDir, "skills", "review", "SKILL.md"), "---\ndescription: Review code\n---\n");
    const npmArchivePath = path.join(fixtureRoot, "npm-agent-stash.tgz");
    createTarball(npmPackageDir, npmArchivePath);

    const githubRepoDir = path.join(fixtureRoot, "release-stash-main");
    writeFile(
      path.join(githubRepoDir, "package.json"),
      JSON.stringify({
        name: "release-stash",
        version: "0.4.0",
        description: "repo archive description",
        keywords: ["akm-stash", "release", "automation"],
      }),
    );
    writeFile(path.join(githubRepoDir, "agents", "planner.md"), "---\ndescription: Plan releases\n---\n");
    writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
    const githubArchivePath = path.join(fixtureRoot, "github-release-stash.tgz");
    createTarball(githubRepoDir, githubArchivePath);

    const serverBase = createRegistryServer(npmArchivePath, githubArchivePath);
    const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
    fs.writeFileSync(
      manualEntriesPath,
      `${JSON.stringify(
        [
          {
            id: "npm:agent-stash",
            name: "Agent Stash",
            description: "manual description",
            ref: "agent-stash",
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

    expect(result.index.version).toBe(3);
    expect(result.counts).toEqual({ manual: 2, npm: 1, github: 1, total: 3 });

    const npmStash = result.index.stashes.find((stash) => stash.id === "npm:agent-stash");
    expect(npmStash).toBeDefined();
    expect(npmStash?.description).toBe("manual description");
    // v1 spec §4.2: the legacy `curated` boolean is removed. The builder must
    // not surface it on emitted stash entries even when input contained it.
    expect(npmStash as unknown as Record<string, unknown>).not.toHaveProperty("curated");
    expect(npmStash?.assetTypes).toEqual(["knowledge", "script", "skill"]);
    expect(npmStash?.tags).toEqual(["curated", "deploy", "review"]);
    expect(npmStash?.assets?.map((asset) => `${asset.type}:${asset.name}`)).toEqual([
      "knowledge:guide",
      "script:deploy.sh",
      "skill:review",
    ]);

    const githubStash = result.index.stashes.find((stash) => stash.id === "github:acme/release-stash");
    expect(githubStash).toBeDefined();
    expect(githubStash?.assetTypes).toEqual(["agent", "command"]);
    expect(githubStash?.assets?.map((asset) => `${asset.type}:${asset.name}`)).toEqual([
      "agent:planner",
      "command:release",
    ]);
    expect(githubStash?.assets?.every((asset) => typeof asset.estimatedTokens === "number")).toBe(true);
    expect(githubStash?.latestVersion).toBe("0.4.0");
    expect(githubStash?.tags).toEqual(["automation", "release"]);

    const manualOnlyStash = result.index.stashes.find((stash) => stash.id === "github:manual/only");
    expect(manualOnlyStash).toBeDefined();
    // v1 spec §4.2: legacy `curated` from manual entries is silently ignored.
    expect(manualOnlyStash as unknown as Record<string, unknown>).not.toHaveProperty("curated");
    expect(manualOnlyStash?.assetTypes).toEqual(["skill"]);
  });

  test("legacy curated key parses without error", async () => {
    // v1 spec §4.2: `curated: true` is a removed legacy field on registry
    // entries. Manual-entry JSON in the wild may still contain it. The
    // builder MUST silently ignore it (not throw, not fail validation),
    // and the entry MUST still be processed end-to-end.
    const fixtureRoot = makeTempDir("akm-registry-build-legacy-curated-");

    const githubRepoDir = path.join(fixtureRoot, "release-stash-main");
    writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
    const githubArchivePath = path.join(fixtureRoot, "github-release-stash.tgz");
    createTarball(githubRepoDir, githubArchivePath);

    const npmPackageDir = path.join(fixtureRoot, "package");
    writeFile(path.join(npmPackageDir, "package.json"), JSON.stringify({ name: "agent-stash", version: "1.2.3" }));
    const npmArchivePath = path.join(fixtureRoot, "npm-agent-stash.tgz");
    createTarball(npmPackageDir, npmArchivePath);

    const serverBase = createRegistryServer(npmArchivePath, githubArchivePath);
    const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
    fs.writeFileSync(
      manualEntriesPath,
      `${JSON.stringify(
        [
          {
            id: "github:legacy/curated",
            name: "Legacy Curated",
            description: "entry retaining the removed `curated: true` field",
            ref: "legacy/curated",
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

    await expect(
      buildRegistryIndex({
        manualEntriesPath,
        npmRegistryBase: serverBase,
        githubApiBase: serverBase,
      }),
    ).resolves.toBeDefined();

    // Re-run to inspect the actual result; resolves above proves no throw.
    const result = await buildRegistryIndex({
      manualEntriesPath,
      npmRegistryBase: serverBase,
      githubApiBase: serverBase,
    });

    // Non-empty kit list proves the legacy entry was processed, not silently
    // dropped on parse error.
    expect(result.index.stashes.length).toBeGreaterThan(0);
    const legacyStash = result.index.stashes.find((stash) => stash.id === "github:legacy/curated");
    expect(legacyStash).toBeDefined();
    expect(legacyStash as unknown as Record<string, unknown>).not.toHaveProperty("curated");
  });

  test("respects .stash.json metadata and akm.include when enriching assets", async () => {
    const fixtureRoot = makeTempDir("akm-registry-build-include-");
    const npmPackageDir = path.join(fixtureRoot, "package");

    writeFile(
      path.join(npmPackageDir, "package.json"),
      JSON.stringify({
        name: "agent-stash",
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
    const npmArchivePath = path.join(fixtureRoot, "npm-agent-stash.tgz");
    createTarball(npmPackageDir, npmArchivePath);

    const githubRepoDir = path.join(fixtureRoot, "release-stash-main");
    writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
    const githubArchivePath = path.join(fixtureRoot, "github-release-stash.tgz");
    createTarball(githubRepoDir, githubArchivePath);

    const serverBase = createRegistryServer(npmArchivePath, githubArchivePath);
    const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
    fs.writeFileSync(manualEntriesPath, "[]\n", "utf8");

    const result = await buildRegistryIndex({
      manualEntriesPath,
      npmRegistryBase: serverBase,
      githubApiBase: serverBase,
    });

    const npmStash = result.index.stashes.find((stash) => stash.id === "npm:agent-stash");
    expect(npmStash?.assetTypes).toEqual(["knowledge", "skill"]);
    expect(npmStash?.assets?.map((asset) => `${asset.type}:${asset.name}`)).toEqual([
      "knowledge:docs/guide",
      "skill:review",
    ]);

    const reviewAsset = npmStash?.assets?.find((asset) => asset.type === "skill" && asset.name === "review");
    expect(reviewAsset?.description).toBe("Curated review workflow");
    expect(reviewAsset?.tags).toEqual(["quality", "code-review"]);
    expect(reviewAsset?.estimatedTokens).toBeGreaterThan(0);
    expect(npmStash?.assets?.some((asset) => asset.name === "ignored.sh")).toBe(false);
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
        stashes: Array<{ id: string }>;
      };
      expect(written.version).toBe(3);
      expect(written.stashes.map((stash) => stash.id)).toEqual(["npm:agent-stash", "github:acme/release-stash"]);
    },
    { timeout: 60_000 },
  );
});
