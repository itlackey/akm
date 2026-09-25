// INTEGRATION TEST — opens a real index and spawns real processes (`tar`, Git)
// while exercising the real bundle-add command against the real npm and Git
// providers. The npm ref resolves through a loopback registry (AKM_NPM_REGISTRY)
// and the github:/git+ refs through a process-scoped Git insteadOf rule that
// maps them to a local fixture repository, so no public network is used.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { readLockfile } from "../../../src/integrations/lockfile";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const NPM_PACKAGE = "akm-bundle-name-fixture";
const GITHUB_URL = "https://github.com/acme/name-fixture.git";
const GIT_URL = "https://git.example.test/acme/other-fixture.git";

// Every registry-backed ref kind: its install id carries a `:` (so it can never
// be a bundle key itself) and its content materializes under the cache's
// `extracted/` directory. `name` is the package/repo name the id names.
const REGISTRY_REFS = [
  { ref: `npm:${NPM_PACKAGE}`, registryId: `npm:${NPM_PACKAGE}`, name: NPM_PACKAGE },
  { ref: "github:acme/name-fixture", registryId: "github:acme/name-fixture", name: "name-fixture" },
  { ref: `git+${GIT_URL}`, registryId: "git:https://git.example.test/acme/other-fixture", name: "other-fixture" },
];

let storage: IsolatedAkmStorage;
let fixtureEnv: Record<string, string>;
let stopRegistry: () => void;

function writeKnowledge(root: string, title: string): void {
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(root, "knowledge", "hello.md"), `---\ndescription: ${title}\n---\n\n# ${title}\n`);
}

/** Serve `NPM_PACKAGE@1.0.0` from a loopback npm registry; returns its base URL. */
function serveNpmPackage(): { url: string; stop: () => void } {
  const packageDir = path.join(storage.root, "npm-package", "package");
  writeKnowledge(packageDir, "npm fixture");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: NPM_PACKAGE, version: "1.0.0" }));
  const tarball = path.join(storage.root, "npm-package.tgz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", path.dirname(packageDir), "package"], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(tar.stderr || "tar failed");
  const bytes = fs.readFileSync(tarball);
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const tarballPath = `/${NPM_PACKAGE}/-/${NPM_PACKAGE}-1.0.0.tgz`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/${NPM_PACKAGE}`) {
        return Response.json({
          name: NPM_PACKAGE,
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { dist: { tarball: `${url.origin}${tarballPath}`, shasum } } },
        });
      }
      if (url.pathname === tarballPath) return new Response(bytes);
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

/** A local repository standing in for both Git remotes; returns its file:// URL. */
function createGitRemote(): string {
  const repo = path.join(storage.root, "remote");
  writeKnowledge(repo, "git fixture");
  git(["init", "--initial-branch=main", repo]);
  git(["-C", repo, "config", "user.name", "AKM Test"]);
  git(["-C", repo, "config", "user.email", "akm@example.test"]);
  git(["-C", repo, "config", "commit.gpgsign", "false"]);
  git(["-C", repo, "add", "."]);
  git(["-C", repo, "commit", "-m", "seed"]);
  return pathToFileURL(repo).href;
}

async function bundleAdd(...args: string[]): Promise<Record<string, unknown>> {
  const result = await withEnv(fixtureEnv, () => runCliCapture(["bundle", "add", ...args, "--format=json"]), 30_000);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function bundleKeys(): string[] {
  return Object.keys(loadConfig().bundles ?? {});
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
  const registry = serveNpmPackage();
  stopRegistry = registry.stop;
  const remote = createGitRemote();
  fixtureEnv = {
    AKM_NPM_REGISTRY: registry.url,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: GITHUB_URL,
    GIT_CONFIG_KEY_1: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_1: GIT_URL,
  };
});

afterEach(() => {
  stopRegistry();
  storage.cleanup();
});

describe("akm bundle add <registry ref> --name", () => {
  for (const { ref, registryId } of REGISTRY_REFS) {
    test(`keys ${ref} by --name, not by its cache directory`, async () => {
      const result = await bundleAdd(ref, "--name", "my-bundle");

      expect(bundleKeys()).toEqual(["my-bundle"]);
      expect(result.bundleId).toBe("my-bundle");
      expect(result.registryId).toBe(registryId);
      // The install id stays recorded so remove/update still resolve the ref.
      expect(loadConfig().bundles?.["my-bundle"]?.registryId).toBe(registryId);
      expect(readLockfile().map((entry) => entry.id)).toEqual(["my-bundle"]);
      const shown = await runCliCapture(["show", "my-bundle//knowledge/hello", "--format=json"]);
      expect(shown.code, shown.stderr).toBe(0);
    });
  }

  test("re-adding the same ref without --name keeps the named bundle", async () => {
    await bundleAdd(`npm:${NPM_PACKAGE}`, "--name", "my-bundle");
    await bundleAdd(`npm:${NPM_PACKAGE}`);

    expect(bundleKeys()).toEqual(["my-bundle"]);
    expect(readLockfile().map((entry) => entry.id)).toEqual(["my-bundle"]);
  });
});

describe("akm bundle add <registry ref> without a usable --name", () => {
  for (const { ref, registryId, name } of REGISTRY_REFS) {
    test(`keys ${ref} by its package/repo name, not by its cache directory`, async () => {
      const result = await bundleAdd(ref);

      expect(bundleKeys()).toEqual([name]);
      expect(result.bundleId).toBe(name);
      expect(result.registryId).toBe(registryId);
      expect(loadConfig().bundles?.[name]?.registryId).toBe(registryId);
      expect(readLockfile().map((entry) => entry.id)).toEqual([name]);
    });
  }

  // D6: an explicit --name is a contract — an illegal name fails loudly
  // before any write, rather than silently falling back to the package name.
  test("a --name that is not a legal bundle slug fails before any write", async () => {
    const result = await withEnv(fixtureEnv, () =>
      runCliCapture([`bundle`, "add", `npm:${NPM_PACKAGE}`, "--name", "my.bundle", "--format=json"]),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a legal bundle name");
    expect(bundleKeys()).toEqual([]);
    expect(readLockfile()).toEqual([]);
  });
});

describe("akm bundle add <registry ref> --name conflicts (D6)", () => {
  function configPath(): string {
    return path.join(storage.configDir, "akm", "config.json");
  }

  test("a --name already used by a different bundle fails before any write", async () => {
    await bundleAdd(`npm:${NPM_PACKAGE}`, "--name", "my-bundle");
    const configBefore = fs.readFileSync(configPath(), "utf8");

    const result = await withEnv(fixtureEnv, () =>
      runCliCapture(["bundle", "add", "github:acme/name-fixture", "--name", "my-bundle", "--format=json"]),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("already exists");
    expect(bundleKeys()).toEqual(["my-bundle"]);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(configBefore);
    expect(readLockfile().map((entry) => entry.id)).toEqual(["my-bundle"]);
  });

  test("re-adding an installed ref under a different --name fails and names rename", async () => {
    await bundleAdd(`npm:${NPM_PACKAGE}`, "--name", "my-bundle");
    const configBefore = fs.readFileSync(configPath(), "utf8");

    const result = await withEnv(fixtureEnv, () =>
      runCliCapture(["bundle", "add", `npm:${NPM_PACKAGE}`, "--name", "renamed", "--format=json"]),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("already installed as bundle");
    expect(result.stderr).toContain("my-bundle");
    expect(result.stderr).toContain("akm bundle rename my-bundle renamed");
    expect(bundleKeys()).toEqual(["my-bundle"]);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(configBefore);
  });
});
