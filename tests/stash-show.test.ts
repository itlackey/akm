import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { akmShowUnified as akmShow } from "../src/stash-show";

// Trigger stash-provider self-registration (needed for openviking provider)
import "../src/stash-providers/index";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-show-"): string {
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
  testCacheDir = createTmpDir("akm-show-cache-");
  testConfigDir = createTmpDir("akm-show-config-");
  stashDir = createTmpDir("akm-show-stash-");
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
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

describe("akmShow installed ref", () => {
  test("throws with add guidance when origin is not installed", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-root-");
    // Create the type subdirectory so it is a valid stash root, but do NOT
    // create the actual asset file.
    fs.mkdirSync(path.join(installedStashRoot, "scripts"), { recursive: true });

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
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
    });

    // Use an origin that is NOT installed so resolveSourcesForOrigin returns
    // empty, triggering the add-guidance error path.
    await expect(akmShow({ ref: "npm:@other/missing-pkg//script:missing.sh" })).rejects.toThrow(/akm add/);
  });

  test("resolves installed-kit style nested agent refs", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-agent-");
    writeFile(
      path.join(installedStashRoot, "tools", "agents", "svelte-file-editor.md"),
      ["---", "name: svelte-file-editor", "description: Svelte editor", "---", "Use Svelte tools."].join("\n"),
    );

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      installed: [
        {
          id: "github:sveltejs/ai-tools",
          source: "github",
          ref: "github:sveltejs/ai-tools",
          artifactUrl: "https://example.com/svelte-tools.tgz",
          stashRoot: installedStashRoot,
          cacheDir: installedStashRoot,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await akmShow({ ref: "github:sveltejs/ai-tools//agent:tools/agents/svelte-file-editor" });

    expect(result.type).toBe("agent");
    expect(result.origin).toBe("github:sveltejs/ai-tools");
    expect(result.path).toContain(path.join("tools", "agents", "svelte-file-editor.md"));
    expect(result.prompt).toContain("Use Svelte tools.");
  });

  test("resolves installed-kit style nested skill refs", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-skill-");
    writeFile(
      path.join(installedStashRoot, "tools", "skills", "svelte-code-writer", "SKILL.md"),
      ["---", "name: svelte-code-writer", "description: Svelte writer", "---", "# Svelte writer"].join("\n"),
    );

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      installed: [
        {
          id: "github:sveltejs/ai-tools",
          source: "github",
          ref: "github:sveltejs/ai-tools",
          artifactUrl: "https://example.com/svelte-tools.tgz",
          stashRoot: installedStashRoot,
          cacheDir: installedStashRoot,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await akmShow({ ref: "github:sveltejs/ai-tools//skill:tools/skills/svelte-code-writer" });

    expect(result.type).toBe("skill");
    expect(result.origin).toBe("github:sveltejs/ai-tools");
    expect(result.path).toContain(path.join("tools", "skills", "svelte-code-writer", "SKILL.md"));
    expect(result.content).toContain("# Svelte writer");
  });
});

// ── Search path resolution ───────────────────────────────────────────────────

describe("akmShow search path", () => {
  test("resolves from search path directories", async () => {
    const searchPathDir = createTmpDir("akm-show-searchpath-");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({ semanticSearch: false, searchPaths: [searchPathDir] });

    const result = await akmShow({ ref: "script:deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.name).toBe("deploy.sh");
    expect(result.path).toContain(searchPathDir);
  });
});

// ── editability flags ────────────────────────────────────────────────────────

describe("akmShow editability", () => {
  test("working stash asset has editable true", async () => {
    writeFile(path.join(stashDir, "scripts", "local.sh"), "#!/usr/bin/env bash\necho local\n");

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await akmShow({ ref: "script:local.sh" });

    expect(result.type).toBe("script");
    expect(result.origin).toBeNull();
    expect(result.action).toContain("Execute the run command");
    expect(result.editable).toBe(true);
    expect(result.editHint).toBeUndefined();
  });

  test("search path asset has editable true", async () => {
    const searchPathDir = createTmpDir("akm-show-searchpath-editable-");
    writeFile(path.join(searchPathDir, "scripts", "remote.sh"), "#!/usr/bin/env bash\necho remote\n");

    saveConfig({ semanticSearch: false, searchPaths: [searchPathDir] });

    const result = await akmShow({ ref: "script:remote.sh" });

    expect(result.type).toBe("script");
    expect(result.origin).toBeNull();
    expect(result.editable).toBe(true);
    expect(result.editHint).toBeUndefined();
  });

  test("installed (cache-managed) asset has editable false with editHint", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-resolve-");
    writeFile(path.join(installedStashRoot, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
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
    });

    const result = await akmShow({ ref: "script:deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.origin).toBe("installed-pkg");
    expect(result.editable).toBe(false);
    expect(result.editHint).toContain("akm clone");
    expect(result.editHint).toContain("script:deploy.sh");
  });
});

// ── Content-based classification via new renderer pipeline ─────────────────

describe("akmShow content-based classification", () => {
  test("model alone in commands/ stays a command (directory wins over weak agent signal)", async () => {
    // model is shared frontmatter (OpenCode convention). In commands/,
    // the directory matcher (specificity 10) beats the model-only agent
    // signal (specificity 8), so this stays a command.
    writeFile(
      path.join(stashDir, "commands", "deploy.md"),
      ["---", "model: gpt-4", "description: Deploy command", "---", "Deploy $ARGUMENTS."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await akmShow({ ref: "command:deploy.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS.");
    expect(result.modelHint).toBe("gpt-4");
    expect(result.parameters).toEqual(["ARGUMENTS"]);
  });

  test("tools frontmatter in commands/ overrides to agent (strong signal)", async () => {
    // tools/toolPolicy are agent-exclusive signals at specificity 20,
    // which beats the commands/ directory matcher at 10.
    writeFile(
      path.join(stashDir, "commands", "hybrid.md"),
      ["---", "tools:", "  read: allow", "model: gpt-4", "---", "You are a hybrid agent."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await akmShow({ ref: "command:hybrid.md" });

    expect(result.type).toBe("agent");
    expect(result.action).toContain("verbatim");
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

    const result = await akmShow({ ref: "command:deploy.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS to production.");
    expect(result.description).toBe("Deploy to production");
    expect(result.modelHint).toBe("claude-sonnet-4-20250514");
    expect(result.agent).toBe("build");
    expect(result.parameters).toEqual(["ARGUMENTS"]);
  });

  test("command parameter extraction includes positional placeholders", async () => {
    writeFile(
      path.join(stashDir, "commands", "positional.md"),
      ["---", "description: Positional args", "---", "Run release $1 with notes from $2 and flag $9."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await akmShow({ ref: "command:positional.md" });

    expect(result.type).toBe("command");
    expect(result.parameters).toEqual(["$1", "$2", "$9"]);
  });

  test("command parameter extraction includes named placeholders", async () => {
    writeFile(
      path.join(stashDir, "commands", "named.md"),
      ["---", "description: Named args", "---", "Deploy {{env}} with {{version}} using {{env}} again."].join("\n"),
    );

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await akmShow({ ref: "command:named.md" });

    expect(result.type).toBe("command");
    expect(result.parameters).toEqual(["env", "version"]);
  });

  test("script in scripts/ directory uses new renderer pipeline", async () => {
    writeFile(path.join(stashDir, "scripts", "build.sh"), "#!/usr/bin/env bash\necho build\n");

    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await akmShow({ ref: "script:build.sh" });

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
    const result = await akmShow({ ref: "knowledge:deploy-cmd.md" });

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
    const result = await akmShow({ ref: "agent:build-cmd.md" });

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

    const tocResult = await akmShow({ ref: "knowledge:guide.md", view: { mode: "toc" } });
    expect(tocResult.content).toContain("Intro");
    expect(tocResult.content).toContain("Setup");

    const sectionResult = await akmShow({
      ref: "knowledge:guide.md",
      view: { mode: "section", heading: "Setup" },
    });
    expect(sectionResult.content).toContain("Install things.");
  });
});

// ── Remote show via OpenViking provider ──────────────────────────────────────

describe("akmShow remote (viking://)", () => {
  const remoteServers: Array<{ stop: (force: boolean) => void }> = [];

  afterEach(() => {
    for (const s of remoteServers) {
      try {
        s.stop(true);
      } catch {
        /* already stopped */
      }
    }
    remoteServers.length = 0;
  });

  test("routes viking:// ref to openviking provider and returns correct structure", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(
            JSON.stringify({
              status: "ok",
              result: { name: "test-skill", type: "skills", abstract: "A remote skill" },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: "# Remote Skill\n\nDo the thing." }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    remoteServers.push(server);

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      stashes: [
        {
          type: "openviking",
          url: `http://localhost:${server.port}`,
          name: "test-ov",
        },
      ],
    });

    const result = await akmShow({ ref: "viking://skills/test-skill" });

    expect(result.type).toBe("skill");
    expect(result.name).toBe("test-skill");
    expect(result.content).toBe("# Remote Skill\n\nDo the thing.");
    expect(result.description).toBe("A remote skill");
    expect(result.editable).toBe(false);
    expect(result.path).toBe("viking://skills/test-skill");
  });
});
