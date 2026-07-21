import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmShowUnified as akmShow } from "../../../src/commands/read/show";
import { saveConfig } from "../../../src/core/config/config";
import { mergeLockEntriesSync } from "../../../src/integrations/lockfile";

// Trigger source-provider self-registration
import "../../../src/sources/providers/index";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

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

let stashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  stashDir = "";
});

// ── Stash .meta/ convention ──────────────────────────────────────────────────

describe("akmShow stash .meta convention", () => {
  test("direct-reads .meta/index.md from the working stash for `meta`", async () => {
    saveConfig({ semanticSearchMode: "off" });
    writeFile(path.join(stashDir, ".meta", "index.md"), "# Stash orientation\nStart at skills/foo.");

    const result = await akmShow({ ref: "meta" });
    expect(result.type).toBe("meta");
    expect(result.name).toBe("index");
    expect(result.content).toContain("Stash orientation");
    expect(result.path).toBe(path.join(stashDir, ".meta", "index.md"));
  });

  test("resolves a named meta doc via `meta:<name>`", async () => {
    saveConfig({ semanticSearchMode: "off" });
    writeFile(path.join(stashDir, ".meta", "about.md"), "# About\nThe stash.");

    const result = await akmShow({ ref: "meta:about" });
    expect(result.type).toBe("meta");
    expect(result.name).toBe("about");
    expect(result.content).toContain("The stash.");
  });

  test("throws a maintainer-actionable error when the doc is absent", async () => {
    saveConfig({ semanticSearchMode: "off" });
    await expect(akmShow({ ref: "meta:missing" })).rejects.toThrow(/\.meta\/missing/);
  });
});

// ── Installed ref with missing asset ─────────────────────────────────────────

describe("akmShow installed ref", () => {
  test("throws with add guidance when origin is not installed", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-root-");
    // Create the type subdirectory so it is a valid stash root, but do NOT
    // create the actual asset file.
    fs.mkdirSync(path.join(installedStashRoot, "scripts"), { recursive: true });

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "test-pkg": { npm: "test-pkg" } },
    });
    mergeLockEntriesSync([
      {
        id: "test-pkg",
        source: "npm",
        ref: "test-pkg",
        localRoot: installedStashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);

    // Use an origin that is NOT installed so resolveSourcesForOrigin returns
    // empty, triggering the add-guidance error path.
    await expect(akmShow({ ref: "npm:@other/missing-pkg//scripts/missing.sh" })).rejects.toThrow(/akm add/);
  });

  test("resolves installed-stash style nested agent refs", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-agent-");
    writeFile(
      path.join(installedStashRoot, "tools", "agents", "svelte-file-editor.md"),
      ["---", "name: svelte-file-editor", "description: Svelte editor", "---", "Use Svelte tools."].join("\n"),
    );

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "ai-tools": { git: "github:sveltejs/ai-tools", registryId: "github:sveltejs/ai-tools" } },
    });
    mergeLockEntriesSync([
      {
        id: "ai-tools",
        source: "github",
        ref: "github:sveltejs/ai-tools",
        localRoot: installedStashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);

    const result = await akmShow({ ref: "ai-tools//agents/tools/agents/svelte-file-editor" });

    expect(result.type).toBe("agent");
    expect(result.origin).toBe("ai-tools");
    expect(result.path).toContain(path.join("tools", "agents", "svelte-file-editor.md"));
    expect(result.prompt).toContain("Use Svelte tools.");
  });

  test("resolves installed-stash style nested skill refs", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-skill-");
    writeFile(
      path.join(installedStashRoot, "tools", "skills", "svelte-code-writer", "SKILL.md"),
      ["---", "name: svelte-code-writer", "description: Svelte writer", "---", "# Svelte writer"].join("\n"),
    );

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "ai-tools": { git: "github:sveltejs/ai-tools", registryId: "github:sveltejs/ai-tools" } },
    });
    mergeLockEntriesSync([
      {
        id: "ai-tools",
        source: "github",
        ref: "github:sveltejs/ai-tools",
        localRoot: installedStashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);

    const result = await akmShow({ ref: "ai-tools//skills/tools/skills/svelte-code-writer" });

    expect(result.type).toBe("skill");
    expect(result.origin).toBe("ai-tools");
    expect(result.path).toContain(path.join("tools", "skills", "svelte-code-writer", "SKILL.md"));
    expect(result.content).toContain("# Svelte writer");
  });
});

// ── Agent toolPolicy provenance ceiling (07 P1-D) ─────────────────────────────

describe("akmShow agent toolPolicy provenance ceiling", () => {
  const AGENT_MD = [
    "---",
    "name: helper",
    "description: A helper agent",
    "tools: [Read, Write, Bash]",
    "---",
    "Do the thing.",
  ].join("\n");

  test("own-stash agent keeps its self-declared toolPolicy", async () => {
    writeFile(path.join(stashDir, "agents", "helper.md"), AGENT_MD);
    const result = await akmShow({ ref: "agents/helper" });
    expect(result.type).toBe("agent");
    // Own stash → no registry origin → the operator's declared policy stands.
    expect(result.origin ?? null).toBeNull();
    expect(result.toolPolicy).toEqual(["Read", "Write", "Bash"]);
  });

  test("registry-installed third-party agent's self-declared tools are dropped", async () => {
    const installedStashRoot = createTmpDir("akm-show-tp-agent-");
    writeFile(path.join(installedStashRoot, "tools", "agents", "helper.md"), AGENT_MD);
    saveConfig({
      semanticSearchMode: "off",
      bundles: { pack: { git: "github:evil/pack", registryId: "github:evil/pack" } },
    });
    mergeLockEntriesSync([
      {
        id: "pack",
        source: "github",
        ref: "github:evil/pack",
        localRoot: installedStashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);
    const result = await akmShow({ ref: "pack//agents/tools/agents/helper" });
    expect(result.type).toBe("agent");
    expect(result.origin).toBe("pack");
    // Provenance ceiling: only the primary stash may self-grant; an installed
    // pack is not the primary stash.
    expect(result.toolPolicy).toBeUndefined();
  });

  test("a --writable installed pack STILL drops toolPolicy (writable ≠ trusted to self-grant)", async () => {
    // Regression: `akm add <ref> --writable` (opt-in to push edits upstream) marks
    // a third-party pack writable. Writability must NOT be read as trust — the
    // ceiling keys off primary-stash identity, not `source.writable`.
    const installedStashRoot = createTmpDir("akm-show-writable-pack-");
    writeFile(path.join(installedStashRoot, "tools", "agents", "helper.md"), AGENT_MD);
    saveConfig({
      semanticSearchMode: "off",
      bundles: { pack: { git: "git:contrib/pack", writable: true, registryId: "git:contrib/pack" } },
    });
    mergeLockEntriesSync([
      {
        id: "pack",
        source: "git",
        ref: "git:contrib/pack",
        localRoot: installedStashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);
    const result = await akmShow({ ref: "pack//agents/tools/agents/helper" });
    expect(result.type).toBe("agent");
    expect(result.toolPolicy).toBeUndefined();
  });

  test("a configured secondary source (nameless git/filesystem) drops toolPolicy", async () => {
    // Regression for the original bypass: a source added WITHOUT a name has no
    // registryId, so a registryId-based ceiling missed it. The primary-stash
    // check catches it — a configured secondary source is not the primary stash.
    const thirdPartyDir = createTmpDir("akm-show-secondary-src-");
    writeFile(path.join(thirdPartyDir, "agents", "helper.md"), AGENT_MD);
    // No `name` — the setup-wizard "add a source and leave the name blank" shape.
    saveConfig({ semanticSearchMode: "off", bundles: { "third-party": { path: thirdPartyDir } } });

    const result = await akmShow({ ref: "agents/helper" });
    expect(result.type).toBe("agent");
    // Reads back as `editable: true` (not under an installed cacheDir) — proving
    // neither `editable` nor `writable` is the trust signal; primary-stash is.
    expect(result.editable).toBe(true);
    expect(result.toolPolicy).toBeUndefined();
  });

  test("a source NESTED inside the primary stash still drops toolPolicy (longest-prefix attribution)", async () => {
    // Regression: `akm add ./vendor` where ./vendor lives under the primary stash.
    // findSourceForPath must attribute the nested asset to the nested (more
    // specific) source, not the enclosing primary — else its self-declared tools
    // would be wrongly honoured.
    const nestedDir = path.join(stashDir, "vendor");
    writeFile(path.join(nestedDir, "agents", "helper.md"), AGENT_MD);
    saveConfig({ semanticSearchMode: "off", bundles: { vendor: { path: nestedDir } } });

    const result = await akmShow({ ref: "agents/vendor/agents/helper" });
    expect(result.type).toBe("agent");
    expect(result.toolPolicy).toBeUndefined();
  });
});

// ── Search path resolution ───────────────────────────────────────────────────

describe("akmShow search path", () => {
  test("resolves from search path directories", async () => {
    const searchPathDir = createTmpDir("akm-show-searchpath-");
    writeFile(path.join(searchPathDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({ semanticSearchMode: "off", bundles: { searchpath: { path: searchPathDir } } });

    const result = await akmShow({ ref: "scripts/deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.name).toBe("deploy.sh");
    expect(result.path).toContain(searchPathDir);
  });
});

// ── editability flags ────────────────────────────────────────────────────────

describe("akmShow editability", () => {
  test("working stash asset has editable true", async () => {
    writeFile(path.join(stashDir, "scripts", "local.sh"), "#!/usr/bin/env bash\necho local\n");

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "scripts/local.sh" });

    expect(result.type).toBe("script");
    expect(result.origin).toBeNull();
    expect(result.action).toContain("Execute the run command");
    expect(result.editable).toBe(true);
    expect(result.editHint).toBeUndefined();
  });

  test("search path asset has editable true", async () => {
    const searchPathDir = createTmpDir("akm-show-searchpath-editable-");
    writeFile(path.join(searchPathDir, "scripts", "remote.sh"), "#!/usr/bin/env bash\necho remote\n");

    saveConfig({ semanticSearchMode: "off", bundles: { searchpath: { path: searchPathDir } } });

    const result = await akmShow({ ref: "scripts/remote.sh" });

    expect(result.type).toBe("script");
    // #37: a configured search-path source is a named bundle, so its assets now
    // carry that bundle key as their origin (was null under the old unnamed
    // filesystem-source shape). Editability is unchanged — a real on-disk path.
    expect(result.origin).toBe("searchpath");
    expect(result.editable).toBe(true);
    expect(result.editHint).toBeUndefined();
  });

  test("installed (cache-managed) asset has editable false with editHint", async () => {
    const installedStashRoot = createTmpDir("akm-show-installed-resolve-");
    writeFile(path.join(installedStashRoot, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "installed-pkg": { npm: "installed-pkg" } },
    });
    mergeLockEntriesSync([
      {
        id: "installed-pkg",
        source: "npm",
        ref: "npm:installed-pkg",
        localRoot: installedStashRoot,
        installedAt: new Date().toISOString(),
      },
    ]);

    const result = await akmShow({ ref: "scripts/deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.origin).toBe("installed-pkg");
    expect(result.editable).toBe(false);
    expect(result.editHint).toContain("akm clone");
    expect(result.editHint).toContain("scripts/deploy.sh");
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

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "commands/deploy.md" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS.");
    expect(result.modelHint).toBe("gpt-4");
    expect(result.parameters).toEqual(["ARGUMENTS"]);
  });

  test("tools frontmatter in commands/ overrides to agent (strong signal)", async () => {
    // tools/toolPolicy are agent-exclusive signals at specificity 20,
    // which beats the commands/ directory matcher at 10. The indexer
    // classifies this as an agent, so the ref uses agent: type.
    writeFile(
      path.join(stashDir, "commands", "hybrid.md"),
      ["---", "tools:", "  read: allow", "model: gpt-4", "---", "You are a hybrid agent."].join("\n"),
    );

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "agents/commands/hybrid" });

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

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "commands/deploy.md" });

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

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "commands/positional.md" });

    expect(result.type).toBe("command");
    expect(result.parameters).toEqual(["$1", "$2", "$9"]);
  });

  test("command parameter extraction includes named placeholders", async () => {
    writeFile(
      path.join(stashDir, "commands", "named.md"),
      ["---", "description: Named args", "---", "Deploy {{env}} with {{version}} using {{env}} again."].join("\n"),
    );

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "commands/named.md" });

    expect(result.type).toBe("command");
    expect(result.parameters).toEqual(["env", "version"]);
  });

  test("script in scripts/ directory uses new renderer pipeline", async () => {
    writeFile(path.join(stashDir, "scripts", "build.sh"), "#!/usr/bin/env bash\necho build\n");

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "scripts/build.sh" });

    expect(result.type).toBe("script");
    expect(result.run).toBeDefined();
    expect(result.run).toContain("bash");
  });

  test("$ARGUMENTS in body classifies .md as command even outside commands/", async () => {
    // $ARGUMENTS placeholder (specificity 18) beats knowledge/ directory hint (10).
    // The indexer classifies this as a command based on content.
    writeFile(
      path.join(stashDir, "knowledge", "deploy-cmd.md"),
      ["---", "description: Deploy helper", "---", "Deploy $ARGUMENTS to staging."].join("\n"),
    );

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "commands/knowledge/deploy-cmd" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Deploy $ARGUMENTS to staging.");
    expect(result.description).toBe("Deploy helper");
  });

  test("agent frontmatter classifies .md as command even outside commands/", async () => {
    // agent frontmatter (specificity 18) beats agents/ directory hint (15).
    // The indexer classifies this as a command based on content.
    writeFile(
      path.join(stashDir, "agents", "build-cmd.md"),
      ["---", "agent: build", "description: Build dispatch", "---", "Build the project."].join("\n"),
    );

    saveConfig({ semanticSearchMode: "off" });

    const result = await akmShow({ ref: "commands/agents/build-cmd" });

    expect(result.type).toBe("command");
    expect(result.template).toBe("Build the project.");
    expect(result.agent).toBe("build");
  });

  test("knowledge view modes work through new renderer pipeline", async () => {
    writeFile(
      path.join(stashDir, "knowledge", "guide.md"),
      ["# Intro", "Welcome.", "", "## Setup", "Install things.", "", "## Usage", "Use things."].join("\n"),
    );

    saveConfig({ semanticSearchMode: "off" });

    const tocResult = await akmShow({ ref: "knowledge/guide.md", view: { mode: "toc" } });
    expect(tocResult.content).toContain("Intro");
    expect(tocResult.content).toContain("Setup");

    const sectionResult = await akmShow({
      ref: "knowledge/guide.md",
      view: { mode: "section", heading: "Setup" },
    });
    expect(sectionResult.content).toContain("Install things.");
  });
});
