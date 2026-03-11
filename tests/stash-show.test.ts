import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { agentikitShow } from "../src/stash-show";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "agentikit-show-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let stashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("agentikit-show-cache-");
  testConfigDir = createTmpDir("agentikit-show-config-");
  stashDir = createTmpDir("agentikit-show-stash-");
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── Installed ref with missing asset ─────────────────────────────────────────

describe("agentikitShow installed ref", () => {
  test("throws with installCmd when registryId present and asset not found", async () => {
    const installedStashRoot = createTmpDir("agentikit-show-installed-root-");
    // Create the type subdirectory so it is a valid stash root, but do NOT
    // create the actual asset file.
    fs.mkdirSync(path.join(installedStashRoot, "tools"), { recursive: true });

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      registry: {
        installed: [
          {
            id: "test-pkg",
            source: "npm",
            ref: "test-pkg",
            artifactUrl: "https://example.com/test-pkg.tgz",
            stashRoot: installedStashRoot,
            cacheDir: installedStashRoot,
            installedAt: new Date().toISOString(),
          },
        ],
      },
    });

    // Use an origin that is NOT installed so resolveSourcesForOrigin returns
    // empty, triggering the installCmd error path.
    await expect(agentikitShow({ ref: "npm:@other/missing-pkg//tool:missing.sh" })).rejects.toThrow(/akm add/);
  });
});

// ── Search path resolution ───────────────────────────────────────────────────

describe("agentikitShow search path", () => {
  test("resolves from search path directories", async () => {
    const searchPathDir = createTmpDir("agentikit-show-searchpath-");
    writeFile(path.join(searchPathDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({ semanticSearch: false, searchPaths: [searchPathDir] });

    const result = await agentikitShow({ ref: "tool:deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.name).toBe("deploy.sh");
    expect(result.path).toContain(searchPathDir);
  });
});

// ── editability flags ────────────────────────────────────────────────────────

describe("agentikitShow editability", () => {
  test("working stash asset has editable true", async () => {
    writeFile(path.join(stashDir, "tools", "local.sh"), "#!/usr/bin/env bash\necho local\n");

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitShow({ ref: "tool:local.sh" });

    expect(result.type).toBe("script");
    expect(result.editable).toBe(true);
    expect(result.editHint).toBeUndefined();
  });

  test("search path asset has editable true", async () => {
    const searchPathDir = createTmpDir("agentikit-show-searchpath-editable-");
    writeFile(path.join(searchPathDir, "tools", "remote.sh"), "#!/usr/bin/env bash\necho remote\n");

    saveConfig({ semanticSearch: false, searchPaths: [searchPathDir] });

    const result = await agentikitShow({ ref: "tool:remote.sh" });

    expect(result.type).toBe("script");
    expect(result.editable).toBe(true);
    expect(result.editHint).toBeUndefined();
  });

  test("installed (cache-managed) asset has editable false with editHint", async () => {
    const installedStashRoot = createTmpDir("agentikit-show-installed-resolve-");
    writeFile(path.join(installedStashRoot, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      registry: {
        installed: [
          {
            id: "installed-pkg",
            source: "npm",
            ref: "npm:installed-pkg",
            artifactUrl: "https://example.com/installed-pkg.tgz",
            stashRoot: installedStashRoot,
            cacheDir: installedStashRoot,
            installedAt: new Date().toISOString(),
          },
        ],
      },
    });

    const result = await agentikitShow({ ref: "tool:deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.editable).toBe(false);
    expect(result.editHint).toContain("akm clone");
    expect(result.editHint).toContain("script:deploy.sh");
  });
});

// ── Content-based classification via new renderer pipeline ─────────────────

describe("agentikitShow content-based classification", () => {
  test("model alone in commands/ stays a command (directory wins over weak agent signal)", async () => {
    // model is shared frontmatter (OpenCode convention). In commands/,
    // the directory matcher (specificity 10) beats the model-only agent
    // signal (specificity 8), so this stays a command.
    writeFile(
      path.join(stashDir, "commands", "deploy.md"),
      ["---", "model: gpt-4", "description: Deploy command", "---", "Deploy $ARGUMENTS."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitShow({ ref: "command:deploy.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS.");
    expect(result.modelHint).toBe("gpt-4");
  });

  test("tools frontmatter in commands/ overrides to agent (strong signal)", async () => {
    // tools/toolPolicy are agent-exclusive signals at specificity 20,
    // which beats the commands/ directory matcher at 10.
    writeFile(
      path.join(stashDir, "commands", "hybrid.md"),
      ["---", "tools:", "  read: allow", "model: gpt-4", "---", "You are a hybrid agent."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitShow({ ref: "command:hybrid.md" });

    expect(result.type).toBe("agent");
    expect(result.prompt).toContain("You are a hybrid agent.");
  });

  test("command in commands/ directory extracts OpenCode-style frontmatter", async () => {
    writeFile(
      path.join(stashDir, "commands", "deploy.md"),
      [
        "---",
        "description: Deploy to production",
        "model: claude-sonnet-4-20250514",
        "agent: build",
        "---",
        "Deploy $ARGUMENTS to production.",
      ].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitShow({ ref: "command:deploy.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS to production.");
    expect(result.description).toBe("Deploy to production");
    expect(result.modelHint).toBe("claude-sonnet-4-20250514");
    expect(result.agent).toBe("build");
  });

  test("script in tools/ directory uses new renderer pipeline", async () => {
    writeFile(path.join(stashDir, "tools", "build.sh"), "#!/usr/bin/env bash\necho build\n");

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitShow({ ref: "tool:build.sh" });

    expect(result.type).toBe("script");
    expect(result.run).toBeDefined();
    expect(result.run).toContain("bash");
  });

  test("$ARGUMENTS in body classifies .md as command even outside commands/", async () => {
    writeFile(
      path.join(stashDir, "knowledge", "deploy-cmd.md"),
      ["---", "description: Deploy helper", "---", "Deploy $ARGUMENTS to staging."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    // $ARGUMENTS placeholder (specificity 18) beats knowledge/ directory hint (10)
    const result = await agentikitShow({ ref: "knowledge:deploy-cmd.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS to staging.");
    expect(result.description).toBe("Deploy helper");
  });

  test("agent frontmatter classifies .md as command even outside commands/", async () => {
    writeFile(
      path.join(stashDir, "agents", "build-cmd.md"),
      ["---", "agent: build", "description: Build dispatch", "---", "Build the project."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    // agent frontmatter (specificity 18) beats agents/ directory hint (15)
    const result = await agentikitShow({ ref: "agent:build-cmd.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Build the project.");
    expect(result.agent).toBe("build");
  });

  test("knowledge view modes work through new renderer pipeline", async () => {
    writeFile(
      path.join(stashDir, "knowledge", "guide.md"),
      ["# Intro", "Welcome.", "", "## Setup", "Install things.", "", "## Usage", "Use things."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const tocResult = await agentikitShow({ ref: "knowledge:guide.md", view: { mode: "toc" } });
    expect(tocResult.content).toContain("Intro");
    expect(tocResult.content).toContain("Setup");

    const sectionResult = await agentikitShow({
      ref: "knowledge:guide.md",
      view: { mode: "section", heading: "Setup" },
    });
    expect(sectionResult.content).toContain("Install things.");
  });
});
