import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { agentikitClone } from "../src/stash-clone";

const originalStashDir = process.env.AKM_STASH_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let testConfigDir = "";
let testCacheDir = "";
let stashDir = "";
let searchPathDir = "";

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createStashDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-clone-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-clone-cache-"));
  stashDir = createStashDir("agentikit-clone-working-");
  searchPathDir = createStashDir("agentikit-clone-searchpath-");
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.AKM_STASH_DIR = stashDir;

  saveConfig({
    semanticSearch: false,
    searchPaths: [searchPathDir],
  });
});

afterEach(() => {
  process.env.AKM_STASH_DIR = originalStashDir ?? undefined;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  for (const dir of [testConfigDir, testCacheDir, stashDir, searchPathDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agentikitClone", () => {
  test("clones a tool from search path to primary stash", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "#!/bin/bash\necho deploy\n");

    const result = await agentikitClone({ sourceRef: "tool:deploy.sh" });

    expect(result.destination.ref).toContain("script:deploy.sh");
    expect(result.overwritten).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "tools", "deploy.sh"))).toBe(true);
    expect(fs.readFileSync(path.join(stashDir, "tools", "deploy.sh"), "utf8")).toBe("#!/bin/bash\necho deploy\n");
  });

  test("clones a skill directory", async () => {
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Review Skill\n");
    writeFile(path.join(searchPathDir, "skills", "review", "helper.md"), "# Helper\n");

    const result = await agentikitClone({ sourceRef: "skill:review" });

    expect(result.overwritten).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "helper.md"))).toBe(true);
  });

  test("clones with a new name", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "echo deploy\n");

    const result = await agentikitClone({ sourceRef: "tool:deploy.sh", newName: "my-deploy.sh" });

    expect(fs.existsSync(path.join(stashDir, "tools", "my-deploy.sh"))).toBe(true);
    expect(result.destination.ref).toContain("my-deploy.sh");
  });

  test("throws when asset already exists without --force", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "echo original\n");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "echo existing\n");

    await expect(agentikitClone({ sourceRef: `${searchPathDir}//tool:deploy.sh` })).rejects.toThrow("already exists");
  });

  test("overwrites with --force", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "echo updated\n");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "echo old\n");

    const result = await agentikitClone({ sourceRef: `${searchPathDir}//tool:deploy.sh`, force: true });

    expect(result.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(stashDir, "tools", "deploy.sh"), "utf8")).toBe("echo updated\n");
  });

  test("force overwrite removes stale files from skill directory", async () => {
    // Source skill has only SKILL.md
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Updated\n");
    // Existing working skill has an extra file
    writeFile(path.join(stashDir, "skills", "review", "SKILL.md"), "# Old\n");
    writeFile(path.join(stashDir, "skills", "review", "stale.md"), "# Stale\n");

    await agentikitClone({ sourceRef: `${searchPathDir}//skill:review`, force: true });

    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "stale.md"))).toBe(false);
  });

  test("throws when source asset not found", async () => {
    await expect(agentikitClone({ sourceRef: "tool:nonexistent.sh" })).rejects.toThrow();
  });

  test("clones from working stash to itself with new name", async () => {
    writeFile(path.join(stashDir, "tools", "original.sh"), "echo original\n");

    const _result = await agentikitClone({ sourceRef: "tool:original.sh", newName: "copy.sh" });

    expect(fs.existsSync(path.join(stashDir, "tools", "copy.sh"))).toBe(true);
  });

  test("throws when self-cloning a tool without rename", async () => {
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "echo deploy\n");

    await expect(agentikitClone({ sourceRef: "tool:deploy.sh" })).rejects.toThrow("same path");
    // Verify the file was not destroyed
    expect(fs.readFileSync(path.join(stashDir, "tools", "deploy.sh"), "utf8")).toBe("echo deploy\n");
  });

  test("throws when self-cloning a skill without rename", async () => {
    writeFile(path.join(stashDir, "skills", "review", "SKILL.md"), "# Review\n");

    await expect(agentikitClone({ sourceRef: "skill:review" })).rejects.toThrow("same path");
    // Verify the skill was not destroyed
    expect(fs.existsSync(path.join(stashDir, "skills", "review", "SKILL.md"))).toBe(true);
  });
});

describe("agentikitClone --dest", () => {
  let customDest: string;

  beforeEach(() => {
    customDest = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-clone-dest-"));
  });

  afterEach(() => {
    if (customDest) fs.rmSync(customDest, { recursive: true, force: true });
  });

  test("clones tool to custom destination preserving type dir structure", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "#!/bin/bash\necho deploy\n");

    const result = await agentikitClone({ sourceRef: "tool:deploy.sh", dest: customDest });

    expect(result.destination.path).toBe(path.join(customDest, "tools", "deploy.sh"));
    expect(fs.existsSync(path.join(customDest, "tools", "deploy.sh"))).toBe(true);
    expect(fs.readFileSync(path.join(customDest, "tools", "deploy.sh"), "utf8")).toBe("#!/bin/bash\necho deploy\n");
    // Working stash should NOT have the file
    expect(fs.existsSync(path.join(stashDir, "tools", "deploy.sh"))).toBe(false);
  });

  test("clones skill directory to custom destination", async () => {
    writeFile(path.join(searchPathDir, "skills", "review", "SKILL.md"), "# Review Skill\n");
    writeFile(path.join(searchPathDir, "skills", "review", "helper.md"), "# Helper\n");

    const result = await agentikitClone({ sourceRef: "skill:review", dest: customDest });

    expect(fs.existsSync(path.join(customDest, "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(customDest, "skills", "review", "helper.md"))).toBe(true);
    expect(result.overwritten).toBe(false);
  });

  test("--dest does not require a working stash", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "echo deploy\n");
    // Point AKM_STASH_DIR to a non-existent directory to simulate no working stash
    process.env.AKM_STASH_DIR = path.join(os.tmpdir(), `nonexistent-stash-${Date.now()}`);

    const result = await agentikitClone({
      sourceRef: `${searchPathDir}//tool:deploy.sh`,
      dest: customDest,
    });

    expect(fs.existsSync(path.join(customDest, "tools", "deploy.sh"))).toBe(true);
    expect(result.destination.path).toBe(path.join(customDest, "tools", "deploy.sh"));
  });

  test("--dest with --force overwrites at custom destination", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "echo updated\n");
    writeFile(path.join(customDest, "tools", "deploy.sh"), "echo old\n");

    const result = await agentikitClone({
      sourceRef: `${searchPathDir}//tool:deploy.sh`,
      force: true,
      dest: customDest,
    });

    expect(result.overwritten).toBe(true);
    expect(fs.readFileSync(path.join(customDest, "tools", "deploy.sh"), "utf8")).toBe("echo updated\n");
  });

  test("throws when asset exists at --dest without --force", async () => {
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "echo new\n");
    writeFile(path.join(customDest, "tools", "deploy.sh"), "echo existing\n");

    await expect(agentikitClone({ sourceRef: `${searchPathDir}//tool:deploy.sh`, dest: customDest })).rejects.toThrow(
      "already exists at destination",
    );
  });
});

describe("agentikitClone remote", () => {
  let remoteFixtureDir: string;

  beforeEach(() => {
    // Create a fixture directory that simulates a remote package
    remoteFixtureDir = createStashDir("agentikit-clone-remote-fixture-");
    writeFile(path.join(remoteFixtureDir, "tools", "remote-tool.sh"), "#!/bin/bash\necho remote\n");
    writeFile(path.join(remoteFixtureDir, "skills", "remote-skill", "SKILL.md"), "# Remote Skill\n");
  });

  afterEach(() => {
    if (remoteFixtureDir) fs.rmSync(remoteFixtureDir, { recursive: true, force: true });
  });

  test("clones a tool from a remote origin via installRegistryRef", async () => {
    // Use bare path as origin — not in searchPaths, so isRemoteOrigin returns true
    const result = await agentikitClone({
      sourceRef: `${remoteFixtureDir}//tool:remote-tool.sh`,
    });

    expect(result.remoteFetched).toBeDefined();
    expect(result.remoteFetched?.origin).toBe(remoteFixtureDir);
    expect(fs.existsSync(path.join(stashDir, "tools", "remote-tool.sh"))).toBe(true);
    expect(fs.readFileSync(path.join(stashDir, "tools", "remote-tool.sh"), "utf8")).toBe("#!/bin/bash\necho remote\n");
  });

  test("returns remoteFetched metadata", async () => {
    const result = await agentikitClone({
      sourceRef: `${remoteFixtureDir}//tool:remote-tool.sh`,
    });

    expect(result.remoteFetched).toBeDefined();
    expect(result.remoteFetched?.stashRoot).toBeTruthy();
    expect(result.remoteFetched?.cacheDir).toBeTruthy();
  });

  test("throws when remote fetch succeeds but asset not found in package", async () => {
    await expect(agentikitClone({ sourceRef: `${remoteFixtureDir}//tool:nonexistent.sh` })).rejects.toThrow(
      "not found",
    );
  });

  test("clones from remote origin to custom destination", async () => {
    const customDest = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-clone-remote-dest-"));
    try {
      const result = await agentikitClone({
        sourceRef: `${remoteFixtureDir}//tool:remote-tool.sh`,
        dest: customDest,
      });

      expect(result.remoteFetched).toBeDefined();
      expect(fs.existsSync(path.join(customDest, "tools", "remote-tool.sh"))).toBe(true);
      expect(result.destination.path).toBe(path.join(customDest, "tools", "remote-tool.sh"));
    } finally {
      fs.rmSync(customDest, { recursive: true, force: true });
    }
  });
});
