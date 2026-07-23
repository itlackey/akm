import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmClone } from "../../src/commands/sources/source-clone";
import { saveConfig } from "../../src/core/config/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import { getDbPath } from "../../src/core/paths";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { writeLockfile } from "../../src/integrations/lockfile";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "../_helpers/sandbox";
import { withSeam } from "../_helpers/seams";

const fixtureDirs: string[] = [];

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createStashDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

let stashDir = "";
let searchPathDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const dataResult = sandboxXdgDataHome(cacheResult.cleanup);
  const stateResult = sandboxXdgStateHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(stateResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
  searchPathDir = createStashDir("akm-clone-searchpath-");

  saveConfig({
    semanticSearchMode: "off",
    bundles: { searchpath: { path: searchPathDir } },
  });
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  stashDir = "";
  searchPathDir = "";
});

afterAll(() => {
  for (const dir of fixtureDirs.splice(0)) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akmClone", () => {
  test("clones a script from search path to primary stash", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "#!/bin/bash\necho deploy\n");

    const result = await akmClone({ sourceRef: "scripts/deploy.sh" });
    // F4b: destination ref emits the 0.9.0 conceptId spelling.

    expect(result.destination.ref).toContain("scripts/deploy.sh");
    expect(result.overwritten).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "scripts", "deploy.sh"))).toBe(true);
    expect(fs.readFileSync(path.join(stashDir, "scripts", "deploy.sh"), "utf8")).toBe("#!/bin/bash\necho deploy\n");
  });

  test("clones a skill directory", async () => {
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Review Skill\n");
    writeFile(path.join(searchPathDir, "skills", "review", "helper.md"), "# Helper\n");

    const result = await akmClone({ sourceRef: "skills/review" });

    expect(result.overwritten).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "helper.md"))).toBe(true);
  });

  test("clones with a new name", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");

    const result = await akmClone({ sourceRef: "scripts/deploy.sh", newName: "my-deploy.sh" });

    expect(fs.existsSync(path.join(stashDir, "scripts", "my-deploy.sh"))).toBe(true);
    expect(result.destination.ref).toContain("my-deploy.sh");
  });

  test("CLI --target clones to a writable filesystem bundle and returns its qualified ref", async () => {
    const targetDir = createStashDir("akm-clone-target-");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        team: { path: targetDir, writable: true },
      },
    });

    const result = await runCliCapture([
      "clone",
      `${searchPathDir}//scripts/deploy.sh`,
      "--target",
      "team",
      "--format=json",
    ]);

    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout) as CloneResponseEnvelope;
    expect(response.destination.ref).toBe("team//scripts/deploy.sh");
    expect(response.destination.path).toBe(path.join(targetDir, "scripts", "deploy.sh"));
    expect(fs.readFileSync(response.destination.path, "utf8")).toBe("echo deploy\n");
    expect(fs.existsSync(path.join(stashDir, "scripts", "deploy.sh"))).toBe(false);
  });

  test("rejects an explicitly read-only target", async () => {
    const targetDir = createStashDir("akm-clone-readonly-");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        readonly: { path: targetDir, writable: false },
      },
    });

    await expect(akmClone({ sourceRef: "scripts/deploy.sh", target: "readonly" })).rejects.toThrow(ConfigError);
    expect(fs.existsSync(path.join(targetDir, "scripts", "deploy.sh"))).toBe(false);
  });

  test("uses defaultWriteTarget when --target is omitted", async () => {
    const targetDir = createStashDir("akm-clone-default-target-");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        team: { path: targetDir, writable: true },
      },
      defaultWriteTarget: "team",
    });

    const result = await akmClone({ sourceRef: "scripts/deploy.sh" });

    expect(result.destination.ref).toBe("team//scripts/deploy.sh");
    expect(fs.existsSync(path.join(targetDir, "scripts", "deploy.sh"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "scripts", "deploy.sh"))).toBe(false);
  });

  test("reindexes a clone written to a managed target", async () => {
    const targetDir = createStashDir("akm-clone-index-target-");
    writeFile(path.join(stashDir, "scripts", "seed.sh"), "echo seed\n");
    writeFile(path.join(searchPathDir, "scripts", "indexed-clone.sh"), "echo indexed\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        team: { path: targetDir, writable: true },
      },
    });
    await akmIndex({ stashDir, full: true });

    const result = await akmClone({ sourceRef: `${searchPathDir}//scripts/indexed-clone.sh`, target: "team" });
    const db = openExistingDatabase(getDbPath());
    try {
      const row = db
        .prepare("SELECT item_ref AS itemRef FROM entries WHERE file_path = ?")
        .get(result.destination.path) as {
        itemRef: string;
      } | null;
      expect(row?.itemRef).toBe("team//scripts/indexed-clone.sh");
    } finally {
      closeDatabase(db);
    }
  });

  test("surfaces a targeted index failure as a warning after the clone succeeds", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    fs.mkdirSync(getDbPath(), { recursive: true });
    const warnings: string[] = [];

    const result = await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") warnings.push(args.join(" "));
      },
      () => akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh` }),
    );

    expect(fs.readFileSync(result.destination.path, "utf8")).toBe("echo deploy\n");
    expect(warnings.some((message) => message.includes("targeted index update failed"))).toBe(true);
  });

  test("rejects an unmaterialized writable Git target before copying", async () => {
    const url = "https://example.invalid/akm/unmaterialized-clone-target.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        team: { git: url, writable: true },
      },
    });

    const error = await akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh`, target: "team" }).catch(
      (cause) => cause,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("refusing to write without a commit boundary");
    expect(fs.existsSync(path.join(repo, "scripts", "deploy.sh"))).toBe(false);
  });

  test("rejects a lock-backed Git target that is not a checkout before copying", async () => {
    const url = "https://example.invalid/akm/extracted-clone-target.git";
    const extractedRoot = createStashDir("akm-clone-extracted-git-");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    await writeLockfile([{ id: "team", source: "git", ref: url, localRoot: extractedRoot }]);
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        team: { git: url, writable: true },
      },
    });

    await expect(akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh`, target: "team" })).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(fs.existsSync(path.join(extractedRoot, "scripts", "deploy.sh"))).toBe(false);
  });

  test("lock-backed Git target commits only clone-owned paths at the real checkout boundary", async () => {
    const url = "https://example.com/akm/clone-target.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    fs.mkdirSync(path.join(content, "scripts"), { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    writeFile(path.join(repo, "unrelated.txt"), "initial\n");
    git(repo, ["add", "--", "unrelated.txt"]);
    git(repo, ["-c", "user.name=akm-test", "-c", "user.email=test@akm.local", "commit", "-m", "initial"]);
    writeFile(path.join(repo, "unrelated.txt"), "staged user work\n");
    git(repo, ["add", "--", "unrelated.txt"]);
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    await writeLockfile([{ id: "team", source: "git", ref: url, localRoot: content }]);
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        searchpath: { path: searchPathDir },
        team: { git: url, writable: true },
      },
    });

    const result = await akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh`, target: "team" });

    expect(result.destination.ref).toBe("team//scripts/deploy.sh");
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("content/scripts/deploy.sh");
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
  });

  test("throws when asset already exists without --force", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo original\n");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "echo existing\n");

    await expect(akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh` })).rejects.toThrow("already exists");
  });

  test("overwrites with --force", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo updated\n");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "echo old\n");

    const result = await akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh`, force: true });

    expect(result.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(stashDir, "scripts", "deploy.sh"), "utf8")).toBe("echo updated\n");
  });

  test("force replaces a file destination symlink without writing through it", async () => {
    const victim = path.join(createStashDir("akm-clone-symlink-victim-"), "victim.sh");
    const destination = path.join(stashDir, "scripts", "deploy.sh");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo updated\n");
    writeFile(victim, "echo victim\n");
    fs.symlinkSync(victim, destination);

    const result = await akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh`, force: true });

    expect(result.overwritten).toBe(true);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("echo updated\n");
    expect(fs.readFileSync(victim, "utf8")).toBe("echo victim\n");
  });

  test("force replaces a skill destination symlink without removing its target", async () => {
    const victimDir = path.join(createStashDir("akm-clone-skill-symlink-victim-"), "external-review");
    const destination = path.join(stashDir, "skills", "review");
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Updated\n");
    writeFile(path.join(victimDir, "SKILL.md"), "# Victim\n");
    writeFile(path.join(victimDir, "keep.md"), "keep\n");
    fs.symlinkSync(victimDir, destination, "dir");

    const result = await akmClone({ sourceRef: `${searchPathDir}//skills/review`, force: true });

    expect(result.overwritten).toBe(true);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe("# Updated\n");
    expect(fs.readFileSync(path.join(victimDir, "SKILL.md"), "utf8")).toBe("# Victim\n");
    expect(fs.readFileSync(path.join(victimDir, "keep.md"), "utf8")).toBe("keep\n");
  });

  test("force overwrite removes stale files from skill directory", async () => {
    // Source skill has only SKILL.md
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Updated\n");
    // Existing working skill has an extra file
    writeFile(path.join(stashDir, "skills", "review", "SKILL.md"), "# Old\n");
    writeFile(path.join(stashDir, "skills", "review", "stale.md"), "# Stale\n");

    await akmClone({ sourceRef: `${searchPathDir}//skills/review`, force: true });

    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "stale.md"))).toBe(false);
  });

  test("throws when source asset not found", async () => {
    await expect(akmClone({ sourceRef: "scripts/nonexistent.sh" })).rejects.toThrow();
  });

  test("clones from working stash to itself with new name", async () => {
    writeFile(path.join(stashDir, "scripts", "original.sh"), "echo original\n");

    const _result = await akmClone({ sourceRef: "scripts/original.sh", newName: "copy.sh" });

    expect(fs.existsSync(path.join(stashDir, "scripts", "copy.sh"))).toBe(true);
  });

  test("throws when self-cloning a script without rename", async () => {
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "echo deploy\n");

    await expect(akmClone({ sourceRef: "scripts/deploy.sh" })).rejects.toThrow("same path");
    // Verify the file was not destroyed
    expect(fs.readFileSync(path.join(stashDir, "scripts", "deploy.sh"), "utf8")).toBe("echo deploy\n");
  });

  test("throws when self-cloning a skill without rename", async () => {
    writeFile(path.join(stashDir, "skills", "review", "SKILL.md"), "# Review\n");

    await expect(akmClone({ sourceRef: "skills/review" })).rejects.toThrow("same path");
    // Verify the skill was not destroyed
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true);
  });

  describe("newName validation", () => {
    beforeEach(() => {
      writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
      writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Review\n");
    });

    test("throws on empty string newName", async () => {
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "" })).rejects.toThrow(UsageError);
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "" })).rejects.toThrow(/empty/);
    });

    test("throws on '.' as newName", async () => {
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "." })).rejects.toThrow(UsageError);
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "." })).rejects.toThrow(/Unsafe/);
    });

    test("throws on '..' as newName", async () => {
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: ".." })).rejects.toThrow(UsageError);
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: ".." })).rejects.toThrow(/Unsafe/);
    });

    test("throws on path-traversal newName", async () => {
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "../escape.sh" })).rejects.toThrow(UsageError);
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "../escape.sh" })).rejects.toThrow(/Unsafe/);
    });

    test("throws on absolute path as newName", async () => {
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "/etc/evil.sh" })).rejects.toThrow(UsageError);
      await expect(akmClone({ sourceRef: "scripts/deploy.sh", newName: "/etc/evil.sh" })).rejects.toThrow(/Unsafe/);
    });

    test("empty newName does not wipe the type directory for skills", async () => {
      writeFile(path.join(stashDir, "skills", "existing", "SKILL.md"), "# Existing\n");

      await expect(akmClone({ sourceRef: "skills/review", newName: "", force: true })).rejects.toThrow(UsageError);
      // Existing skill must be untouched
      expect(fs.existsSync(path.join(stashDir, "skills", "existing", "SKILL.md"))).toBe(true);
    });
  });
});

describe("akmClone --dest", () => {
  let customDest: string;

  beforeEach(() => {
    customDest = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clone-dest-"));
  });

  afterEach(() => {
    if (customDest) fs.rmSync(customDest, { recursive: true, force: true });
  });

  test("clones script to custom destination preserving type dir structure", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "#!/bin/bash\necho deploy\n");

    const result = await akmClone({ sourceRef: "scripts/deploy.sh", dest: customDest });

    expect(result.destination.path).toBe(path.join(customDest, "scripts", "deploy.sh"));
    expect(fs.existsSync(path.join(customDest, "scripts", "deploy.sh"))).toBe(true);
    expect(fs.readFileSync(path.join(customDest, "scripts", "deploy.sh"), "utf8")).toBe("#!/bin/bash\necho deploy\n");
    // Working stash should NOT have the file
    expect(fs.existsSync(path.join(stashDir, "scripts", "deploy.sh"))).toBe(false);
  });

  test("rejects ambiguous --dest and --target CLI options", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");

    const result = await runCliCapture([
      "clone",
      "scripts/deploy.sh",
      "--dest",
      customDest,
      "--target",
      "searchpath",
      "--format=json",
    ]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toContain("--dest and --target cannot be used together");
    expect(fs.existsSync(path.join(customDest, "scripts", "deploy.sh"))).toBe(false);
  });

  test("clones skill directory to custom destination", async () => {
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Review Skill\n");
    writeFile(path.join(searchPathDir, "skills", "review", "helper.md"), "# Helper\n");

    const result = await akmClone({ sourceRef: "skills/review", dest: customDest });

    expect(fs.existsSync(path.join(customDest, "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(customDest, "skills", "review", "helper.md"))).toBe(true);
    expect(result.overwritten).toBe(false);
  });

  test("--dest does not require a working stash", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo deploy\n");
    // Point AKM_STASH_DIR to a non-existent directory to simulate no working stash
    process.env.AKM_STASH_DIR = path.join(os.tmpdir(), `nonexistent-stash-${Date.now()}`);

    const result = await akmClone({
      sourceRef: `${searchPathDir}//scripts/deploy.sh`,
      dest: customDest,
    });

    expect(fs.existsSync(path.join(customDest, "scripts", "deploy.sh"))).toBe(true);
    expect(result.destination.path).toBe(path.join(customDest, "scripts", "deploy.sh"));
  });

  test("--dest with --force overwrites at custom destination", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo updated\n");
    writeFile(path.join(customDest, "scripts", "deploy.sh"), "echo old\n");

    const result = await akmClone({
      sourceRef: `${searchPathDir}//scripts/deploy.sh`,
      force: true,
      dest: customDest,
    });

    expect(result.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(customDest, "scripts", "deploy.sh"), "utf8")).toBe("echo updated\n");
  });

  test("throws when asset exists at --dest without --force", async () => {
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "echo new\n");
    writeFile(path.join(customDest, "scripts", "deploy.sh"), "echo existing\n");

    await expect(akmClone({ sourceRef: `${searchPathDir}//scripts/deploy.sh`, dest: customDest })).rejects.toThrow(
      "already exists at destination",
    );
  });
});

interface CloneResponseEnvelope {
  destination: { path: string; ref: string };
}

describe("akmClone remote", () => {
  let remoteFixtureDir: string;

  beforeEach(() => {
    // Create a fixture directory that simulates a remote package
    remoteFixtureDir = createStashDir("akm-clone-remote-fixture-");
    writeFile(path.join(remoteFixtureDir, "scripts", "remote-tool.sh"), "#!/bin/bash\necho remote\n");
    writeFile(path.join(remoteFixtureDir, "skills", "remote-skill", "SKILL.md"), "# Remote Skill\n");
  });

  afterEach(() => {
    if (remoteFixtureDir) fs.rmSync(remoteFixtureDir, { recursive: true, force: true });
  });

  test("clones a script from a remote origin via installRegistryRef", async () => {
    // Use bare path as origin — not in stashes, so isRemoteOrigin returns true
    const result = await akmClone({
      sourceRef: `${remoteFixtureDir}//scripts/remote-tool.sh`,
    });

    expect(result.remoteFetched).toBeDefined();
    expect(result.remoteFetched?.origin).toBe(remoteFixtureDir);
    expect(fs.existsSync(path.join(stashDir, "scripts", "remote-tool.sh"))).toBe(true);
    expect(fs.readFileSync(path.join(stashDir, "scripts", "remote-tool.sh"), "utf8")).toBe(
      "#!/bin/bash\necho remote\n",
    );
  });

  test("returns remoteFetched metadata", async () => {
    const result = await akmClone({
      sourceRef: `${remoteFixtureDir}//scripts/remote-tool.sh`,
    });

    expect(result.remoteFetched).toBeDefined();
    expect(result.remoteFetched?.stashRoot).toBeTruthy();
    expect(result.remoteFetched?.cacheDir).toBeTruthy();
  });

  test("throws when remote fetch succeeds but asset not found in package", async () => {
    await expect(akmClone({ sourceRef: `${remoteFixtureDir}//scripts/nonexistent.sh` })).rejects.toThrow("not found");
  });

  test("clones from remote origin to custom destination", async () => {
    const customDest = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clone-remote-dest-"));
    try {
      const result = await akmClone({
        sourceRef: `${remoteFixtureDir}//scripts/remote-tool.sh`,
        dest: customDest,
      });

      expect(result.remoteFetched).toBeDefined();
      expect(fs.existsSync(path.join(customDest, "scripts", "remote-tool.sh"))).toBe(true);
      expect(result.destination.path).toBe(path.join(customDest, "scripts", "remote-tool.sh"));
    } finally {
      fs.rmSync(customDest, { recursive: true, force: true });
    }
  });
});
