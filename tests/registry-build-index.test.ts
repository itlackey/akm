import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HttpClient } from "../src/core/common";
import { buildRegistryIndex, writeRegistryIndex } from "../src/registry/build-index";
import { sandboxXdgCacheHome } from "./_helpers/sandbox";

const tempDirs: string[] = [];

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

// #664 Seam 1: a fake HttpClient that serves the npm/GitHub registry discovery
// routes and the two archive tarballs from disk, injected via
// `buildRegistryIndex({ fetchImpl })`. The whole discovery + inspection pipeline
// runs with no socket. The arbitrary `http://registry.test` base is never dialed.
const REGISTRY_BASE = "http://registry.test";

function makeRegistryFetch(npmArchivePath: string, githubArchivePath: string): HttpClient {
  return async (input) => {
    const url = new URL(String(input));
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
      return new Response(fs.readFileSync(githubArchivePath), {
        headers: { "Content-Type": "application/gzip" },
      });
    }

    if (pathname === "/archives/npm-agent-stash.tgz") {
      return new Response(fs.readFileSync(npmArchivePath), {
        headers: { "Content-Type": "application/gzip" },
      });
    }

    return new Response("not found", { status: 404 });
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

describe("buildRegistryIndex", () => {
  test("writeRegistryIndex defaults under the cache registry-build directory", () => {
    const { dir: cacheHome, cleanup } = sandboxXdgCacheHome();
    try {
      const outPath = writeRegistryIndex({ version: 3, updatedAt: "2026-05-01T00:00:00.000Z", stashes: [] });
      expect(outPath).toBe(path.join(cacheHome, "akm", "registry-build", "index.json"));
      expect(fs.existsSync(outPath)).toBe(true);
    } finally {
      cleanup();
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

    const fetchImpl = makeRegistryFetch(npmArchivePath, githubArchivePath);
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
      npmRegistryBase: REGISTRY_BASE,
      githubApiBase: REGISTRY_BASE,
      fetchImpl,
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

    const fetchImpl = makeRegistryFetch(npmArchivePath, githubArchivePath);
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
        npmRegistryBase: REGISTRY_BASE,
        githubApiBase: REGISTRY_BASE,
        fetchImpl,
      }),
    ).resolves.toBeDefined();

    // Re-run to inspect the actual result; resolves above proves no throw.
    const result = await buildRegistryIndex({
      manualEntriesPath,
      npmRegistryBase: REGISTRY_BASE,
      githubApiBase: REGISTRY_BASE,
      fetchImpl,
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

    const fetchImpl = makeRegistryFetch(npmArchivePath, githubArchivePath);
    const manualEntriesPath = path.join(fixtureRoot, "manual-entries.json");
    fs.writeFileSync(manualEntriesPath, "[]\n", "utf8");

    const result = await buildRegistryIndex({
      manualEntriesPath,
      npmRegistryBase: REGISTRY_BASE,
      githubApiBase: REGISTRY_BASE,
      fetchImpl,
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

  test("prefers generated file metadata over filename-less legacy stash metadata", async () => {
    const fixtureRoot = makeTempDir("akm-registry-build-filename-less-");
    const npmPackageDir = path.join(fixtureRoot, "package");
    writeFile(
      path.join(npmPackageDir, "package.json"),
      JSON.stringify({
        name: "agent-stash",
        version: "1.2.3",
      }),
    );
    writeFile(path.join(npmPackageDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\n# Deploy generated metadata\n");
    writeFile(
      path.join(npmPackageDir, "scripts", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "deploy",
            type: "script",
            description: "legacy filename-less entry",
          },
        ],
      }),
    );
    const npmArchivePath = path.join(fixtureRoot, "npm-agent-stash.tgz");
    createTarball(npmPackageDir, npmArchivePath);

    const githubRepoDir = path.join(fixtureRoot, "release-stash-main");
    writeFile(path.join(githubRepoDir, "commands", "release.md"), "Use $ARGUMENTS\n");
    const githubArchivePath = path.join(fixtureRoot, "github-release-stash.tgz");
    createTarball(githubRepoDir, githubArchivePath);

    const fetchImpl = makeRegistryFetch(npmArchivePath, githubArchivePath);
    const result = await buildRegistryIndex({
      npmRegistryBase: REGISTRY_BASE,
      githubApiBase: REGISTRY_BASE,
      fetchImpl,
    });

    const npmStash = result.index.stashes.find((stash) => stash.id === "npm:agent-stash");
    expect(npmStash).toBeDefined();
    const deployAsset = npmStash?.assets?.find((asset) => asset.type === "script" && asset.name === "deploy.sh");
    expect(deployAsset).toBeDefined();
    expect(deployAsset?.description).not.toBe("legacy filename-less entry");
  });
});
